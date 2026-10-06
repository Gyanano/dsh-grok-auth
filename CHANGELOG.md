# Changelog

## [0.1.5] - 2026-10-05

### Added

- Read the current user's enabled Windows static system proxy when no
  HTTP_PROXY / HTTPS_PROXY is configured, allowing Desktop model and OAuth
  requests to use tools such as Clash Verge without TUN mode.
- Add `proxyUrl` for an explicit HTTP(S) proxy and `systemProxy` (default true)
  to control Windows discovery. Explicit configuration takes precedence over
  environment variables, which retain precedence over system settings.
- Support shared and per-protocol Windows proxy addresses, wildcard bypasses,
  and `<local>`. Keep loopback requests direct and preserve NO_PROXY behavior.
- Initialize routing before auth/model services and restore the previous host
  dispatcher when the plugin unloads. Proxy diagnostics omit addresses and
  credentials. PAC/WPAD automatic configuration remains unsupported.
- Test native HTTP and HTTPS requests through a local proxy, plus real
  PowerShell registry reads and HTTPS routing on Windows CI.

## [0.1.4] - 2026-10-05

### Fixed

- Find the standard Windows `~/.grok/bin/grok.exe` installation when the
  desktop process does not inherit the terminal's PATH. Preserve explicit
  command overrides and prefer executables on the inherited PATH.
- Use the resolved executable for both version probing and browser login,
  request OAuth explicitly, and wait for the login process to start.
- Show sanitized credential and CLI failures in Grok Auth settings and
  include the credential failure in session errors. A failed credential
  resolution no longer continues to display a green login status.
- Add a Windows CI job with a real executable probe outside PATH, alongside
  RPC and desktop compatibility tests.

## [0.1.3] - 2026-10-05

### Fixed

- Accept DeepSeek Harness Desktop `0.2.0-rc.2` without a version exemption,
  while retaining the `0.1.1-rc.1` compatibility range.
- Replace removed Client Runtime and Host API Proxy SDK references with the
  renderer's context declarations and Connection's shared RPC result type.
- Supply the new pi-ai model diagnostic map and support both refresh icon names.
- Register settings RPC on Connection's shared `/api` carrier in `0.2`, avoiding
  HTTP 405 when the desktop WebServer is outside the plugin's service scope.
  Retain the dedicated loopback channel on `0.1`.
- Test the installer's real version gate and model resolution with the current
  SDK; validate the version gate on the packed artifact as well.

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
