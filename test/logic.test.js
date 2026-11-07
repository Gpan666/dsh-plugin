/**
 * 纯逻辑测试：候选解析、健康表、探活结果分类。
 * 不依赖 DSH 运行时，可直接 node --test 跑。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SETTINGS,
  keyOf,
  labelOf,
  normalizeCandidate,
  normalizeSettings,
  parseCandidates,
} from '../src/candidates.js'
import { createHealthTable, PERMANENT_FAILURE_CODES } from '../src/health.js'
import { classifyFinish, isPermanentCode } from '../src/health-extra.js'

const A = { provider: 'pa', model: 'ma' }
const B = { provider: 'pb', model: 'mb' }
const C = { provider: 'pc', model: 'mc' }
const k = keyOf

/* ---------------- 候选解析 ---------------- */

test('三种分隔符', () => {
  assert.deepEqual(normalizeCandidate('p/m'), { provider: 'p', model: 'm' })
  assert.deepEqual(normalizeCandidate('p|m'), { provider: 'p', model: 'm' })
  assert.deepEqual(normalizeCandidate('p m'), { provider: 'p', model: 'm' })
})

test('模型名内的连字符保留', () => {
  assert.deepEqual(normalizeCandidate('openai/gpt-4-turbo'), { provider: 'openai', model: 'gpt-4-turbo' })
})

test('注释空行忽略，重复去重', () => {
  const out = parseCandidates(`
# 主
a/b   # 注
   
a/b
c/d
`)
  assert.equal(out.length, 2)
})

test('无效输入返回 null 不抛错', () => {
  assert.equal(normalizeCandidate(''), null)
  assert.equal(normalizeCandidate('单段'), null)
  assert.equal(normalizeCandidate(null), null)
  assert.equal(normalizeCandidate({ provider: 'p' }), null)
})

test('labelOf 与 keyOf 稳定', () => {
  assert.equal(labelOf(A), 'pa/ma')
  assert.equal(k(A), 'pa|ma')
})

/* ---------------- 设置归一化 ---------------- */

test('脏设置被夹紧', () => {
  const s = normalizeSettings({ failureThreshold: -3, cooldownSec: 999999, maxSameTurnSwitches: 99 })
  assert.equal(s.failureThreshold, 1)
  assert.equal(s.cooldownSec, 3600)
})

test('空/非对象设置不崩', () => {
  assert.doesNotThrow(() => normalizeSettings(null))
  assert.doesNotThrow(() => normalizeSettings('str'))
  assert.equal(normalizeSettings(null).enabled, true)
})

/* ---------------- 健康表 ---------------- */

function fakeClock(start = 1000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('未探测过按候选顺序选第一个', () => {
  const h = createHealthTable({ now: fakeClock().now })
  assert.deepEqual(h.order([A, B, C], null), A)
})

test('第一个坏了选第二个', () => {
  const c = fakeClock()
  const h = createHealthTable({ readSettings: () => ({ ...DEFAULT_SETTINGS, failureThreshold: 1, cooldownSec: 60 }), now: c.now })
  h.recordFailure(k(A), 'boom')
  assert.deepEqual(h.order([A, B], null), B)
})

test('排除指定 key', () => {
  const c = fakeClock()
  const h = createHealthTable({ now: c.now })
  assert.deepEqual(h.order([A, B], null, k(A)), B)
})

test('粘滞：健康就不换', () => {
  const c = fakeClock()
  const h = createHealthTable({ readSettings: () => ({ ...DEFAULT_SETTINGS, sticky: true }), now: c.now })
  assert.deepEqual(h.order([A, B], B), B)
})

test('粘滞但坏了就换', () => {
  const c = fakeClock()
  const h = createHealthTable({ readSettings: () => ({ ...DEFAULT_SETTINGS, sticky: true, failureThreshold: 1 }), now: c.now })
  h.recordFailure(k(B), 'x')
  assert.deepEqual(h.order([A, B], B), A)
})

test('全冷却时返回最早恢复的', () => {
  const c = fakeClock()
  const h = createHealthTable({ readSettings: () => ({ ...DEFAULT_SETTINGS, failureThreshold: 1, cooldownSec: 60 }), now: c.now })
  h.recordFailure(k(A), 'x')
  c.advance(10_000)
  h.recordFailure(k(B), 'y')
  assert.deepEqual(h.order([A, B], null), A)
})

test('指数退避并按上限截断', () => {
  const c = fakeClock()
  const h = createHealthTable({
    readSettings: () => ({ ...DEFAULT_SETTINGS, failureThreshold: 1, cooldownSec: 60, maxCooldownSec: 300 }),
    now: c.now,
  })
  h.recordFailure(k(A), '1')
  const first = h.get(k(A)).cooldownUntil - c.now()
  c.advance(first + 1)
  h.recordFailure(k(A), '2')
  const second = h.get(k(A)).cooldownUntil - c.now()
  c.advance(second + 1)
  h.recordFailure(k(A), '3')
  const third = h.get(k(A)).cooldownUntil - c.now()
  assert.equal(first, 60_000)
  assert.equal(second, 120_000)
  assert.equal(third, 240_000)
  c.advance(third + 1)
  h.recordFailure(k(A), '4')
  assert.equal(h.get(k(A)).cooldownUntil - c.now(), 300_000, '被 maxCooldownSec 截断')
})

test('recordPermanentFailure 直接到上限', () => {
  const c = fakeClock()
  const h = createHealthTable({
    readSettings: () => ({ ...DEFAULT_SETTINGS, maxCooldownSec: 300 }),
    now: c.now,
  })
  h.recordPermanentFailure(k(A), 'AUTH')
  assert.equal(h.get(k(A)).cooldownUntil - c.now(), 300_000)
})

test('成功后清零', () => {
  const c = fakeClock()
  const h = createHealthTable({ readSettings: () => ({ ...DEFAULT_SETTINGS, failureThreshold: 1 }), now: c.now })
  h.recordFailure(k(A), 'x')
  h.recordSuccess(k(A), 15)
  assert.equal(h.get(k(A)).failures, 0)
  assert.ok(h.isUsable(k(A)))
  assert.equal(h.get(k(A)).lastLatencyMs, 15)
})

test('空候选返回 null', () => {
  const h = createHealthTable()
  assert.equal(h.order([], null), null)
  assert.equal(h.order(null, null), null)
})

test('restore / reset', () => {
  const c = fakeClock()
  const h = createHealthTable({ now: c.now })
  h.restore([{ key: k(A), ok: false, failures: 3, cooldownUntil: c.now() + 1000 }])
  assert.equal(h.get(k(A)).failures, 3)
  h.reset(k(A))
  assert.equal(h.get(k(A)).failures, 0)
})

/* ---------------- 失败码分类 ---------------- */

test('配置类失败码集合', () => {
  assert.ok(PERMANENT_FAILURE_CODES.has('AUTH'))
  assert.ok(PERMANENT_FAILURE_CODES.has('NO_ADAPTER'))
  assert.ok(!PERMANENT_FAILURE_CODES.has('RATE_LIMIT'), '限流是可以恢复的')
})

test('classifyFinish 认出错误与中止', () => {
  const err = classifyFinish({ kind: 'error', failure: { code: 'RATE_LIMIT', message: 'too many' } })
  assert.equal(err.ok, false)
  assert.equal(err.code, 'RATE_LIMIT')
  assert.equal(err.permanent, false)

  const auth = classifyFinish({ kind: 'error', failure: { code: 'AUTH', message: 'bad key' } })
  assert.equal(auth.permanent, true, 'AUTH 应判为永久')

  const aborted = classifyFinish({ kind: 'aborted', failure: { code: 'ABORTED' } })
  assert.equal(aborted.code, 'TIMEOUT')
})

test('classifyFinish 成功', () => {
  const ok = classifyFinish({ kind: 'stop' })
  assert.equal(ok.ok, true)
})

test('isPermanentCode 兜底', () => {
  assert.equal(isPermanentCode('AUTH'), true)
  assert.equal(isPermanentCode(undefined), false)
  assert.equal(isPermanentCode('WHATEVER'), false)
})
