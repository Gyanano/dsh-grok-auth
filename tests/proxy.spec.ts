import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { once } from 'node:events'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { describe, expect, it, vi } from 'vitest'
import { installHttpProxy } from '../src/env-proxy.ts'
import { parseWindowsProxy, proxyUrl, readWindowsProxy, windowsProxyBypass } from '../src/windows-proxy.ts'

const certificate = readFileSync(new URL('./fixtures/proxy-test.crt', import.meta.url), 'utf8')
const key = readFileSync(new URL('./fixtures/proxy-test.key', import.meta.url), 'utf8')
const settings = { enabled: true, server: '127.0.0.1:7897', bypass: '<local>' }

async function proxyFixture() {
  const sockets = new Set<Duplex>()
  const target = createServer((_request, response) => { response.end('direct loopback') })
  target.listen(0, '127.0.0.1')
  await once(target, 'listening')
  const targetPort = (target.address() as { port: number }).port
  const secureTarget = createHttpsServer({ key, cert: certificate }, (_request, response) => {
    response.end('through secure proxy tunnel')
  })
  secureTarget.listen(0, '127.0.0.1')
  await once(secureTarget, 'listening')
  const securePort = (secureTarget.address() as { port: number }).port
  const origins: string[] = []
  const proxy = createServer((request, response) => {
    response.end('through proxy')
    const url = new URL(request.url!)
    origins.push(`${url.hostname}:${url.port || '80'}`)
  })
  proxy.on('connect', (request, client, head) => {
    origins.push(request.url!)
    const upstream = connect(securePort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    sockets.add(client)
    sockets.add(upstream)
    client.on('error', () => { upstream.destroy() })
    upstream.on('error', () => { client.destroy() })
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  return {
    url: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
    targetUrl: `http://127.0.0.1:${targetPort}`,
    origins,
    async close() {
      for (const socket of sockets) socket.destroy()
      target.closeAllConnections()
      secureTarget.closeAllConnections()
      await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())),
        new Promise<void>(resolve => target.close(() => resolve())),
        new Promise<void>(resolve => secureTarget.close(() => resolve()))])
    },
  }
}

it('routes native fetch through the Windows system proxy without shell proxy variables', async () => {
  const fixture = await proxyFixture()
  const previous = getGlobalDispatcher()
  for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
    vi.stubEnv(name, undefined)
  }
  let dispose: (() => Promise<void>) | undefined
  try {
    dispose = await installHttpProxy(() => {}, {
      platform: 'win32',
      env: {},
      requestTls: { ca: certificate },
      readWindowsProxy: async () => ({ enabled: true, server: fixture.url, bypass: '<local>' }),
    })
    const response = await fetch('http://grok-proxy-test.invalid/models', { signal: AbortSignal.timeout(2000) })
    expect(await response.text()).toBe('through proxy')
    const secure = await fetch('https://grok-proxy-test.invalid/models', { signal: AbortSignal.timeout(2000) })
    expect(await secure.text()).toBe('through secure proxy tunnel')
    expect(await (await fetch(fixture.targetUrl)).text()).toBe('direct loopback')
    expect(fixture.origins).toEqual(['grok-proxy-test.invalid:80', 'grok-proxy-test.invalid:443'])
  } finally {
    setGlobalDispatcher(previous)
    await dispose?.()
    vi.unstubAllEnvs()
    await fixture.close()
  }
})

it.each(['explicit', 'lowercase environment', 'HTTP_PROXY fallback'] as const)(
  'routes HTTPS using %s before Windows settings', async source => {
    const fixture = await proxyFixture()
    const read = vi.fn(async () => settings)
    const previous = getGlobalDispatcher()
    const env = source === 'lowercase environment'
      ? { https_proxy: fixture.url, HTTPS_PROXY: 'http://127.0.0.1:1' }
      : source === 'HTTP_PROXY fallback' ? { HTTP_PROXY: fixture.url } : { HTTPS_PROXY: 'http://127.0.0.1:1' }
    const dispose = await installHttpProxy(() => {}, {
      platform: 'win32', env, readWindowsProxy: read, requestTls: { ca: certificate },
      ...(source === 'explicit' ? { proxyUrl: fixture.url } : {}),
    })
    try {
      const response = await fetch('https://grok-proxy-test.invalid/models', { signal: AbortSignal.timeout(2000) })
      expect(await response.text()).toBe('through secure proxy tunnel')
      expect(read).not.toHaveBeenCalled()
      expect(fixture.origins).toEqual(['grok-proxy-test.invalid:443'])
    } finally {
      await dispose()
      expect(getGlobalDispatcher()).toBe(previous)
      await fixture.close()
    }
  },
)

describe('proxy selection and bypass', () => {
  it.each([
    ['127.0.0.1:7897', { http: 'http://127.0.0.1:7897/', https: 'http://127.0.0.1:7897/' }],
    ['http=localhost:1;https=localhost:2;socks=localhost:3', { http: 'http://localhost:1/', https: 'http://localhost:2/' }],
    ['http=localhost:1;localhost:2', { http: 'http://localhost:1/', https: 'http://localhost:2/' }],
    ['https=https://proxy.example:443', { http: undefined, https: 'https://proxy.example/' }],
    ['socks=localhost:7897', { http: undefined, https: undefined }],
  ])('parses Windows ProxyServer %s', (value, expected) => {
    expect(parseWindowsProxy(value)).toEqual(expected)
  })

  it('matches Windows wildcards, ports and local hosts while keeping loopback direct', () => {
    const bypass = windowsProxyBypass('<local>;*.internal;api.example:443;literal[1].example;<-loopback>')
    for (const address of ['http://localhost', 'http://127.1.2.3', 'http://[::1]', 'http://printer',
      'https://a.internal', 'https://api.example']) expect(bypass(new URL(address))).toBe(true)
    for (const address of ['https://api.x.ai', 'http://api.example', 'https://api.example:444',
      'https://a.internal.evil', 'https://literal1.example']) expect(bypass(new URL(address))).toBe(false)
  })

  it.each([
    { proxyUrl: 'http://explicit:7897', env: { HTTPS_PROXY: 'http://environment:7897' } },
    { env: { HTTPS_PROXY: 'http://environment:7897' } },
    { env: { HTTP_PROXY: 'http://environment:7897' } },
    { env: {}, platform: 'darwin' as const },
    { env: {}, systemProxy: false },
  ])('does not query Windows when another source applies: %j', async options => {
    const read = vi.fn(async () => settings)
    const previous = getGlobalDispatcher()
    const dispose = await installHttpProxy(() => {}, { platform: 'win32', ...options, readWindowsProxy: read })
    expect(read).not.toHaveBeenCalled()
    await dispose()
    expect(getGlobalDispatcher()).toBe(previous)
  })

  it.each([
    { ...settings, enabled: false },
    { ...settings, enabled: false, autoConfigUrl: 'http://proxy.example/proxy.pac' },
    { ...settings, server: 'socks=127.0.0.1:7897' },
    { ...settings, server: 'http://private:secret@proxy:7897/path' },
  ])('leaves the existing dispatcher for unsupported or disabled settings: %j', async value => {
    const previous = getGlobalDispatcher()
    const log = vi.fn()
    const dispose = await installHttpProxy(log, { platform: 'win32', env: {}, readWindowsProxy: async () => value })
    expect(getGlobalDispatcher()).toBe(previous)
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
    await dispose()
  })

  it('sanitizes registry and explicit proxy failures', async () => {
    const log = vi.fn()
    const dispose = await installHttpProxy(log, { platform: 'win32', env: {}, readWindowsProxy: async () => {
      throw new Error('http://private:secret@proxy/')
    } })
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
    await dispose()
    expect(() => proxyUrl('http://private:secret@proxy/path')).toThrow('Invalid HTTP proxy address')
    await expect(installHttpProxy(log, { env: { HTTP_PROXY: 'http://private:secret@proxy:bad' } }))
      .rejects.toThrow('Could not initialize HTTP proxy; check the proxy address')
  })

  it('does not overwrite a dispatcher installed later by the host', async () => {
    const previous = getGlobalDispatcher()
    const replacement = new Agent()
    const dispose = await installHttpProxy(() => {}, { proxyUrl: 'http://127.0.0.1:7897', env: {} })
    try {
      setGlobalDispatcher(replacement)
      await dispose()
      await dispose()
      expect(getGlobalDispatcher()).toBe(replacement)
    } finally {
      setGlobalDispatcher(previous)
      await replacement.destroy()
    }
  })
})

it.runIf(process.platform === 'win32')('reads real Windows registry values and routes HTTPS without shell proxy variables', async () => {
  const fixture = await proxyFixture()
  const previous = getGlobalDispatcher()
  const registryKey = `HKCU:\\Software\\dsh-grok-auth-tests\\${randomUUID()}`
  const executable = win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const powershell = async (script: string) => promisify(execFile)(executable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, timeout: 5000 })
  let dispose: (() => Promise<void>) | undefined
  try {
    await powershell(`
      New-Item -Path '${registryKey}' -Force | Out-Null
      New-ItemProperty -Path '${registryKey}' -Name ProxyEnable -Value 1 -PropertyType DWord | Out-Null
      New-ItemProperty -Path '${registryKey}' -Name ProxyServer -Value '${fixture.url}' -PropertyType String | Out-Null
      New-ItemProperty -Path '${registryKey}' -Name ProxyOverride -Value '<local>;内部.example' -PropertyType String | Out-Null
    `)
    const actual = await readWindowsProxy(process.env, registryKey)
    expect(actual).toMatchObject({ enabled: true, server: fixture.url, bypass: '<local>;内部.example' })
    dispose = await installHttpProxy(() => {}, {
      env: {}, readWindowsProxy: () => readWindowsProxy(process.env, registryKey), requestTls: { ca: certificate },
    })
    const response = await fetch('https://grok-proxy-test.invalid/models', { signal: AbortSignal.timeout(3000) })
    expect(await response.text()).toBe('through secure proxy tunnel')
    expect(fixture.origins).toEqual(['grok-proxy-test.invalid:443'])
  } finally {
    await dispose?.()
    setGlobalDispatcher(previous)
    await powershell(`Remove-Item -LiteralPath '${registryKey}' -Recurse -Force -ErrorAction SilentlyContinue`)
    await fixture.close()
  }
}, 15_000)
