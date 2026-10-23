const BODY_LIMIT = 1024 * 1024

export function anthropicModelsURL(baseURL = 'https://api.anthropic.com') {
  const root = baseURL.replace(/\/+$/, '').replace(/\/v1$/, '')
  return `${root}/v1/models?limit=1000`
}

/** Explicit, bounded model-listing probe. No response text or credentials leave this boundary. */
export async function testAnthropicConnection({ baseURL, apiKey, provider = true, configuredModels = [], fetch = globalThis.fetch, timeoutMs = 10000 }) {
  const started = Date.now()
  const result = (outcome, extra = {}) => ({ ok: outcome === 'ok', outcome, ...extra, elapsedMs: Date.now() - started })
  if (!provider) return result('no-provider')
  if (!apiKey) return result('no-key')
  const controller = new AbortController()
  let timer
  let reader
  let response
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, timeoutMs)
  })
  try {
    return await Promise.race([timeout, (async () => {
      response = await fetch(anthropicModelsURL(baseURL), {
        method: 'GET', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        redirect: 'manual', signal: controller.signal,
      })
      const status = response.status
      if (status >= 300 && status < 400) return result('redirect', { status })
      if ([401, 403].includes(status)) return result('unauthorized', { status })
      if ([404, 405, 501].includes(status)) return result('not-supported', { status })
      if (status < 200 || status >= 300) return result('http-error', { status })
      if (!response.body || Number(response.headers?.get('content-length')) > BODY_LIMIT) return result('not-supported', { status })
      reader = response.body.getReader()
      const chunks = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > BODY_LIMIT) return result('not-supported', { status })
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      let listing
      try { listing = JSON.parse(new TextDecoder().decode(bytes)) } catch { return result('not-supported', { status }) }
      if (!Array.isArray(listing?.data)) return result('not-supported', { status })
      const safeId = id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes(apiKey)
      const ids = new Set(listing.data.map(item => item?.id).filter(safeId))
      return result('ok', { status, models: [...ids].slice(0, 100), missing: configuredModels.filter(id => safeId(id) && !ids.has(id)) })
    })()])
  } catch {
    return result(controller.signal.aborted ? 'timeout' : 'unreachable')
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (reader) void reader.cancel().catch(() => {})
    else if (response?.body) void response.body.cancel().catch(() => {})
  }
}
