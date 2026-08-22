# Changelog

## [0.1.2] - 2026-08-22

### Added

- Tag-driven release pipeline: pushing a `vX.Y.Z` tag runs the full check,
  packs the plugin, and publishes a GitHub release with the versioned tarball
  plus a stable `dsh-grok-auth-latest.tgz` alias, so the README's
  prebuilt-install link never goes stale. The workflow refuses a tag that
  does not match `package.json`.
- README install guidance now leads with the prebuilt release (no
  build-script permission needed) and gives the exact `allowBuilds` snippet
  for `github:` source installs.

## [0.1.1] - 2026-08-22

### Added

- Live model discovery (`liveModels`, default on): the account's real
  `GET api.x.ai/v1/models` listing overlays the installed pi-ai catalog, so
  models the pinned pi-ai version does not ship yet (grok-4.6, the grok-4.20
  family, …) appear in the selector with live context windows and pricing.
  Curated catalog entries are never modified; chat-irrelevant
  `grok-imagine-*` models are skipped, and the route re-announces itself when
  discovery changes the model set.

## [0.1.0] - 2026-08-22

### Added

- Shared Grok Login State coordinator over the official Grok CLI auth file
  (`~/.grok/auth.json`, or `$GROK_HOME/auth.json`): version-bound snapshots,
  an in-memory credential cache, in-process singleflight, cross-process lock
  sections around refresh commits, and proactive background refresh through
  the official `auth.x.ai` token endpoint.
- `xai` LLM route wrapping the installed pi-ai xai provider, with the
  subscription OAuth access token injected per request.
- Browser login through the official `grok login` flow and a Host-run
  RFC 8628 device-code login that surfaces only the user code and
  verification link.
- **Grok Auth** settings section with value-free status facts, best-effort
  weekly credit usage, and login controls; zh/en copy.
- Loopback-only `/grok-auth` Connection RPC channel that never carries token
  values.
