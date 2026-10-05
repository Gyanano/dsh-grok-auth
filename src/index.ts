/**
 * Grok-auth login plugin, host half. Mounts:
 *
 * - an LLM adapter owning the `xai` provider route, wrapping the installed
 *   pi-ai xai provider (api.x.ai, OpenAI-compatible protocols) with the xAI
 *   OAuth access token resolved live from the Grok CLI's auth file;
 * - the `grokAuth` service: login status (value-free), login-flow startup
 *   (official CLI or Host-run device code), and best-effort weekly usage for
 *   the web surface.
 *
 * The credentials seam is deliberately untouched: it is single-provider by
 * design, and the Grok token is not a key the harness should store or
 * describe — it lives in the Grok CLI's own file, refreshed by this plugin
 * through the official auth.x.ai endpoint.
 *
 * @module dsh-grok-auth
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { DEFAULT_REFRESH_LEAD_MS, defaultAuthJsonPath } from './grok-auth.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS, GROK_ROUTE, GrokAuthAdapter } from './grok-auth-adapter.ts'
import { GrokAuthService } from './grok-auth-service.ts'
import { installEnvHttpProxy } from './env-proxy.ts'
import { registerGrokAuthRpc } from './rpc.ts'

export const name = 'llm-grok-auth'
export const inject = ['llm']

/** Plugin configuration; every field has a default, so a bare row mounts the plugin. */
export interface Config {
  /** Whether this row owns the xai LLM route; auth coordination remains available when false. */
  llmEnabled: boolean
  /** Grok auth file path; empty (default) resolves `$GROK_HOME` or `~/.grok/auth.json`. */
  authJsonPath: string
  /** Credential reference advertised by the status card. */
  credentialRef: string
  /** Lead time before access-token expiry that triggers a refresh. */
  refreshLeadMs: number
  /** The grok CLI command used for browser login and version probing. */
  grokCommand: string
  /** Selector label for the provider route. */
  displayName: string
  /** Endpoint override for the route; empty keeps the installed catalog's api.x.ai endpoint. */
  baseUrl: string
  /** Request timeout in milliseconds; zero disables it. */
  timeoutMs: number
  /** Overlay the installed pi-ai catalog with the account's live api.x.ai model listing. */
  liveModels: boolean
}

export const Config: z<Config> = z.object({
  llmEnabled: z.boolean().default(true),
  authJsonPath: z.string().default(''),
  credentialRef: z.string().default('GROK_OAUTH_TOKEN'),
  refreshLeadMs: z.number().min(0).default(DEFAULT_REFRESH_LEAD_MS),
  grokCommand: z.string().default('grok'),
  displayName: z.string().default('xAI Grok (subscription)'),
  baseUrl: z.string().default(''),
  timeoutMs: z.natural().default(DEFAULT_REQUEST_TIMEOUT_MS),
  liveModels: z.boolean().default(true),
})

/** Mount the grok-auth adapter and service. */
export function apply(ctx: Context, config: Config): void {
  // Without this, Node's fetch ignores the machine's HTTP proxy env and the
  // auth.x.ai / api.x.ai backends are unreachable on proxied networks.
  installEnvHttpProxy((message) => { ctx.logger.warn(String(message)) })
  const credentialReference: CredentialRef = credentialRef(config.credentialRef)
  const authJsonPath = config.authJsonPath.length > 0 ? config.authJsonPath : defaultAuthJsonPath()
  const service = new GrokAuthService(ctx, {
    authJsonPath,
    grokCommand: config.grokCommand,
    credentialRef: credentialReference,
    refreshLeadMs: config.refreshLeadMs,
    fetchImpl: fetch,
  })
  if (config.llmEnabled) {
    if (ctx.llm.listProviders().some(provider => provider.id === GROK_ROUTE)) {
      throw new Error(
        'dsh-grok-auth cannot own the "xai" route because another plugin already registered it; '
        + 'remove the conflicting llm-pi-ai providers.xai row (or set llmEnabled: false here)',
      )
    }
    // Live discovery lands after registration, so the announce hook is wired
    // through a late-bound closure the registration handle then fills in.
    let announceCatalogChange = (): void => {}
    const registration = ctx.llm.registerAdapter([GROK_ROUTE], new GrokAuthAdapter(ctx, {
      auth: service,
      credentialRef: credentialReference,
      displayName: config.displayName,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      liveModels: config.liveModels,
      onCatalogChange: () => { announceCatalogChange() },
    }))
    announceCatalogChange = () => { registration.replace([GROK_ROUTE]) }
  }
  ctx.inject(['connection'], connectionCtx => registerGrokAuthRpc(connectionCtx.connection, service))
  if (config.llmEnabled) {
    ctx.logger.info(
      'llm-grok-auth: route %s serving Grok login from %s (request timeout %sms)',
      GROK_ROUTE, authJsonPath, config.timeoutMs,
    )
  } else {
    ctx.logger.info('llm-grok-auth: shared Grok Login State active at %s; LLM route disabled', authJsonPath)
  }
}
