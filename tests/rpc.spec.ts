/** Contract tests for the dedicated grok-auth Connection RPC. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { handleGrokAuthRpc, registerGrokAuthRpc } from '../src/rpc.ts'
import { createGrokAuthRpcClient } from '../src/rpc-contract.ts'
import type { GrokAuthStatusView, GrokUsageView, GrokLoginStartView } from '../src/rpc-contract.ts'

const status: GrokAuthStatusView = {
  available: true,
  configured: true,
  authMode: 'oidc',
  grokVersion: 'grok 1.0.5',
  tokenExpiresAt: '2026-08-22T22:50:41.000Z',
  createdAt: '2026-08-22T16:50:41.000Z',
  email: 'user@example.com',
  credentialRef: 'GROK_OAUTH_TOKEN',
  authFileExists: true,
}

const usage: GrokUsageView = { weeklyRemainingPercent: 93, weeklyResetAt: '2026-08-28T13:44:46.000Z' }

const loginStart: GrokLoginStartView = {
  started: true,
  userCode: 'ABCD-1234',
  verificationUri: 'https://auth.x.ai/activate',
  expiresInSeconds: 300,
}

function service(overrides: Partial<Record<'status' | 'usage' | 'login', unknown>> = {}) {
  return {
    status: vi.fn(async () => status),
    usage: vi.fn(async () => usage),
    login: vi.fn(async () => loginStart),
    ...overrides,
  } as unknown as Parameters<typeof handleGrokAuthRpc>[0]
}

describe('shared Connection carrier', () => {
  it('dispatches plugin endpoints and rejects invalid envelopes before invoking login', async () => {
    const ctx = new Context()
    const connection = new HostConnectionService(ctx, [], {} as ConstructorParameters<typeof HostConnectionService>[2])
    const backend = service()
    registerGrokAuthRpc(connection, backend)
    const carrier = connection.createSharedFetchHandler('/api')
    const send = (endpoint: string, body: unknown, contentType = 'application/json') => carrier.fetch(new Request(`http://localhost/api/grok-auth/${endpoint}`, {
      method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(body),
    }))
    const message = (endpoint: string, payload: unknown) => ({ type: 'client-request', rpcId: 'rpc-test', method: `grok-auth/${endpoint}`, payload })
    try {
      const client = createGrokAuthRpcClient({ call: async (_channel, endpoint, payload) => {
        const method = endpoint.slice('grok-auth/'.length)
        return (await (await send(method, message(method, payload))).json()).result
      } }, true)
      expect(await client.status()).toEqual({ ok: true, value: { status } })
      expect(await client.usage()).toEqual({ ok: true, value: { usage } })
      expect(await client.login('device')).toEqual({ ok: true, value: { login: loginStart } })
      vi.mocked(backend.login).mockClear()
      for (const body of [{}, message('status', {}), message('login', { mode: 'sms' }), { ...message('login', { mode: 'device' }), rpcId: 42 }]) {
        expect((await (await send('login', body)).json()).result.ok).toBe(false)
      }
      expect(backend.login).not.toHaveBeenCalled()
      expect((await send('login', message('login', { mode: 'device' }), 'text/plain')).status).toBe(415)
      expect((await send('missing', message('missing', {}))).status).toBe(404)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retains the 0.1 loopback channel and policy', async () => {
    const handle = vi.fn(() => async () => {})
    registerGrokAuthRpc({ rpc: { handle } }, service())
    expect(handle).toHaveBeenCalledWith('/grok-auth', expect.any(Function), { authority: 'loopback' })
  })
})

describe('handleGrokAuthRpc', () => {
  it('serves status, usage, and login', async () => {
    expect(await handleGrokAuthRpc(service(), 'status', {})).toEqual({ ok: true, value: { status } })
    expect(await handleGrokAuthRpc(service(), 'usage', {})).toEqual({ ok: true, value: { usage } })
    expect(await handleGrokAuthRpc(service(), 'login', { mode: 'device' })).toEqual({ ok: true, value: { login: loginStart } })
  })

  it('rejects malformed payloads and unknown endpoints', async () => {
    for (const [endpoint, payload] of [
      ['status', { extra: 1 }],
      ['usage', []],
      ['login', {}],
      ['login', { mode: 'sms' }],
      ['login', { mode: 'device', extra: true }],
      ['nope', {}],
    ] as const) {
      const result = await handleGrokAuthRpc(service(), endpoint, payload)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('bad-request')
    }
  })

  it('maps a thrown service failure to an internal error', async () => {
    const failing = service({ status: vi.fn(async () => { throw new Error('boom') }) })
    const result = await handleGrokAuthRpc(failing, 'status', {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('internal')
  })
})

describe('createGrokAuthRpcClient', () => {
  it('round-trips Host replies through the parsing client', async () => {
    const rpc = {
      call: vi.fn(async (_channel: string, endpoint: string) => {
        if (endpoint === 'status') return { ok: true as const, value: { status } }
        if (endpoint === 'usage') return { ok: true as const, value: { usage } }
        return { ok: true as const, value: { login: loginStart } }
      }),
    }
    const client = createGrokAuthRpcClient(rpc)
    expect(await client.status()).toEqual({ ok: true, value: { status } })
    expect(await client.usage()).toEqual({ ok: true, value: { usage } })
    expect(await client.login('device')).toEqual({ ok: true, value: { login: loginStart } })
  })

  it('parses a pending-login status view', async () => {
    const pending: GrokAuthStatusView = {
      ...status,
      configured: false,
      pendingLogin: { userCode: 'ABCD-1234', verificationUri: 'https://auth.x.ai/activate', expiresAt: '2026-08-22T17:00:00Z' },
    }
    const rpc = { call: vi.fn(async () => ({ ok: true as const, value: { status: pending } })) }
    const client = createGrokAuthRpcClient(rpc)
    const result = await client.status()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.status.pendingLogin?.userCode).toBe('ABCD-1234')
  })

  it('flags malformed Host replies instead of surfacing them', async () => {
    const rpc = { call: vi.fn(async () => ({ ok: true as const, value: { status: { available: 'yes' } } })) }
    const client = createGrokAuthRpcClient(rpc)
    const result = await client.status()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('invalid status response')
  })
})
