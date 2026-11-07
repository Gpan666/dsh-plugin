/**
 * 健康表：记录每个候选模型的探测/真实调用结果，并给出下一次该用谁。
 *
 * 与 Aurabot 模块版的区别：这里是 DSH 插件层，**可以在同一轮里换模型**，
 * 所以健康表要额外支持「本轮已切换次数」的预算控制，避免一个坏模型把整轮耗光。
 */

import { DEFAULT_SETTINGS } from './candidates.js'

/**
 * @typedef {object} HealthEntry
 * @property {string} key
 * @property {boolean | null} ok
 * @property {number} failures
 * @property {number} totalFailures
 * @property {number} totalSuccesses
 * @property {number} cooldownUntil
 * @property {number} cooldownLevel
 * @property {number} lastFailAt
 * @property {number} lastOkAt
 * @property {string} lastError
 * @property {number | null} lastLatencyMs
 */

/**
 * @param {object} [opts]
 * @param {() => any} [opts.readSettings]
 * @param {() => number} [opts.now]
 */
export function createHealthTable({ readSettings = () => DEFAULT_SETTINGS, now = Date.now } = {}) {
  /** @type {Map<string, HealthEntry>} */
  const entries = new Map()

  /** @param {string} key @returns {HealthEntry} */
  const ensure = (key) => {
    let e = entries.get(key)
    if (!e) {
      e = {
        key,
        ok: null,
        failures: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        cooldownUntil: 0,
        cooldownLevel: 0,
        lastFailAt: 0,
        lastOkAt: 0,
        lastError: '',
        lastLatencyMs: null,
      }
      entries.set(key, e)
    }
    return e
  }

  return {
    /** @param {string} key */
    get(key) {
      return ensure(key)
    },

    snapshot() {
      return [...entries.values()].map((e) => ({ ...e }))
    },

    /** @param {string} key */
    isCoolingDown(key) {
      return ensure(key).cooldownUntil > now()
    },

    /** @param {string} key */
    isUsable(key) {
      return ensure(key).cooldownUntil <= now()
    },

    /** @param {string} key @param {number | null} [latencyMs] */
    recordSuccess(key, latencyMs = null) {
      const e = ensure(key)
      e.ok = true
      e.failures = 0
      e.cooldownLevel = 0
      e.cooldownUntil = 0
      e.lastOkAt = now()
      e.lastLatencyMs = latencyMs
      e.lastError = ''
      e.totalSuccesses += 1
    },

    /** @param {string} key @param {string} [error] */
    recordFailure(key, error = '') {
      const s = readSettings()
      const e = ensure(key)
      e.ok = false
      e.failures += 1
      e.totalFailures += 1
      e.lastFailAt = now()
      e.lastError = String(error || '').slice(0, 200)
      if (e.failures >= s.failureThreshold) {
        e.cooldownLevel += 1
        const backoff = Math.min(
          s.cooldownSec * 1000 * 2 ** (e.cooldownLevel - 1),
          s.maxCooldownSec * 1000,
        )
        e.cooldownUntil = now() + backoff
      }
    },

    /**
     * 直接打到最长冷却（用于配置类错误：认证错、无适配器之类，重试没意义）。
     * @param {string} key @param {string} [error]
     */
    recordPermanentFailure(key, error = '') {
      const s = readSettings()
      const e = ensure(key)
      e.ok = false
      e.failures += 1
      e.totalFailures += 1
      e.lastFailAt = now()
      e.lastError = String(error || '').slice(0, 200)
      e.cooldownLevel = 99
      e.cooldownUntil = now() + s.maxCooldownSec * 1000
    },

    /**
     * 择优。绝不返回 null，除非候选表为空。
     * @param {import('./candidates.js').Candidate[]} candidates
     * @param {import('./candidates.js').Candidate | null} [sticky]
     * @param {string | null} [excludeKey] 明确要排除的那个（比如刚失败的这个）
     */
    order(candidates, sticky = null, excludeKey = null) {
      if (!candidates || candidates.length === 0) return null
      const s = readSettings()
      const k = (/** @type {any} */ c) => `${c.provider}|${c.model}`

      if (s.sticky && sticky) {
        const sk = k(sticky)
        if (sk !== excludeKey && candidates.some((c) => k(c) === sk) && this.isUsable(sk)) return sticky
      }

      for (const cand of candidates) {
        const key = k(cand)
        if (key === excludeKey) continue
        if (this.isUsable(key)) return cand
      }

      // 全在冷却：取最早恢复的，总比直接失败强。
      /** @type {import('./candidates.js').Candidate | null} */
      let best = null
      let bestUntil = Infinity
      for (const cand of candidates) {
        const key = k(cand)
        if (key === excludeKey) continue
        const until = ensure(key).cooldownUntil
        if (until < bestUntil) { bestUntil = until; best = cand }
      }
      if (best) return best
      return candidates[0]
    },

    reset(key = null) {
      if (key) { entries.delete(key); return }
      entries.clear()
    },

    /** @param {HealthEntry[]} rows */
    restore(rows) {
      if (!Array.isArray(rows)) return
      for (const row of rows) {
        if (!row || typeof row.key !== 'string') continue
        entries.set(row.key, { ...ensure(row.key), ...row })
      }
    },
  }
}

/** 这些失败码代表配置问题，重试无意义。 */
export const PERMANENT_FAILURE_CODES = new Set([
  'NO_ADAPTER',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'AUTH',
  'INVALID_MODEL_INFO',
])
