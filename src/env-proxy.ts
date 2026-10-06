import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher, type buildConnector } from 'undici'
import { isLoopback, parseWindowsProxy, proxyUrl, readWindowsProxy, windowsProxyBypass } from './windows-proxy.ts'
import type { WindowsProxySettings } from './windows-proxy.ts'

interface ProxyOptions {
  proxyUrl?: string
  systemProxy?: boolean
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  readWindowsProxy?: () => Promise<WindowsProxySettings>
  requestTls?: buildConnector.BuildOptions
}

/** pi-ai uses native fetch, so routing must be installed on the host dispatcher. */
export async function installHttpProxy(
  log: (message: string) => void,
  options: ProxyOptions = {},
): Promise<() => Promise<void>> {
  const env = options.env ?? process.env
  let http = env.http_proxy ?? env.HTTP_PROXY ?? ''
  let https = env.https_proxy ?? env.HTTPS_PROXY ?? ''
  let bypass = isLoopback
  let source = 'environment HTTP proxy'
  let system = false
  if (options.proxyUrl?.trim()) {
    http = https = proxyUrl(options.proxyUrl.trim())
    source = 'configured HTTP proxy'
  } else if (!http && !https) {
    if ((options.platform ?? process.platform) !== 'win32' || options.systemProxy === false) {
      return async () => {}
    }
    let settings: WindowsProxySettings
    try {
      settings = await (options.readWindowsProxy ?? (() => readWindowsProxy(env)))()
    } catch {
      log('llm-grok-auth: could not read Windows system proxy; using the existing network configuration')
      return async () => {}
    }
    if (!settings.enabled) {
      if (settings.autoConfigUrl) log('llm-grok-auth: automatic proxy scripts (PAC) are unsupported; configure a static HTTP proxy or HTTP_PROXY / HTTPS_PROXY')
      return async () => {}
    }
    try {
      const proxies = parseWindowsProxy(settings.server)
      http = proxies.http ?? ''
      https = proxies.https ?? ''
    } catch {
      log('llm-grok-auth: invalid Windows static HTTP proxy; using the existing network configuration')
      return async () => {}
    }
    if (!http && !https) return async () => {}
    bypass = windowsProxyBypass(settings.bypass)
    source = 'Windows system HTTP proxy'
    system = true
  }

  const direct = new Agent()
  let agent: Dispatcher
  try {
    agent = new EnvHttpProxyAgent({
      httpProxy: http,
      httpsProxy: https,
      ...(options.requestTls ? { requestTls: options.requestTls } : {}),
      // Preserve dynamic NO_PROXY handling for the real process environment.
      ...(options.env ? { noProxy: env.no_proxy ?? env.NO_PROXY ?? '' } : {}),
    })
  } catch {
    await direct.destroy()
    throw new Error('Could not initialize HTTP proxy; check the proxy address')
  }
  const dispatcher = direct.compose(dispatch => (request, handler) => {
    const url = new URL(String(request.origin))
    // A protocol omitted from a Windows mapping stays direct; env HTTPS_PROXY
    // keeps Undici's existing fallback to HTTP_PROXY.
    if (bypass(url) || (system && !(url.protocol === 'https:' ? https : http))) {
      return dispatch(request, handler)
    }
    return agent.dispatch(request, handler)
  })
  const previous = getGlobalDispatcher()
  setGlobalDispatcher(dispatcher)
  log(`llm-grok-auth: routing outbound requests through the ${source}`)
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    if (getGlobalDispatcher() === dispatcher) setGlobalDispatcher(previous)
    await Promise.all([direct.destroy(), agent.destroy()])
  }
}
