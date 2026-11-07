/**
 * 终止块（finish chunk）的分类辅助。
 *
 * DSH 的流协议保证：每个流恰好以一个 `finish` 块结束，成功可能是
 * `{kind:'stop'}` / `{kind:'max-tokens'}`，失败是 `{kind:'error'}`，
 * 取消是 `{kind:'aborted'}`。这里把它归一成插件内部用的形状。
 */

import { PERMANENT_FAILURE_CODES } from './health.js'

/**
 * @typedef {object} FinishVerdict
 * @property {boolean} ok
 * @property {string} code
 * @property {string} message
 * @property {boolean} permanent
 */

/**
 * 判断一个失败码是否属于「配置错，重试无意义」。
 * @param {unknown} code
 * @returns {boolean}
 */
export function isPermanentCode(code) {
  return typeof code === 'string' && PERMANENT_FAILURE_CODES.has(code)
}

/**
 * 把终止块归一成判定结果。
 * @param {any} finish
 * @returns {FinishVerdict}
 */
export function classifyFinish(finish) {
  if (!finish || typeof finish !== 'object') {
    return { ok: false, code: 'NO_FINISH', message: '缺少终止块', permanent: false }
  }

  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const aborted = finish.kind === 'aborted'
    const rawCode = finish?.failure?.code
    const code = aborted ? 'TIMEOUT' : (typeof rawCode === 'string' ? rawCode : 'UNKNOWN')
    const message = String(finish?.failure?.message ?? '')
    return {
      ok: false,
      code,
      message,
      permanent: !aborted && isPermanentCode(code),
    }
  }

  return { ok: true, code: 'OK', message: '', permanent: false }
}
