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
- Sends no token value over the plugin-owned Connection RPC endpoints.
  DSH 0.1 uses `/grok-auth` with its loopback policy; DSH 0.2 uses
  `/api/grok-auth/*` and authenticates calls
  through the operator Connection.

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
construction pi-ai's own xAI subscription login uses. Wire protocols, tool
calls, and streaming all remain provider-owned.

### Live model discovery

The installed pi-ai catalog is a static snapshot pinned by the harness's
pi-ai version, so newly released Grok models are missing until pi-ai
upgrades. With `liveModels` on (the default), the plugin overlays the
account's real `GET api.x.ai/v1/models` listing: chat models the catalog
does not ship (grok-4.6, the grok-4.20 family, …) are synthesized from a
curated catalog template with live context windows and pricing, and the
route re-announces itself when the discovered set changes. Curated entries
are never modified, and `grok-imagine-*` media models are skipped.

### Weekly usage

The settings card shows a best-effort weekly credit snapshot from the Grok
proxy backend:

```text
GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
```

A failure of any kind degrades to dashes; it never blocks login or requests.

## Requirements

- DeepSeek Harness Desktop `0.2.0-rc.2` or compatible `0.2.x`, or WebUI
  `0.1.1-rc.1` and compatible `0.1.x`. Desktop requires plugin `0.1.3` or later.
- Node.js `^22.19.0` or `>=24.0.0`.
- A SuperGrok / X Premium subscription.
- Either the official `grok` CLI on `PATH` (run `grok login` once), or use the
  device-code login from the Grok Auth card.

## Install in Desktop

1. Open **Plugins → Add plugin** in DeepSeek Harness Desktop.
2. Set **Installation source** to the official npm registry (or a working npm
   mirror). This controls dependency downloads; do not put the release tarball
   URL in the custom registry field.
3. Paste this prebuilt package URL into **Package name or address** and click **Install**:

   ```text
   https://github.com/Gyanano/dsh-grok-auth/releases/download/v0.1.4/dsh-grok-auth-0.1.4.tgz
   ```

4. Choose **Enable now**. Confirm that `llm-grok-auth` is active, then open
   **Settings → Grok Auth**.

To upgrade an existing installation, uninstall it, install the new package,
then quit and reopen DeepSeek Harness. Replacing a package can leave the
running process using its cached module generation.

The package includes built artifacts, so users need neither a checkout nor a
local build. For local development, run `pnpm install` and `pnpm pack`, then
enter the generated tarball's absolute path instead. Desktop manages its own
profile, so adding a package to the CLI's `web` profile does not install it
in Desktop. Prebuilt tarballs need no plugin build-script permission.

### Windows CLI login and troubleshooting

The default `grok` command searches the desktop process's PATH, then
`%USERPROFILE%\.grok\bin\grok.exe`. An explicit `grokCommand` path remains
supported. Fully quit and reopen Harness after installing the CLI; closing
its window may only hide the application.

CLI and device-code login share the auth file. The `oidc` status does not
identify which flow created it. To switch accounts or perform CLI browser
login again, fully quit Harness and run `grok logout`, then `grok login --oauth`
in PowerShell. Reopen Harness and refresh Grok Auth. There is no separate
plugin logout button. Grok Auth and session errors show sanitized failure
summaries; do not share tokens or the complete auth file.

## Install a prebuilt release in WebUI

The release package includes prebuilt Host and browser bundles, so no
install-time build permission is required:

```sh
dsh plugin --profile web add https://github.com/Gyanano/dsh-grok-auth/releases/latest/download/dsh-grok-auth-latest.tgz
```

To pin a specific version, use its versioned asset from the
[releases page](https://github.com/Gyanano/dsh-grok-auth/releases), e.g.
`releases/download/v0.1.2/dsh-grok-auth-0.1.2.tgz`.

Restart `dsh web`, open Settings, and select **Grok Auth**.

## Install from GitHub source

```sh
dsh plugin --profile web add github:Gyanano/dsh-grok-auth
```

Git dependencies are built by the package's `prepare` script, and pnpm 10+
blocks that script until explicitly allowed — so **the first run is expected
to stop** with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. (pnpm's own hint
mentions `onlyBuiltDependencies`; dsh reads the allowlist from `allowBuilds`
instead.) Add this to `~/.dsh/profiles/web/pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-grok-auth: true
```

then run the same command again. Only grant this permission after reviewing
the source. For a reproducible install, pin a release tag or commit:

```sh
dsh plugin --profile web add github:Gyanano/dsh-grok-auth#v0.1.2
```

## Install a tarball

```sh
git clone https://github.com/Gyanano/dsh-grok-auth.git
cd dsh-grok-auth
pnpm install
pnpm pack
dsh plugin --profile web add ./dsh-grok-auth-0.1.4.tgz
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
| `liveModels` | `true` | Overlay the installed catalog with the account's live model listing |

Do not also add an `xai` entry under `llm-pi-ai.providers`; duplicate route
ownership is rejected with an explicit diagnostic.

## Security and limitations

- Token values never enter the browser, settings, logs, session events, or
  tool metadata. Only Host-side requests receive authorization headers.
- Status may include the account email and auth mode recorded by the CLI;
  these are identity/status facts, not credentials.
- Refresh writes preserve unknown fields and atomically replace the auth file
  with owner-only (`0600`) permissions.
- DSH 0.1 restricts the status/login RPC channel to loopback authorities.
  DSH 0.2 authenticates every channel through the operator Connection.
- The official CLI does not participate in the plugin's writer lock; the
  guarantee is fail-closed recovery (lineage checks, newer-state adoption)
  rather than absolute cross-client serialization.
- The public OAuth client id belongs to the official Grok CLI; xAI has not
  promised its long-term availability to third parties.

## Development

```sh
pnpm install
pnpm run check
pnpm run package:install-smoke
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
