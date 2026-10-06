import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const INTERNET_SETTINGS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

export interface WindowsProxySettings {
  enabled: boolean
  server: string
  bypass: string
  autoConfigUrl?: string
}

/** The optional key lets native Windows tests use an isolated registry fixture. */
export async function readWindowsProxy(
  env: NodeJS.ProcessEnv = process.env,
  registryKey = INTERNET_SETTINGS,
): Promise<WindowsProxySettings> {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR
  const executable = root
    ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  const script = `
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $p = Get-ItemProperty -LiteralPath '${registryKey.replaceAll("'", "''")}' -ErrorAction Stop
    [ordered]@{
      enabled = ($p.ProxyEnable -eq 1)
      server = [string]$p.ProxyServer
      bypass = [string]$p.ProxyOverride
      autoConfigUrl = [string]$p.AutoConfigURL
    } | ConvertTo-Json -Compress
  `
  const { stdout } = await execFileAsync(executable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], { timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' })
  const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim())
  if (!value || typeof value !== 'object') throw new Error('Invalid Windows proxy settings')
  const settings = value as Record<string, unknown>
  if (typeof settings.enabled !== 'boolean' || typeof settings.server !== 'string'
    || typeof settings.bypass !== 'string') throw new Error('Invalid Windows proxy settings')
  return {
    enabled: settings.enabled,
    server: settings.server,
    bypass: settings.bypass,
    autoConfigUrl: typeof settings.autoConfigUrl === 'string' ? settings.autoConfigUrl : '',
  }
}

export function proxyUrl(value: string): string {
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname
      || url.pathname !== '/' || url.search || url.hash) throw new Error()
    return url.href
  } catch {
    // Never echo a proxy URI: it may contain credentials.
    throw new Error('Invalid HTTP proxy address; use http://host:port or https://host:port')
  }
}

export function parseWindowsProxy(server: string): { http: string | undefined; https: string | undefined } {
  let shared: string | undefined
  const protocols: Record<string, string> = {}
  for (const entry of server.split(';').map(value => value.trim()).filter(Boolean)) {
    const mapping = /^(\w+)\s*=\s*(.+)$/.exec(entry)
    if (!mapping) shared = proxyUrl(entry)
    else if (mapping[1]!.toLowerCase() === 'http' || mapping[1]!.toLowerCase() === 'https') {
      protocols[mapping[1]!.toLowerCase()] = proxyUrl(mapping[2]!)
    }
  }
  return { http: protocols.http ?? shared, https: protocols.https ?? shared }
}

export function isLoopback(url: URL): boolean {
  const host = url.hostname.toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || host === 'loopback'
    || host === '[::1]' || /^127\./.test(host)
}

export function windowsProxyBypass(value: string): (url: URL) => boolean {
  const entries = value.split(';').map(entry => entry.trim().toLowerCase()).filter(Boolean)
  const patterns = entries.filter(entry => !entry.startsWith('<')).map(entry => ({
    withPort: /:\d+$/.test(entry),
    pattern: new RegExp(`^${entry.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`),
  }))
  return url => {
    if (isLoopback(url)) return true
    const host = url.hostname.toLowerCase()
    if (entries.includes('<local>') && !host.includes('.') && !host.includes(':')) return true
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    return patterns.some(({ withPort, pattern }) => pattern.test(withPort ? `${host}:${port}` : host))
  }
}
