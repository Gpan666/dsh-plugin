/**
 * 单个候选的探活：打一个极小请求，判断 provider/model 现在通不通。
 */

import { PERMANENT_FAILURE_CODES } from './health.js'

/**
 * @typedef {object} ProbeResult
 * @property {boolean} ok
 * @property {string} code
 * @property {string} message
 * @property {number} latencyMs
 */

/**
 * 探一次。
 * @param {object} args
 * @param {any} args.llm         DSH 的 llm 服务
 * @param {{provider:string, model:string}} args.cand
 * @param {number} args.timeoutMs
 * @param {string} [args.prompt]
 * @returns {Promise<ProbeResult>}
 */
export async function probeOnce({ llm, cand, timeoutMs, prompt = 'ping' }) {
  const started = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  timer.unref?.()

  try {
    const stream = llm.stream({
      provider: cand.provider,
      model: cand.model,
      maxTokens: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: ac.signal,
    })

    let finish = null
    for await (const chunk of stream) {
      if (chunk?.kind === 'finish') { finish = chunk; break }
    }

    const latencyMs = Date.now() - started

    if (!finish) {
      return { ok: false, code: 'NO_FINISH', message: '流没有给出终止块', latencyMs }
    }
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const aborted = finish.kind === 'aborted'
      const code = String(finish?.failure?.code ?? (aborted ? 'TIMEOUT' : 'UNKNOWN'))
      const message = String(finish?.failure?.message ?? '')
      return { ok: false, code, message: aborted ? `探测超时（${timeoutMs}ms）` : message, latencyMs }
    }
    return { ok: true, code: 'OK', message: '', latencyMs }
  } catch (error) {
    const latencyMs = Date.now() - started
    const aborted = error?.name === 'AbortError' || ac.signal.aborted
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : String(error?.code ?? 'PROBE_ERROR'),
      message: aborted ? `探测超时（${timeoutMs}ms）` : String(error?.message ?? error ?? ''),
      latencyMs,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探活结果是否应触发「永久冷却」（配置类错误）。
 * @param {ProbeResult} res
 */
export function isPermanent(res) {
  return PERMANENT_FAILURE_CODES.has(res.code)
}
