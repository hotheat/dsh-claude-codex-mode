/** Whitelist configuration fields that may be displayed by the browser. */
export async function apiConfigSummary(facts) {
  const provider = facts.providers?.anthropic
  let baseURL = null
  if (provider?.baseURL) {
    try {
      const url = new URL(provider.baseURL)
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      baseURL = url.href
    } catch { /* Invalid addresses must not expose credential-like input. */ }
  }
  const apiKeyEnv = provider?.apiKeyEnv || null
  const credential = apiKeyEnv ? await facts.credentialDescribe(apiKeyEnv) : null
  return {
    provider: Boolean(provider), baseURL, defaultBaseURL: !provider?.baseURL, apiKeyEnv,
    credential: { configured: Boolean(credential?.configured), source: credential?.source ?? null },
    models: (provider?.models ?? []).map(item => item.id).filter(id => typeof id === 'string'),
    defaultModel: facts.defaultModel ? { provider: facts.defaultModel.provider, model: facts.defaultModel.model } : null,
  }
}
