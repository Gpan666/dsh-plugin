/**
 * model-failover —— 模型故障转移（DSH 插件）。
 *
 * ============================ 能力边界（务必先读） ============================
 *
 * 我读了 DSH 的实际源码，确认了下面这些硬约束。这决定本插件能做到什么、
 * 做不到什么。**请勿把它当成「同轮失败后继续回复」的实现**——那条路在 DSH
 * 当前架构下不成立，原因如下。
 *
 * 1. `dsh-agent-loop/lib/index.js` 的 `step()`：
 *
 *        while (true) {
 *          const { config } = await this.prepareRequest(turn, step, decision.selection, signal)
 *          ...
 *          if (finish.kind === 'error') {
 *            const action = await dispatch.waterfall('agent/request-error', {...})
 *            if (action?.kind !== 'retry') throw new LlmError(...)
 *            continue
 *          }
 *        }
 *
 *    `decision.selection` 在整个 `step()` 内**固定不变**，`step` 编号也不变。
 *    `continue` 回到 `prepareRequest`，仍传入同一个 `decision.selection`。
 *    **所以 retry 只能重发同一个模型。**
 *
 * 2. `prepareRequest()` 有硬校验：
 *
 *        if (proposedConfig.provider !== selection.provider || ...)
 *          throw new Error('... use agent.model.select() before step preparation')
 *
 *    即 `agent/request` 里改 provider/model 会直接抛错。
 *
 * 3. `step()` 抛错后，主循环 `catch` 立刻 `turnEnds = {kind:'error'}` 并
 *    `throwError`，**本轮结束**。没有「本步失败但继续下一步」的路径。
 *
 * 4. `agent.model.select()` 只是 `session.append('model/selection')`，而
 *    `preStep()` 开头 `const selection = this.model.current()` 读的就是它。
 *    所以 **select() 只对「下一次 preStep」生效**，对已在 `step()` 内的重试无效。
 *
 * 5. loop 走的是 `preparedCall?.stream(request) ?? llm.stream(request)`。
 *    正常情况 `prepareCall` 成功 → 走 `preparedCall.stream()` → **完全绕过 `llm/stream`
 *    waterfall**。所以在 agent 路径里拦 `llm/stream` 也改不了模型。
 *
 * ============================ 因此本插件做什么 ============================
 *
 * 能做到的（都基于 `agent/pre-step`，这是唯一合法换模型入口）：
 *
 *   A. **跨轮/跨步故障转移**：每次 `pre-step` 前，若记住的「当前模型」处于冷却，
 *      就 `agent.model.select()` 换到下一个健康候选。用户下一条消息自动用新模型。
 *   B. **失败即时降级**：监听 `agent/request-error` 记账（哪个模型失败了、错误码），
 *      让它**不再被选中**。下一条消息立刻避开它。
 *   C. **先用 `dsh-llm-retry` 的同轮重试**：本插件**不抢** retry，先 `next()` 交给
 *      下游。若装了 `dsh-llm-retry`，它会用同一模型做有限次重试（比如限流后恢复就成功）。
 *      那个能救回来的场景由它救；救不回来才由本插件在下一轮换模型。
 *   D. **后台探活**：定期打 1 token 请求，提前发现掉线的模型，减少白跑一次失败。
 *   E. **配置类错误直达永久冷却**：AUTH / NO_ADAPTER / MISSING_CREDENTIAL 重试没意义。
 *
 * 做不到的（不承诺、也不假装能做到）：
 *
 *   X. **同一轮内失败后换模型继续回复**。理由见上面 1~4。
 *      若要实现，必须改写 agent loop 本身（让 `step()` 在 request-error 后能
 *      重新进入 `preStep`），那属于 fork DSH，不是插件。
 *
 * 如果你只想要「这条回复别丢」，务实的答案是：**装 `@deepseek-ai/dsh-llm-retry`**，
 * 它会用同一模型重试（限流、5xx、超时这类通常能救回来）。本插件负责「这个模型
 * 整体挂了就换掉」，两者互补：retry 管抖动，failover 管真挂。
 */

import {
  DEFAULT_SETTINGS,
  keyOf,
  labelOf,
  normalizeSettings,
  parseCandidates,
} from './candidates.js'
import { createHealthTable, PERMANENT_FAILURE_CODES } from './health.js'
import { probeOnce } from './probe.js'

export const name = 'model-failover'
export const inject = ['agents']

/**
 * 配置模式。
 *
 * `@deepseek-ai/schemastery` 是 DSH 运行时提供的 peer 依赖，真实环境一定有。
 * 但为了让纯逻辑测试能在没有该包的目录里直接跑，这里用同步 require 并降级：
 * 拿不到就退化成纯对象描述（对配置校验要求不强的场景够用）。
 *
 * 注意：不要改成顶层 `import`，那会让测试环境直接 ERR_MODULE_NOT_FOUND。
 */
let Config
try {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const z = require('@deepseek-ai/schemastery')
  Config = z.object({
    enabled: z.boolean().default(DEFAULT_SETTINGS.enabled),
    candidates: z.string().default(DEFAULT_SETTINGS.candidates),
    failureThreshold: z.number().default(DEFAULT_SETTINGS.failureThreshold),
    cooldownSec: z.number().default(DEFAULT_SETTINGS.cooldownSec),
    maxCooldownSec: z.number().default(DEFAULT_SETTINGS.maxCooldownSec),
    sticky: z.boolean().default(DEFAULT_SETTINGS.sticky),
    probeTimeoutSec: z.number().default(DEFAULT_SETTINGS.probeTimeoutSec),
    probeIntervalSec: z.number().default(120),
    claimRetry: z.boolean().default(false),
    restoreOnStart: z.boolean().default(true),
  })
} catch {
  // 测试环境没有 schemastery：给一个形状相同、不校验的降级对象。
  Config = {
    ...DEFAULT_SETTINGS,
    probeIntervalSec: 120,
    claimRetry: false,
    restoreOnStart: true,
  }
}
export { Config }

/**
 * @typedef {object} AgentState
 * @property {{provider:string, model:string} | null} effective
 * @property {any | null} lastFailure
 */

/** @type {WeakMap<object, AgentState>} */
const states = new WeakMap()

/** @param {object} agent @returns {AgentState} */
function stateOf(agent) {
  if (!agent || typeof agent !== 'object') return { effective: null, lastFailure: null }
  let s = states.get(agent)
  if (!s) {
    s = { effective: null, lastFailure: null }
    states.set(agent, s)
  }
  return s
}

/**
 * @param {any} ctx
 * @param {any} [config]
 */
export async function apply(ctx, config = {}) {
  let live = normalizeSettings({ ...DEFAULT_SETTINGS, ...config })
  const readSettings = () => live

  const health = createHealthTable({ readSettings })
  const log = ctx.logger ?? console

  /** @type {any} */
  let lastSwitch = null

  const candidatesNow = () => parseCandidates(readSettings().candidates)

  /* ------------------------------------------------------------------ */
  /* 探活                                                                */
  /* ------------------------------------------------------------------ */

  const llm = ctx.get?.('llm')

  /** @param {{provider:string, model:string}} cand */
  const probeOne = async (cand) => {
    if (!llm?.stream) return
    const res = await probeOnce({
      llm,
      cand,
      timeoutMs: readSettings().probeTimeoutSec * 1000,
      prompt: 'ping',
    })
    const key = keyOf(cand)
    if (res.ok) {
      health.recordSuccess(key, res.latencyMs)
    } else if (PERMANENT_FAILURE_CODES.has(res.code)) {
      health.recordPermanentFailure(key, `${res.code}: ${res.message}`)
      log.warn?.(`model-failover: ${key} 探测到配置类错误 ${res.code}，已永久冷却`)
    } else {
      health.recordFailure(key, `${res.code}: ${res.message}`)
    }
  }

  const probeAll = async () => {
    if (!readSettings().enabled) return { ok: false, reason: 'disabled' }
    for (const cand of candidatesNow()) await probeOne(cand)
    return { ok: true }
  }

  /* ------------------------------------------------------------------ */
  /* 1) 失败记账                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 只记账，**不抢 retry**（除非明确配置 claimRetry）。
   *
   * 不抢的理由：`dsh-llm-retry` 会用同一模型重试有限次，限流/5xx 这类抖动它救得回来；
   * 我们抢过来返回 `{kind:'retry'}` 只会让同一个坏模型再被打一次，没有收益。
   *
   * `claimRetry=true` 时才接管：适合没装 dsh-llm-retry、又希望失败后立刻重发一次的场合。
   * 注意此时仍是**同一模型**重发（见文件头第 1 条），只是把次数控制在我们手里。
   */
  ctx.on('agent/request-error', (payload, next) => {
    const s = readSettings()
    if (!s.enabled) return next()

    const { agent, provider, failure } = payload
    const state = stateOf(agent)
    const code = String(failure?.code ?? 'UNKNOWN')
    const message = String(failure?.message ?? '')

    state.lastFailure = { code, message, provider, at: Date.now() }

    const eff = state.effective
    if (eff && typeof provider === 'string' && eff.provider === provider) {
      const key = keyOf(eff)
      if (PERMANENT_FAILURE_CODES.has(code)) {
        health.recordPermanentFailure(key, `${code}: ${message}`)
      } else {
        health.recordFailure(key, `${code}: ${message}`)
      }
      log.warn?.(`model-failover: ${key} 请求失败 ${code}`)
    } else if (typeof provider === 'string' && provider) {
      log.debug?.(`model-failover: provider ${provider} 失败 ${code}（未知模型，未记账）`)
    }

    if (s.claimRetry) {
      return { kind: 'retry' }
    }
    return next()
  })

  /* ------------------------------------------------------------------ */
  /* 2) 换模型（唯一合法入口）                                             */
  /* ------------------------------------------------------------------ */

  ctx.on('agent/pre-step', (payload, next) => {
    const s = readSettings()
    if (!s.enabled) return next()

    const { agent, modelSelection } = payload
    const state = stateOf(agent)
    const cands = candidatesNow()
    if (cands.length === 0) return next()

    const current = modelSelection
      ? { provider: modelSelection.provider, model: modelSelection.model }
      : null

    // 记住当前模型，失败记账要用它对齐
    if (current) state.effective = current

    // 当前模型还健康 → 不动（粘滞，避免每步抖动 + 保 KV 缓存）
    if (current && health.isUsable(keyOf(current))) {
      return next()
    }

    // 当前模型在冷却 或 未知 → 换
    const failedKey = current ? keyOf(current) : null
    const next_ = health.order(cands, s.sticky ? state.effective : null, failedKey)

    if (!next_) return next()

    const willChange = !current
      || current.provider !== next_.provider
      || current.model !== next_.model

    if (willChange) {
      try {
        agent.model.select({ provider: next_.provider, model: next_.model })
        state.effective = next_
        lastSwitch = {
          at: Date.now(),
          from: current,
          to: next_,
          reason: state.lastFailure?.code ?? 'current-unhealthy',
        }
        log.info?.(`model-failover: 切换到 ${labelOf(next_)}` +
          (current ? `（原 ${labelOf(current)}）` : '') +
          `，原因 ${lastSwitch.reason}`)
      } catch (error) {
        log.error?.(`model-failover: model.select 失败 ${error?.message ?? error}`)
      }
    }

    return next()
  })

  /* ------------------------------------------------------------------ */
  /* 周期探活                                                            */
  /* ------------------------------------------------------------------ */

  /** @type {NodeJS.Timeout | null} */
  let probeTimer = null
  const scheduleProbe = () => {
    const interval = Math.max(10, readSettings().probeIntervalSec) * 1000
    probeTimer = setInterval(() => { void probeAll().catch(() => {}) }, interval)
    probeTimer.unref?.()
  }
  scheduleProbe()

  // 启动后探一次
  const kickoff = setTimeout(() => { void probeAll().catch(() => {}) }, 5000)
  kickoff.unref?.()

  /* ------------------------------------------------------------------ */
  /* 对外服务                                                            */
  /* ------------------------------------------------------------------ */

  const service = {
    status() {
      const s = readSettings()
      return {
        enabled: s.enabled,
        candidates: candidatesNow().map((c) => {
          const e = health.get(keyOf(c))
          return {
            provider: c.provider,
            model: c.model,
            label: labelOf(c),
            ok: e.ok,
            failures: e.failures,
            coolingDown: e.cooldownUntil > Date.now(),
            cooldownUntil: e.cooldownUntil,
            lastError: e.lastError,
            lastLatencyMs: e.lastLatencyMs,
          }
        }),
        lastSwitch,
      }
    },
    probe: probeAll,
    reset() { health.reset() },
    /** 更新运行中的配置（不重启即可生效）。 */
    updateSettings(patch) {
      live = normalizeSettings({ ...live, ...patch })
      if (probeTimer) { clearInterval(probeTimer); probeTimer = null; scheduleProbe() }
      return live
    },
  }

  ctx.set?.('modelFailover', service)

  log.info?.(`model-failover: 已加载，${candidatesNow().length} 个候选`)

  ctx.effect?.(() => () => {
    if (probeTimer) clearInterval(probeTimer)
    clearTimeout(kickoff)
  })

  return service
}
