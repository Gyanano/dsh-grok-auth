/**
 * Host-side tests for the grok-auth plugin: token decoding, entry selection,
 * refresh, device login, atomic persistence, adapter wiring, and the status
 * service.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  accessTokenOf, authState, decodeAccessToken, defaultAuthJsonPath, expiryOf, expiryUnknown,
  GROK_AUTH_ENTRY_KEY, GROK_OAUTH_CLIENT_ID, GROK_OAUTH_DEVICE_CODE_URL, GROK_OAUTH_TOKEN_URL,
  mergeDeviceLogin, mergeRefreshed, needsRefresh, pollDeviceToken, readAuthFile, refreshTokenOf,
  refreshTokens, requestDeviceCode, selectAuthEntry, writeAuthFile,
} from '../src/grok-auth.ts'
import type { GrokAuthEntry, GrokAuthFile } from '../src/grok-auth.ts'
import { GrokAuthAdapter, GROK_ROUTE, grokAuthInjection } from '../src/grok-auth-adapter.ts'
import { liveModelName, parseLiveModels } from '../src/grok-models.ts'
import { GrokAuthService, usageFromPayload } from '../src/grok-auth-service.ts'
import type { GrokAuthServiceOptions } from '../src/grok-auth-service.ts'
import { Config as PluginConfig, type Config as PluginConfigView } from '../src/index.ts'

/** Captures the options each GrokAuthAdapter hands to the PiAiAdapter base. */
const piAiAdapterCalls: PiAiAdapterOptions[] = []
vi.mock('@deepseek-ai/dsh-llm-pi-ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-llm-pi-ai')>()
  return {
    ...original,
    PiAiAdapter: class {
      constructor(options: PiAiAdapterOptions) {
        piAiAdapterCalls.push(options)
      }
    },
  }
})

/** A fake xAI access-token JWT with only the locally verifiable exp claim. */
function fakeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ typ: 'at+jwt', alg: 'ES256' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds, iss: 'https://auth.x.ai' })).toString('base64url')
  return `${header}.${payload}.signature`
}

function cliEntry(overrides: Partial<GrokAuthEntry> = {}): GrokAuthEntry {
  return {
    key: fakeJwt(Math.floor(Date.now() / 1000) + 6 * 3600),
    auth_mode: 'oidc',
    create_time: new Date().toISOString(),
    email: 'user@example.com',
    refresh_token: 'refresh-1',
    expires_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    oidc_issuer: 'https://auth.x.ai',
    oidc_client_id: GROK_OAUTH_CLIENT_ID,
    ...overrides,
  }
}

function cliFile(overrides: Partial<GrokAuthEntry> = {}): GrokAuthFile {
  return { [GROK_AUTH_ENTRY_KEY]: cliEntry(overrides) }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('decodeAccessToken', () => {
  it('decodes exp from a well-formed JWT', () => {
    expect(decodeAccessToken(fakeJwt(1_800_000_000)).expSeconds).toBe(1_800_000_000)
  })

  it('answers empty for a non-JWT token', () => {
    expect(decodeAccessToken('not-a-jwt')).toEqual({})
    expect(decodeAccessToken('a.b')).toEqual({})
    expect(decodeAccessToken('')).toEqual({})
  })
})

describe('defaultAuthJsonPath', () => {
  it('honours GROK_HOME and falls back to ~/.grok', () => {
    expect(defaultAuthJsonPath({ GROK_HOME: '/tmp/grok-home' })).toBe(join('/tmp/grok-home', 'auth.json'))
    expect(defaultAuthJsonPath({})).toContain(join('.grok', 'auth.json'))
  })
})

describe('selectAuthEntry / field aliases', () => {
  it('prefers the exact official entry key', () => {
    const file: GrokAuthFile = {
      'https://other::whatever': { key: 'x' },
      [GROK_AUTH_ENTRY_KEY]: cliEntry(),
    }
    expect(selectAuthEntry(file)?.entryKey).toBe(GROK_AUTH_ENTRY_KEY)
  })

  it('falls back to a client-id-suffixed key, a claiming entry, then a lone entry', () => {
    expect(selectAuthEntry({ [`me@example.com::${GROK_OAUTH_CLIENT_ID}`]: { key: 'x' } })?.entry.key).toBe('x')
    expect(selectAuthEntry({ anything: { key: 'y', oidc_client_id: GROK_OAUTH_CLIENT_ID } })?.entry.key).toBe('y')
    expect(selectAuthEntry({ solo: { key: 'z' } })?.entry.key).toBe('z')
    expect(selectAuthEntry({ a: { key: '1' }, b: { key: '2' } })).toBeUndefined()
    expect(selectAuthEntry({})).toBeUndefined()
    expect(selectAuthEntry(undefined)).toBeUndefined()
  })

  it('reads token and expiry aliases', () => {
    expect(accessTokenOf({ key: 'k' })).toBe('k')
    expect(accessTokenOf({ access_token: 'a' })).toBe('a')
    expect(refreshTokenOf({ refresh_token: 'r' })).toBe('r')
    expect(refreshTokenOf({ refresh: 'r2' })).toBe('r2')
    const iso = new Date(1_800_000_000_000).toISOString()
    expect(expiryOf({ expires_at: iso }, undefined)).toBe(1_800_000_000_000)
    expect(expiryOf({ expires: 1_800_000_000_000 }, undefined)).toBe(1_800_000_000_000)
    expect(expiryOf({}, fakeJwt(1_800_000_000))).toBe(1_800_000_000_000)
    expect(expiryOf({}, 'opaque')).toBeUndefined()
  })
})

describe('authState / needsRefresh / expiryUnknown', () => {
  it('extracts the access token and its expiry', () => {
    const state = authState(cliFile())
    expect(state.accessToken).toBeTruthy()
    expect(state.accessTokenExpiresAt).toBeGreaterThan(Date.now())
    expect(needsRefresh(state, 5 * 60 * 1000)).toBe(false)
    expect(expiryUnknown(state)).toBe(false)
  })

  it('flags a near-expiry token and an unmeasurable one', () => {
    const near = authState(cliFile({
      key: fakeJwt(Math.floor(Date.now() / 1000) + 60),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }))
    expect(needsRefresh(near, 5 * 60 * 1000)).toBe(true)
    const opaque = authState(cliFile({ key: 'opaque-token' }))
    delete (opaque.entry as GrokAuthEntry).expires_at
    const reread = authState({ [GROK_AUTH_ENTRY_KEY]: { key: 'opaque-token' } })
    expect(expiryUnknown(reread)).toBe(true)
    expect(needsRefresh(reread, 5 * 60 * 1000)).toBe(false)
  })

  it('answers no token for an absent or tokenless entry', () => {
    expect(authState(undefined).accessToken).toBeUndefined()
    expect(authState({ [GROK_AUTH_ENTRY_KEY]: { auth_mode: 'oidc' } }).accessToken).toBeUndefined()
  })
})

describe('refreshTokens', () => {
  it('posts the CLI wire format and validates the reply', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(GROK_OAUTH_TOKEN_URL)
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('client_id')).toBe(GROK_OAUTH_CLIENT_ID)
      expect(body.get('refresh_token')).toBe('refresh-1')
      return jsonResponse({ access_token: 'new-token', refresh_token: 'refresh-2', expires_in: 21600 })
    })
    const reply = await refreshTokens('refresh-1', fetchImpl as typeof fetch)
    expect(reply).toEqual({ access_token: 'new-token', refresh_token: 'refresh-2', expires_in: 21600 })
  })

  it('throws on an HTTP failure and on a tokenless reply', async () => {
    const failing = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400))
    await expect(refreshTokens('r', failing as typeof fetch)).rejects.toThrow('400')
    const empty = vi.fn(async () => jsonResponse({}))
    await expect(refreshTokens('r', empty as typeof fetch)).rejects.toThrow('access_token')
  })
})

describe('mergeRefreshed', () => {
  it('updates the CLI-shaped entry and preserves unknown fields', () => {
    const file = cliFile({ team_id: 'team-1', coding_data_retention_opt_out: true })
    const merged = mergeRefreshed(file, GROK_AUTH_ENTRY_KEY, {
      access_token: 'next', refresh_token: 'refresh-2', expires_in: 21600,
    })
    const entry = merged[GROK_AUTH_ENTRY_KEY] as GrokAuthEntry
    expect(entry.key).toBe('next')
    expect(entry.refresh_token).toBe('refresh-2')
    expect(entry.team_id).toBe('team-1')
    expect(entry.coding_data_retention_opt_out).toBe(true)
    const expiry = Date.parse(entry.expires_at ?? '')
    expect(expiry).toBeGreaterThan(Date.now() + 21000 * 1000)
  })

  it('keeps a non-rotated refresh token and legacy field spellings', () => {
    const legacy: GrokAuthFile = { legacy: { access_token: 'old', refresh: 'r-old', expires: 5 } }
    const merged = mergeRefreshed(legacy, 'legacy', { access_token: 'new', expires_in: 60 })
    const entry = merged.legacy as GrokAuthEntry
    expect(entry.access_token).toBe('new')
    expect(entry.key).toBeUndefined()
    expect(entry.refresh).toBe('r-old')
    expect(typeof entry.expires).toBe('number')
  })
})

describe('mergeDeviceLogin', () => {
  it('creates a minimal CLI-shaped entry when no file exists', () => {
    const merged = mergeDeviceLogin(undefined, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 })
    const entry = merged[GROK_AUTH_ENTRY_KEY] as GrokAuthEntry
    expect(entry.key).toBe('tok')
    expect(entry.refresh_token).toBe('ref')
    expect(entry.auth_mode).toBe('oidc')
    expect(entry.oidc_client_id).toBe(GROK_OAUTH_CLIENT_ID)
  })

  it('merges into an existing entry, preserving identity facts', () => {
    const merged = mergeDeviceLogin(cliFile(), { access_token: 'tok2', refresh_token: 'ref2' })
    const entry = merged[GROK_AUTH_ENTRY_KEY] as GrokAuthEntry
    expect(entry.key).toBe('tok2')
    expect(entry.email).toBe('user@example.com')
  })
})

describe('device-code flow', () => {
  it('requests a device authorization and validates the verification URI', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(GROK_OAUTH_DEVICE_CODE_URL)
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('client_id')).toBe(GROK_OAUTH_CLIENT_ID)
      expect(body.get('scope')).toContain('grok-cli:access')
      return jsonResponse({
        device_code: 'dev-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://auth.x.ai/activate',
        verification_uri_complete: 'https://auth.x.ai/activate?user_code=ABCD-1234',
        interval: 5,
        expires_in: 300,
      })
    })
    const device = await requestDeviceCode(fetchImpl as typeof fetch)
    expect(device.userCode).toBe('ABCD-1234')
    expect(device.verificationUriComplete).toContain('https://auth.x.ai/activate')
    expect(device.intervalSeconds).toBe(5)
  })

  it('rejects a non-https verification URI', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      device_code: 'dev-1',
      user_code: 'ABCD-1234',
      verification_uri: 'javascript:alert(1)',
      expires_in: 300,
    }))
    await expect(requestDeviceCode(fetchImpl as typeof fetch)).rejects.toThrow('verification URI')
  })

  it('maps every polling outcome', async () => {
    const outcomes: [unknown, number, string][] = [
      [{ error: 'authorization_pending' }, 400, 'pending'],
      [{ error: 'slow_down', interval: 10 }, 400, 'slow_down'],
      [{ error: 'access_denied' }, 400, 'failed'],
      [{ error: 'expired_token' }, 400, 'failed'],
      [{ access_token: 'tok', refresh_token: 'ref' }, 200, 'complete'],
    ]
    for (const [body, status, expected] of outcomes) {
      const fetchImpl = vi.fn(async () => jsonResponse(body, status))
      const result = await pollDeviceToken('dev-1', fetchImpl as typeof fetch)
      expect(result.status).toBe(expected)
    }
  })
})

describe('writeAuthFile / readAuthFile', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grok-auth-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('persists atomically at 0600 and round-trips', async () => {
    const path = join(directory, 'auth.json')
    const file = cliFile()
    await writeAuthFile(path, file)
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
    expect(await readAuthFile(path)).toEqual(file)
  })

  it('answers undefined for a missing file and throws on malformed JSON', async () => {
    expect(await readAuthFile(join(directory, 'missing.json'))).toBeUndefined()
    const bad = join(directory, 'bad.json')
    await writeFile(bad, 'not-json')
    await expect(readAuthFile(bad)).rejects.toThrow()
    const array = join(directory, 'array.json')
    await writeFile(array, '[]')
    await expect(readAuthFile(array)).rejects.toThrow('JSON object')
  })
})

describe('usageFromPayload', () => {
  it('extracts weekly remaining percent and reset time from a billing payload', () => {
    const usage = usageFromPayload({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-21T13:44:46.749993+00:00',
          end: '2026-08-28T13:44:46.749993+00:00',
        },
        creditUsagePercent: 7.0,
      },
    })
    expect(usage.weeklyRemainingPercent).toBe(93)
    expect(usage.weeklyResetAt).toBe(new Date('2026-08-28T13:44:46.749993+00:00').toISOString())
  })

  it('reads an omitted usage percent as zero used within a weekly period', () => {
    const usage = usageFromPayload({
      config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-08-28T00:00:00Z' } },
    })
    expect(usage.weeklyRemainingPercent).toBe(100)
  })

  it('degrades to an empty view for malformed payloads', () => {
    expect(usageFromPayload(undefined)).toEqual({})
    expect(usageFromPayload({})).toEqual({})
    expect(usageFromPayload({ config: { creditUsagePercent: 'many' } })).toEqual({})
  })
})

describe('parseLiveModels / liveModelName', () => {
  it('maps listing entries, converts prices, and skips imagine and malformed rows', () => {
    const facts = parseLiveModels({
      data: [
        { id: 'grok-4.6', context_length: 500_000, prompt_text_token_price: 20_000 },
        { id: 'grok-imagine-video' },
        { id: '' },
        { context_length: 5 },
        'not-a-record',
      ],
    })
    expect(facts).toEqual([{ id: 'grok-4.6', contextWindow: 500_000, cost: { input: 2 } }])
    expect(parseLiveModels(undefined)).toEqual([])
    expect(parseLiveModels({ data: 'nope' })).toEqual([])
  })

  it('prettifies discovered model ids', () => {
    expect(liveModelName('grok-4.6')).toBe('Grok 4.6')
    expect(liveModelName('grok-4.20-0309-reasoning')).toBe('Grok 4.20 0309 Reasoning')
  })
})

describe('plugin Config schema', () => {
  it('defaults every field so a bare row mounts the plugin', () => {
    const parse = PluginConfig as unknown as (input: Partial<PluginConfigView>) => PluginConfigView
    const config = parse({})
    expect(config.llmEnabled).toBe(true)
    expect(config.credentialRef).toBe('GROK_OAUTH_TOKEN')
    expect(config.grokCommand).toBe('grok')
    expect(config.displayName).toBe('xAI Grok (subscription)')
    expect(config.baseUrl).toBe('')
    expect(config.timeoutMs).toBe(120_000)
    expect(config.liveModels).toBe(true)
  })
})

describe('GrokAuthAdapter', () => {
  beforeEach(() => { piAiAdapterCalls.length = 0 })

  it('wires the xai catalog route and fails loud without a login', async () => {
    const ctx = new Context()
    void new GrokAuthAdapter(ctx, {
      auth: { credential: async () => undefined },
      credentialRef: credentialRef('GROK_OAUTH_TOKEN'),
      displayName: 'xAI Grok (subscription)',
      baseUrl: '',
      timeoutMs: 120_000,
      liveModels: false,
    })
    expect(piAiAdapterCalls).toHaveLength(1)
    const options = piAiAdapterCalls[0]!
    const profile = options.profiles().get(GROK_ROUTE)
    expect(profile).toBeDefined()
    expect(profile!.piProvider!.id).toBe(GROK_ROUTE)
    expect(profile!.piProvider!.getModels().length).toBeGreaterThan(0)
    await expect(options.resolveApiKey(GROK_ROUTE, profile!)).rejects.toThrow('no usable Grok login')
  })

  it('resolves the coordinator token and can re-point the endpoint', async () => {
    const ctx = new Context()
    void new GrokAuthAdapter(ctx, {
      auth: { credential: async () => ({ accessToken: 'live-token' }) },
      credentialRef: credentialRef('GROK_OAUTH_TOKEN'),
      displayName: 'xAI Grok (subscription)',
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
      timeoutMs: 120_000,
      liveModels: false,
    })
    const options = piAiAdapterCalls[0]!
    const profile = options.profiles().get(GROK_ROUTE)!
    await expect(options.resolveApiKey(GROK_ROUTE, profile)).resolves.toBe('live-token')
    for (const model of profile.piProvider!.getModels()) {
      expect(model.baseUrl).toBe('https://cli-chat-proxy.grok.com/v1')
    }
  })

  it('overlays live-discovered models onto the installed catalog', async () => {
    const ctx = new Context()
    const listing = {
      data: [
        { id: 'grok-99.0', context_length: 500_000, prompt_text_token_price: 20_000, completion_text_token_price: 60_000, cached_prompt_text_token_price: 5_000 },
        { id: 'grok-4.20-0309-non-reasoning', context_length: 1_000_000 },
        { id: 'grok-4.3', context_length: 1_000_000 },
        { id: 'grok-imagine-image' },
      ],
    }
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.x.ai/v1/models')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer live-token')
      return jsonResponse(listing)
    })
    const changed = vi.fn()
    void new GrokAuthAdapter(ctx, {
      auth: { credential: async () => ({ accessToken: 'live-token' }) },
      credentialRef: credentialRef('GROK_OAUTH_TOKEN'),
      displayName: 'xAI Grok (subscription)',
      baseUrl: '',
      timeoutMs: 120_000,
      liveModels: true,
      onCatalogChange: changed,
      fetchImpl: fetchImpl as typeof fetch,
    })
    const profile = piAiAdapterCalls[0]!.profiles().get(GROK_ROUTE)!
    // The first read serves the installed catalog and kicks the fetch.
    const before = profile.piProvider!.getModels().map(model => model.id)
    expect(before).not.toContain('grok-99.0')
    await vi.waitFor(() => { expect(changed).toHaveBeenCalledTimes(1) })
    const after = profile.piProvider!.getModels()
    const ids = after.map(model => model.id)
    expect(ids).toContain('grok-99.0')
    expect(ids).toContain('grok-4.20-0309-non-reasoning')
    expect(ids).not.toContain('grok-imagine-image')
    expect(ids.filter(id => id === 'grok-4.3')).toHaveLength(1)
    const discovered = after.find(model => model.id === 'grok-99.0')!
    expect(discovered.name).toBe('Grok 99.0')
    expect(discovered.contextWindow).toBe(500_000)
    expect(discovered.cost?.input).toBe(2)
    expect(discovered.cost?.output).toBe(6)
    expect(discovered.cost?.cacheRead).toBe(0.5)
    expect(discovered.api).toBe(after.find(model => model.id === 'grok-4.3')!.api)
    const nonReasoning = after.find(model => model.id === 'grok-4.20-0309-non-reasoning')!
    expect(nonReasoning.reasoning).toBe(false)
    // One TTL window: repeated catalog reads never re-fetch.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps pi-ai credential persistence and ambient discovery inert', async () => {
    const injection = grokAuthInjection()
    await expect(injection.credentials.read('xai')).resolves.toBeUndefined()
    await expect(injection.credentials.list()).resolves.toEqual([])
    await expect(injection.credentials.modify('xai', async () => undefined)).rejects.toThrow('disabled')
    await expect(injection.authContext.env('XAI_API_KEY')).resolves.toBeUndefined()
    await expect(injection.authContext.fileExists('/anything')).resolves.toBe(false)
  })
})

describe('GrokAuthService', () => {
  let directory: string
  let ctx: Context

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'grok-auth-service-'))
    ctx = new Context()
  })
  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  function makeService(overrides: Partial<GrokAuthServiceOptions> = {}): GrokAuthService {
    const noSpawn = ((): never => {
      throw new Error('spawn disabled in tests')
    }) as unknown as NonNullable<GrokAuthServiceOptions['spawnImpl']>
    return new GrokAuthService(ctx, {
      authJsonPath: join(directory, 'auth.json'),
      grokCommand: 'grok-test-missing',
      credentialRef: credentialRef('GROK_OAUTH_TOKEN'),
      fetchImpl: vi.fn(async () => jsonResponse({}, 500)) as typeof fetch,
      spawnImpl: noSpawn,
      devicePollMinIntervalMs: 0,
      ...overrides,
    })
  }

  it('describes a missing auth file as unconfigured without failing', async () => {
    const service = makeService()
    const status = await service.status()
    expect(status.configured).toBe(false)
    expect(status.authFileExists).toBe(false)
    expect(status.credentialRef).toBe('GROK_OAUTH_TOKEN')
  })

  it('serves a fresh credential from the CLI file without refreshing', async () => {
    await writeAuthFile(join(directory, 'auth.json'), cliFile())
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500))
    const service = makeService({ fetchImpl: fetchImpl as typeof fetch })
    const credential = await service.credential()
    expect(credential?.accessToken).toBeTruthy()
    expect(credential?.email).toBe('user@example.com')
    expect(fetchImpl).not.toHaveBeenCalled()
    const status = await service.status()
    expect(status.configured).toBe(true)
    expect(status.email).toBe('user@example.com')
    expect(status.authMode).toBe('oidc')
  })

  it('refreshes a near-expiry token through the official endpoint and persists it', async () => {
    const path = join(directory, 'auth.json')
    await writeAuthFile(path, cliFile({
      key: fakeJwt(Math.floor(Date.now() / 1000) + 60),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }))
    const nextToken = fakeJwt(Math.floor(Date.now() / 1000) + 6 * 3600)
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(GROK_OAUTH_TOKEN_URL)
      return jsonResponse({ access_token: nextToken, refresh_token: 'refresh-2', expires_in: 21600 })
    })
    const service = makeService({ fetchImpl: fetchImpl as typeof fetch })
    const credential = await service.credential()
    expect(credential?.accessToken).toBe(nextToken)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(await readFile(path, 'utf8')) as GrokAuthFile
    const entry = persisted[GROK_AUTH_ENTRY_KEY] as GrokAuthEntry
    expect(entry.key).toBe(nextToken)
    expect(entry.refresh_token).toBe('refresh-2')
    expect(entry.email).toBe('user@example.com')
  })

  it('answers undefined when refresh fails, guiding the user to log in', async () => {
    const path = join(directory, 'auth.json')
    await writeAuthFile(path, cliFile({
      key: fakeJwt(Math.floor(Date.now() / 1000) + 60),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }))
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400))
    const service = makeService({ fetchImpl: fetchImpl as typeof fetch })
    await expect(service.credential()).resolves.toBeUndefined()
  })

  it('rejects browser login when the CLI probe failed and reuses a pending device login', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === GROK_OAUTH_DEVICE_CODE_URL) {
        return jsonResponse({
          device_code: 'dev-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://auth.x.ai/activate',
          interval: 1,
          expires_in: 300,
        })
      }
      return jsonResponse({ error: 'authorization_pending' }, 400)
    })
    const service = makeService({ fetchImpl: fetchImpl as typeof fetch })
    await expect(service.login('browser')).rejects.toThrow('not on PATH')
    const first = await service.login('device')
    expect(first).toMatchObject({ started: true, userCode: 'ABCD-1234' })
    const second = await service.login('device')
    expect(second.userCode).toBe('ABCD-1234')
    const status = await service.status()
    expect(status.pendingLogin?.userCode).toBe('ABCD-1234')
  })

  it('adopts approved device tokens into the auth file', async () => {
    const path = join(directory, 'auth.json')
    const approvedToken = fakeJwt(Math.floor(Date.now() / 1000) + 6 * 3600)
    let polls = 0
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === GROK_OAUTH_DEVICE_CODE_URL) {
        return jsonResponse({
          device_code: 'dev-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://auth.x.ai/activate',
          interval: 0.001,
          expires_in: 300,
        })
      }
      polls += 1
      if (polls < 2) return jsonResponse({ error: 'authorization_pending' }, 400)
      return jsonResponse({ access_token: approvedToken, refresh_token: 'ref-1', expires_in: 21600 })
    })
    const service = makeService({ fetchImpl: fetchImpl as typeof fetch })
    await service.login('device')
    await vi.waitFor(async () => {
      const persisted = await readAuthFile(path)
      expect(accessTokenOf(selectAuthEntry(persisted)?.entry)).toBe(approvedToken)
    }, { timeout: 4000 })
    const status = await service.status()
    expect(status.configured).toBe(true)
    expect(status.pendingLogin).toBeUndefined()
  })

  it('answers a best-effort usage view from the billing endpoint', async () => {
    await writeAuthFile(join(directory, 'auth.json'), cliFile())
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain('cli-chat-proxy.grok.com/v1/billing')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toContain('Bearer ')
      expect(headers.get('x-xai-token-auth')).toBe('xai-grok-cli')
      return jsonResponse({
        config: {
          currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-08-28T13:44:46Z' },
          creditUsagePercent: 7,
        },
      })
    })
    const service = makeService({ fetchImpl: fetchImpl as typeof fetch })
    const usage = await service.usage()
    expect(usage.weeklyRemainingPercent).toBe(93)
    expect(usage.weeklyResetAt).toBe(new Date('2026-08-28T13:44:46Z').toISOString())
  })

  it('degrades usage to an empty view when the probe fails', async () => {
    await writeAuthFile(join(directory, 'auth.json'), cliFile())
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503))
    const service = makeService({ fetchImpl: fetchImpl as typeof fetch })
    await expect(service.usage()).resolves.toEqual({})
  })
})
