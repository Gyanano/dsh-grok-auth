# dsh-grok-auth

English | [中文](README.zh.md)

A self-contained [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
**Grok Auth** plugin. It reuses the xAI OAuth login maintained by the official
**Grok CLI** (`~/.grok/auth.json`, or `$GROK_HOME/auth.json`) for:

- the `xai` LLM route (Grok 4.x models over `api.x.ai`, paid for by the
  SuperGrok / X Premium subscription instead of an `xai-…` API key);
- one native **Grok Auth** Settings section with login status, best-effort
  weekly credit usage, and both login flows.

> **⚠️ Unofficial channel — personal development only.** The account-gated
> subscription surface (`auth.x.ai` public CLI client, `cli-chat-proxy.grok.com`
> billing) is unsupported, revocable, and may be rate-limited or changed
> without notice. Do not rely on it for production workloads.

## Features

### Shared Grok Login State

- Uses one Host-only auth coordinator for every authenticated operation.
- Resolves credentials through version-bound auth-file snapshots, a short-lived
  in-memory cache, and proactive refresh ahead of the ~6-hour token expiry.
- Coalesces concurrent refreshes in-process and uses short cross-process lock
  sections before and after OAuth network I/O; a reply is persisted only while
  the refresh-token lineage still matches. The DSH lock lives on a plugin-owned
  sibling (`auth.json.dsh.lock`) because the official CLI keeps a persistent
  lock file of its own at `auth.json.lock`.
- Tolerates auth-file field aliases across Grok CLI versions
  (`key`/`access_token`, `refresh_token`/`refresh`, `expires_at`/`expires`)
  and writes back the spelling the file already uses.
- Sends no token value over the plugin-owned, loopback-only `/grok-auth`
  Connection RPC channel.

### Two login flows, one authority

- **Browser login** spawns the official `grok login`; the CLI owns the whole
  PKCE flow and writes its own auth file.
- **Device-code login** runs RFC 8628 against `auth.x.ai` inside the Host
  (same public client id the CLI ships) and shows the user code and
  verification link right on the settings card — no CLI required, works on
  headless machines. Approved tokens are folded into the CLI's own document.

### LLM route

The `xai` route wraps the installed pi-ai `xai` catalog provider
(`https://api.x.ai/v1`, OpenAI-compatible protocols). The subscription OAuth
access token is injected per request as the Bearer credential — the same
construction pi-ai's own xAI subscription login uses. Model catalog, wire
protocols, tool calls, and streaming all remain provider-owned.

### Weekly usage

The settings card shows a best-effort weekly credit snapshot from the Grok
proxy backend:

```text
GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
```

A failure of any kind degrades to dashes; it never blocks login or requests.

## Requirements

- DeepSeek Harness `0.1.1-rc.1` or a compatible later `0.1.x` release.
- Node.js `^22.19.0` or `>=24.0.0`.
- A SuperGrok / X Premium subscription.
- Either the official `grok` CLI on `PATH` (run `grok login` once), or use the
  device-code login from the Grok Auth card.

## Install from GitHub source

```sh
dsh plugin --profile web add github:Gyanano/dsh-grok-auth
```

Git dependencies are built by the package's `prepare` script. pnpm 10+ blocks
that script until explicitly allowed, so the first command may print an
`allowBuilds` key and stop; copy the exact key printed by dsh under
`allowBuilds` in `~/.dsh/profiles/web/pnpm-workspace.yaml`, then run the
command again. Only grant this permission after reviewing the source.

## Install a tarball

```sh
git clone https://github.com/Gyanano/dsh-grok-auth.git
cd dsh-grok-auth
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-grok-auth-0.1.0.tgz
```

Restart `dsh web`, open Settings, and select **Grok Auth**.

## Host configuration

The bundle patch activates one Host row:

| Row | Export | Purpose |
|---|---|---|
| `llm-grok-auth` | `dsh-grok-auth` | Shared auth coordinator and the `xai` LLM route |

All fields are optional. Set `llmEnabled: false` to keep the shared Login
State coordinator available without owning an LLM route:

| Field | Default | Meaning |
|---|---|---|
| `llmEnabled` | `true` | Register the `xai` LLM route |
| `authJsonPath` | `''` → `$GROK_HOME`/`~/.grok/auth.json` | Grok auth file |
| `credentialRef` | `GROK_OAUTH_TOKEN` | Value-free reference shown by the card |
| `refreshLeadMs` | `300000` | Refresh lead time in milliseconds (the CLI's own default) |
| `grokCommand` | `grok` | CLI command used for browser login and version probing |
| `displayName` | `xAI Grok (subscription)` | Provider label in model selectors |
| `baseUrl` | `''` | Endpoint override; empty keeps the catalog's `api.x.ai/v1` |
| `timeoutMs` | `120000` | Request timeout in milliseconds (`0` disables it) |

Do not also add an `xai` entry under `llm-pi-ai.providers`; duplicate route
ownership is rejected with an explicit diagnostic.

## Security and limitations

- Token values never enter the browser, settings, logs, session events, or
  tool metadata. Only Host-side requests receive authorization headers.
- Status may include the account email and auth mode recorded by the CLI;
  these are identity/status facts, not credentials.
- Refresh writes preserve unknown fields and atomically replace the auth file
  with owner-only (`0600`) permissions.
- The status/login RPC channel is restricted to loopback authorities.
- The official CLI does not participate in the plugin's writer lock; the
  guarantee is fail-closed recovery (lineage checks, newer-state adoption)
  rather than absolute cross-client serialization.
- The public OAuth client id belongs to the official Grok CLI; xAI has not
  promised its long-term availability to third parties.

## Development

```sh
pnpm install
pnpm run check
```

`pnpm run build` emits:

- `lib/index.js` — Auth / LLM Host plugin;
- `lib/invariant.js` — invariant companion;
- `lib/client.js` — loader-compatible browser plugin with inline CSS Modules;
- `lib/types/**` — declarations.

See the [architecture decision](docs/adr/0001-reuse-grok-cli-login-state.md).

## Acknowledgements

Architecture modelled on
[dsh-codex-auth](https://github.com/suntianc/dsh-codex-auth); the device-code
flow mirrors pi-ai's own xAI OAuth implementation.
