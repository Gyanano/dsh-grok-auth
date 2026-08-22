# Changelog

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
