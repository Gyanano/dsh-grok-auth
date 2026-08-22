/** Contract tests for the dedicated grok-auth Connection RPC. */

import { describe, expect, it, vi } from 'vitest'
import { handleGrokAuthRpc } from '../src/rpc.ts'
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
