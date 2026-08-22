# Reuse the Grok CLI login state

Status: **accepted**

The official Grok CLI remains the sole primary login authority, and
`dsh-grok-auth` reads and refreshes that live state (`~/.grok/auth.json`)
instead of creating a second OAuth store. The document is keyed by
`<issuer>::<client_id>` and carries field aliases across CLI versions
(`key`/`access_token`, `refresh_token`/`refresh`, `expires_at`/`expires`);
reads tolerate every alias and writes land in the spelling the entry already
uses, so the CLI keeps recognising its own file.

All plugin consumers share a Host-side coordinator with in-process
singleflight, version-bound file snapshots, a DSH cross-process lock, and
proactive refresh ahead of the ~6-hour token expiry. OAuth network I/O runs
outside the lock; a successful reply is applied only while the refresh-token
lineage still matches the decision snapshot, and a newer document written by
the CLI is adopted instead.

The DSH lock serializes on a plugin-owned sibling (`auth.json.dsh.lock`), not
on `auth.json.lock`: the official CLI keeps a persistent `pid:epoch` lock file
of its own there that dsh-atomic-write would treat as permanently contended.
The CLI therefore does not participate in the plugin lock, and the guarantee
is fail-closed recovery rather than absolute cross-client serialization — the
same posture dsh-codex-auth accepted for the Codex CLI.

Login is two doors over one authority: browser mode spawns the official
`grok login` (the CLI owns the whole PKCE flow and writes its own file), and
device mode runs the RFC 8628 flow against `auth.x.ai` inside the Host —
using the same public client id the CLI ships — because a spawned TUI with
detached stdio cannot show a device code, while the settings card can. Device
logins are folded into the CLI's own document so both doors land in one state.

An independent Harness-owned OAuth store was rejected because it requires a
second login and duplicates the CLI authority. Access-token-only reuse was
rejected because an idle CLI would leave the Harness with an expired ~6-hour
token and no reliable service.
