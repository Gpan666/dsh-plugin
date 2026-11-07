/**
 * apply() 冒烟测试：用假的 ctx 宿主加载插件，验证事件接线、服务暴露、pre-step 换模型逻辑。
 *
 * 这是本插件最重要的测试——它验证「pre-step 里 agent.model.select() 被调用」这个
 * 真正干活的部分。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../src/index.js'

/**
 * 造一个最小的 DSH ctx 宿主。
 * @param {object} [opts]
 */
function makeCtx({ llm = null, logger = null } = {}) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  const services = new Map()
  const effects = []
  const logs = []
  const timers = []

  const record = (level) => (/** @type {any[]} */ ...args) => logs.push([level, args.join(' ')])

  const ctx = {
    logger: logger ?? {
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      debug: record('debug'),
    },
    get: (name) => (name === 'llm' ? llm : services.get(name)),
    set: (name, value) => { services.set(name, value); return () => services.delete(name) },
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {
        const arr = listeners.get(event) ?? []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    effect: (fn) => { effects.push(fn) },
    // 避免测试里真的挂定时器影响进程
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); timers.push(t); return t },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); timers.push(t); return t },
  }

  return {
    ctx,
    listeners,
    services,
    logs,
    /** 触发一个 waterfall：依次调用监听器，第一个返回值非 undefined 的胜出 */
    fireWaterfall(event, payload) {
      const fns = listeners.get(event) ?? []
      let index = 0
      const next = () => {
        const fn = fns[index++]
        if (!fn) return undefined
        return fn(payload, next)
      }
      return next()
    },
    /** 触发全部（emit 语义） */
    fireAll(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn(payload, () => undefined)
    },
    cleanup() {
      for (const t of timers) { clearTimeout(t); clearInterval(t) }
      for (const fn of effects) { try { const d = fn(); d?.() } catch { /* ignore */ } }
    },
  }
}

const CAND = { provider: 'pb', model: 'mb' }

test('apply 能加载并注册两个事件', async () => {
  const host = makeCtx()
  const svc = await apply(host.ctx, { candidates: 'pa/ma\npb/mb' })

  assert.ok(host.listeners.has('agent/request-error'), '应监听 request-error')
  assert.ok(host.listeners.has('agent/pre-step'), '应监听 pre-step')
  assert.ok(host.services.has('modelFailover'), '应暴露 modelFailover 服务')

  const errs = host.logs.filter((l) => l[0] === 'error')
  assert.equal(errs.length, 0, `不应有 error 日志，实际：${JSON.stringify(errs)}`)

  host.cleanup()
  return svc
})

test('pre-step：当前模型健康时不动', async () => {
  const host = makeCtx()
  await apply(host.ctx, { candidates: 'pa/ma\npb/mb' })

  const agent = { model: { select: () => { throw new Error('不该调用 select') } } }
  const result = host.fireWaterfall('agent/pre-step', {
    agent,
    modelSelection: { provider: 'pa', model: 'ma' },
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  })

  assert.equal(result, undefined, 'next() 应返回 undefined')
  host.cleanup()
})

test('pre-step：当前模型处于冷却时切到下一个', async () => {
  const host = makeCtx()
  const svc = await apply(host.ctx, { candidates: 'pa/ma\npb/mb', failureThreshold: 1, cooldownSec: 60 })

  // 同一个 agent 实例：真实 DSH 里 agent 是长期存在的对象，状态挂在它上面
  const agent = { model: { select: () => {} } }

  // 让 pre-step 先记住当前模型（这样失败记账才能对齐到 pa/ma）
  host.fireWaterfall('agent/pre-step', {
    agent,
    modelSelection: { provider: 'pa', model: 'ma' },
    turn: 1, step: 1, signal: new AbortController().signal,
  })

  // 让 pa/ma 失败 → 进入冷却
  host.fireAll('agent/request-error', {
    agent,
    provider: 'pa',
    failure: { code: 'RATE_LIMIT', message: '限流' },
  })

  /** @type {any[]} */
  const selected = []
  agent.model.select = (s) => selected.push(s)

  host.fireWaterfall('agent/pre-step', {
    agent,
    modelSelection: { provider: 'pa', model: 'ma' },
    turn: 2, step: 1, signal: new AbortController().signal,
  })

  assert.deepEqual(selected[0], { provider: 'pb', model: 'mb' }, '应切到第二个候选')

  const status = svc.status()
  assert.equal(status.lastSwitch.to.provider, 'pb')
  host.cleanup()
})

test('request-error：不抢 retry，返回 next() 的结果', async () => {
  const host = makeCtx()
  await apply(host.ctx, { candidates: 'pa/ma', claimRetry: false })

  let calledNext = false
  let downstream = 'sentinel'
  const fns = host.listeners.get('agent/request-error') ?? []
  const ret = fns[0](
    { agent: { model: {} }, provider: 'pa', failure: { code: 'SERVER', message: 'boom' } },
    () => { calledNext = true; return downstream },
  )

  assert.equal(calledNext, true, '应调用 next 交给下游')
  assert.equal(ret, downstream, '应原样返回下游结果')
  host.cleanup()
})

test('request-error：claimRetry=true 时接管重试', async () => {
  const host = makeCtx()
  await apply(host.ctx, { candidates: 'pa/ma', claimRetry: true })

  let calledNext = false
  const fns = host.listeners.get('agent/request-error') ?? []
  const ret = fns[0](
    { agent: { model: {} }, provider: 'pa', failure: { code: 'SERVER' } },
    () => { calledNext = true },
  )

  assert.equal(calledNext, false, '接管时不应调 next')
  assert.deepEqual(ret, { kind: 'retry' })
  host.cleanup()
})

test('enabled=false 时完全不干预', async () => {
  const host = makeCtx()
  await apply(host.ctx, { enabled: false, candidates: 'pa/ma' })

  let selected = false
  const agent = { model: { select: () => { selected = true } } }
  host.fireWaterfall('agent/pre-step', {
    agent,
    modelSelection: { provider: 'px', model: 'mx' },
    turn: 1, step: 1, signal: new AbortController().signal,
  })
  assert.equal(selected, false, '关闭时不该换模型')
  host.cleanup()
})

test('候选为空时不干预', async () => {
  const host = makeCtx()
  await apply(host.ctx, { candidates: '' })

  let selected = false
  const agent = { model: { select: () => { selected = true } } }
  host.fireWaterfall('agent/pre-step', {
    agent, modelSelection: { provider: 'px', model: 'mx' },
    turn: 1, step: 1, signal: new AbortController().signal,
  })
  assert.equal(selected, false)
  host.cleanup()
})

test('modelSelection 缺失时不崩', async () => {
  const host = makeCtx()
  await apply(host.ctx, { candidates: 'pa/ma' })

  assert.doesNotThrow(() => {
    host.fireWaterfall('agent/pre-step', {
      agent: { model: { select: () => {} } },
      modelSelection: undefined,
      turn: 1, step: 1, signal: new AbortController().signal,
    })
  })
  host.cleanup()
})

test('agent.model.select 抛错时不让插件崩', async () => {
  const host = makeCtx()
  await apply(host.ctx, { candidates: 'pa/ma\npb/mb', failureThreshold: 1 })

  host.fireAll('agent/request-error', {
    agent: { model: {} },
    provider: 'pa',
    failure: { code: 'AUTH', message: 'bad' },
  })

  const agent = { model: { select: () => { throw new Error('select boom') } } }
  assert.doesNotThrow(() => {
    host.fireWaterfall('agent/pre-step', {
      agent, modelSelection: { provider: 'pa', model: 'ma' },
      turn: 2, step: 1, signal: new AbortController().signal,
    })
  })
  host.cleanup()
})

test('AUTH 失败进入永久冷却，不再被选中', async () => {
  const host = makeCtx()
  const svc = await apply(host.ctx, { candidates: 'pa/ma\npb/mb', maxCooldownSec: 600 })

  const agent = { model: { select: () => {} } }

  // 先让 pre-step 记住当前模型，失败记账才能对齐
  host.fireWaterfall('agent/pre-step', {
    agent,
    modelSelection: { provider: 'pa', model: 'ma' },
    turn: 1, step: 1, signal: new AbortController().signal,
  })

  host.fireAll('agent/request-error', {
    agent,
    provider: 'pa',
    failure: { code: 'AUTH', message: 'invalid key' },
  })

  const status = svc.status()
  const pa = status.candidates.find((c) => c.provider === 'pa')
  assert.equal(pa.coolingDown, true, 'AUTH 后应立即冷却')
  host.cleanup()
})

test('status() 结构完整', async () => {
  const host = makeCtx()
  const svc = await apply(host.ctx, { candidates: 'pa/ma\npb/mb' })
  const st = svc.status()
  assert.equal(st.enabled, true)
  assert.equal(st.candidates.length, 2)
  assert.ok(st.candidates[0].label.includes('pa/ma'))
  host.cleanup()
})

test('updateSettings 运行中生效', async () => {
  const host = makeCtx()
  const svc = await apply(host.ctx, { candidates: 'pa/ma' })
  const next = svc.updateSettings({ candidates: 'pb/mb\npc/mc' })
  assert.equal(next.candidates.includes('pb'), true)
  host.cleanup()
})

test('cleanup 后定时器被清掉', async () => {
  const host = makeCtx()
  await apply(host.ctx, { candidates: 'pa/ma', probeIntervalSec: 10 })
  host.cleanup()
  assert.ok(true)
})
