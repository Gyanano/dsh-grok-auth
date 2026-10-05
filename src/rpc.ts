/** Host dispatcher for the grok-auth plugin's dedicated Connection RPC. */

import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import * as connectionSdk from '@deepseek-ai/dsh-client-connection'
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection'
import type { GrokAuthService } from './grok-auth-service.ts'
import type { GrokAuthLoginMode } from './rpc-contract.ts'
import { GROK_AUTH_RPC_CHANNEL, GROK_AUTH_SHARED_RPC_CHANNEL, GROK_AUTH_SHARED_RPC_PREFIX } from './rpc-contract.ts'
export { GROK_AUTH_RPC_CHANNEL } from './rpc-contract.ts'

interface GrokAuthHostRpc {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
    options: { authority: 'loopback' },
  ): () => Promise<void>
}

export function registerGrokAuthRpc(
  connection: { rpc: GrokAuthHostRpc, fetch?: HostConnectionFetch },
  service: Pick<GrokAuthService, 'status' | 'usage' | 'login'>,
): () => Promise<void> {
  const routes = connection.fetch
  if (routes !== undefined) {
    // The 0.2 WebServer can live outside the plugin's scope. Connection owns
    // authentication and dispatch for exact routes on the shared /api carrier.
    const requestSchema = Reflect.get(connectionSdk, 'clientRequestSchema') as typeof connectionSdk.clientRequestSchema
    const disposers = ['status', 'usage', 'login'].map(endpoint => {
      const method = GROK_AUTH_SHARED_RPC_PREFIX + endpoint
      return routes.register({
        path: `${GROK_AUTH_SHARED_RPC_CHANNEL}/${method}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async request => {
          const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
          if (mediaType !== 'application/json') return new Response('content type must be application/json', { status: 415 })
          let body: unknown
          try {
            body = await request.json()
          } catch {
            return new Response('body is not JSON', { status: 400 })
          }
          const parsed = requestSchema.safeParse(body)
          const rpcId = isRecord(body) && typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
          const result = !parsed.success
            ? badRequest('invalid client-request message')
            : parsed.data.method !== method
              ? badRequest('RPC method does not match endpoint')
              : await handleGrokAuthRpc(service, endpoint, parsed.data.payload, request.signal)
          return Response.json({ type: 'server-response', rpcId, result })
        },
      })
    })
    return async () => { await Promise.all(disposers.map(dispose => dispose())) }
  }
  // 0.1 requires the dedicated channel's loopback policy.
  return connection.rpc.handle(
    GROK_AUTH_RPC_CHANNEL,
    (endpoint, payload, signal) => handleGrokAuthRpc(service, endpoint, payload, signal),
    { authority: 'loopback' },
  )
}

/** Dispatch a decoded Host request without ever exposing token material. */
export async function handleGrokAuthRpc(
  service: Pick<GrokAuthService, 'status' | 'usage' | 'login'>,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<RpcResult<unknown>> {
  if (endpoint === 'status') {
    if (!isRecord(payload) || Object.keys(payload).length !== 0) return badRequest('status expects an empty payload')
    try {
      return { ok: true, value: { status: await service.status() } }
    } catch (error) {
      return internalError(error)
    }
  }
  if (endpoint === 'usage') {
    if (!isRecord(payload) || Object.keys(payload).length !== 0) return badRequest('usage expects an empty payload')
    try {
      return { ok: true, value: { usage: await service.usage(signal) } }
    } catch (error) {
      return internalError(error)
    }
  }
  if (endpoint === 'login') {
    if (!isRecord(payload) || !isLoginMode(payload.mode) || Object.keys(payload).some(key => key !== 'mode')) {
      return badRequest('login expects { mode: "browser" | "device" }')
    }
    try {
      return { ok: true, value: { login: await service.login(payload.mode) } }
    } catch (error) {
      return internalError(error)
    }
  }
  return badRequest(`unknown grok-auth endpoint ${JSON.stringify(endpoint)}`)
}

function badRequest(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function internalError(error: unknown): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoginMode(value: unknown): value is GrokAuthLoginMode {
  return value === 'browser' || value === 'device'
}
