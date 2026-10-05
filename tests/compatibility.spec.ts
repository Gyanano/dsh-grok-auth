import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import * as host from '../src/index.ts'
import { createGrokAuthRpcClient } from '../src/rpc-contract.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('desktop compatibility', () => {
  it('passes the desktop installer version gate without an exemption', () => {
    expect(evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.2')).toBeUndefined()
  })

  it('does not request removed client modules', () => {
    expect(manifest.dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-runtime')
    expect(manifest.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-host-apiproxy')
  })

  it('serves settings RPC when WebServer is outside the plugin scope', async () => {
    const ctx = new Context()
    const directory = mkdtempSync(join(tmpdir(), 'grok-rpc-'))
    ctx.provide('llm', {})
    const connection = new HostConnectionService(ctx, [], {
      isAuthenticated: () => true,
    } as unknown as ConstructorParameters<typeof HostConnectionService>[2])
    const carrier = connection.createSharedFetchHandler('/api')
    const call = async (channel: string, method: string, payload: unknown) => carrier.fetch(new Request(`http://localhost${channel}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }),
    }))
    try {
      const fiber = ctx.plugin(host, {
        ...host.Config(),
        llmEnabled: false,
        liveModels: false,
        authJsonPath: join(directory, 'missing-auth.json'),
        grokCommand: 'missing-grok-for-test',
      })
      await fiber
      const client = createGrokAuthRpcClient({
        call: async (channel, method, payload) => {
          const response = await call(channel, method, payload)
          expect(response.status).toBe(200)
          return (await response.json()).result
        },
      }, true)
      expect(await client.status()).toMatchObject({ ok: true, value: { status: { configured: false, authFileExists: false } } })
      await fiber.dispose()
      expect((await call('/api', 'grok-auth/status', {})).status).toBe(404)
    } finally {
      await ctx.fiber.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('resolves a Grok model through the installed PiAiAdapter', async () => {
    const { GrokAuthAdapter } = await import('../src/grok-auth-adapter.ts')
    const ctx = new Context()
    try {
      const adapter = new GrokAuthAdapter(ctx, {
        auth: { credential: async () => undefined },
        credentialRef: credentialRef('GROK_OAUTH_TOKEN'),
        displayName: 'Grok',
        baseUrl: '',
        timeoutMs: 120_000,
        liveModels: false,
      })
      const models = await adapter.listModels('xai')
      expect(models.length).toBeGreaterThan(0)
      const model = await adapter.resolveModel('xai', models[0]!.id)
      expect(model.id).toBe(models[0]!.id)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
