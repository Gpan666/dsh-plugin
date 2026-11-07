/**
 * 候选模型与设置解析（纯函数）。
 *
 * 候选写法：`provider/model`，一行一个，`#` 后为注释。
 * 也接受 `provider|model`、`provider model`，以及 `{ provider, model }` 对象。
 */

/** @typedef {{ provider: string, model: string }} Candidate */

/**
 * 归一化单个候选。
 * @param {unknown} raw
 * @returns {Candidate | null}
 */
export function normalizeCandidate(raw) {
  if (raw == null) return null
  if (typeof raw === 'object') {
    const provider = String(/** @type {any} */ (raw).provider ?? '').trim()
    const model = String(/** @type {any} */ (raw).model ?? /** @type {any} */ (raw).id ?? '').trim()
    return provider && model ? { provider, model } : null
  }
  const line = String(raw).trim()
  if (!line) return null
  const parts = line.split(/[|/\s]+/).filter(Boolean)
  if (parts.length < 2) return null
  const provider = parts[0]
  const model = parts.slice(1).join('-')
  return provider && model ? { provider, model } : null
}

/**
 * 解析多行文本或数组为去重候选表（保持顺序）。
 * @param {string | unknown[]} input
 * @returns {Candidate[]}
 */
export function parseCandidates(input) {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/)
  /** @type {Set<string>} */
  const seen = new Set()
  /** @type {Candidate[]} */
  const out = []
  for (const line of lines) {
    const text = typeof line === 'string' ? line.replace(/#.*$/, '') : line
    const cand = normalizeCandidate(text)
    if (!cand) continue
    const key = `${cand.provider}|${cand.model}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cand)
  }
  return out
}

/** 候选的唯一键。 */
export function keyOf(candidate) {
  return candidate ? `${candidate.provider}|${candidate.model}` : ''
}

/** 展示名。 */
export function labelOf(candidate) {
  return candidate ? `${candidate.provider}/${candidate.model}` : ''
}

/** 默认设置。 */
export const DEFAULT_SETTINGS = {
  enabled: true,
  candidates: [
    'deepseek-official/deepseek-v4-flash',
    'deepseek-official/deepseek-v4.1-flash',
  ].join('\n'),
  failureThreshold: 1,
  cooldownSec: 60,
  maxCooldownSec: 600,
  sticky: true,
  retrySameTurn: true,
  maxSameTurnSwitches: 2,
  probeTimeoutSec: 8,
  probeIntervalSec: 120,
  claimRetry: false,
  restoreOnStart: true,
}

/**
 * 把任意设置规整成合法值。
 * 覆盖 DEFAULT_SETTINGS 的**全部**键——漏一个就会在下游产生 NaN 之类的静默故障
 * （例如 setInterval(NaN) 会被 Node 当成 1ms，疯狂轮询）。
 * @param {any} raw
 */
export function normalizeSettings(raw = {}) {
  const v = raw && typeof raw === 'object' ? raw : {}
  const num = (/** @type {any} */ value, /** @type {number} */ fallback, /** @type {number} */ min, /** @type {number} */ max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.round(n)))
  }
  const bool = (/** @type {any} */ value, /** @type {boolean} */ fallback) =>
    typeof value === 'boolean' ? value : fallback

  return {
    enabled: bool(v.enabled, DEFAULT_SETTINGS.enabled),
    candidates: typeof v.candidates === 'string' && v.candidates.trim()
      ? v.candidates
      : DEFAULT_SETTINGS.candidates,
    failureThreshold: num(v.failureThreshold, DEFAULT_SETTINGS.failureThreshold, 1, 10),
    cooldownSec: num(v.cooldownSec, DEFAULT_SETTINGS.cooldownSec, 5, 3600),
    maxCooldownSec: num(v.maxCooldownSec, DEFAULT_SETTINGS.maxCooldownSec, 5, 3600),
    sticky: bool(v.sticky, DEFAULT_SETTINGS.sticky),
    retrySameTurn: bool(v.retrySameTurn, DEFAULT_SETTINGS.retrySameTurn),
    maxSameTurnSwitches: num(v.maxSameTurnSwitches, DEFAULT_SETTINGS.maxSameTurnSwitches, 0, 10),
    probeTimeoutSec: num(v.probeTimeoutSec, DEFAULT_SETTINGS.probeTimeoutSec, 1, 120),
    probeIntervalSec: num(v.probeIntervalSec, DEFAULT_SETTINGS.probeIntervalSec, 10, 3600),
    claimRetry: bool(v.claimRetry, DEFAULT_SETTINGS.claimRetry),
    restoreOnStart: bool(v.restoreOnStart, DEFAULT_SETTINGS.restoreOnStart),
  }
}
