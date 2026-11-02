# aula-mcp design

A stdio MCP server for Aula (the Danish school and daycare platform), written for
one family's guardian account and an LLM client such as Claude Code.

It builds on six existing implementations, read in full before writing this:
Casperjuel/aula-mcp (TypeScript/Bun, the most complete), its fork
madslundt/aula-mcp-ha, scaarup/aula (Python Home Assistant integration, the
reference everyone ports from), miklen/aula_mcp (Python), ilenhart/aula-mcp-server
(TypeScript, browser based) and fhvilshoj/aula-mcp (Python, dead UniLogin flow).

## What "better" means here

| Problem in prior art | This server |
| --- | --- |
| Bun-only server, monorepo of four packages | One Node package, `tsc` build, stdio |
| The model must call `discover`, then copy numeric child ids, institution codes and unilogin ids into every call (Casperjuel) | Every tool takes `child` as a name (case and diacritic insensitive, prefix match, explicit ambiguity error). Default is all children. The server resolves every id and vendor key itself |
| Calendar times are UTC but documented as Copenhagen, so lessons read 1 to 2 h early (Casperjuel #102/#103/#105, unmerged) | All times are converted to Europe/Copenhagen before output, windows are computed in Copenhagen, ISO weeks use the ISO year |
| Outputs of 94k to 217k characters (raw vendor payloads, full calendar events, html and plain bodies, pretty JSON) | Compact text output, HTML converted to text once, no raw payloads, per-tool size budget with an explicit "narrow the query" note |
| One tool per vendor; the model guesses which applies | One `aula_weekplan` tool. The server routes per child by detected widget, merges all sources and reports per-source warnings |
| No timeouts, no retries, no refresh on 401, version re-probed every process, profile-context bootstrap only before POSTs (#109) | Request timeouts, bounded retries on idempotent reads, refresh and retry once on auth failure, persisted API version, bootstrap before every session's first call |
| Refresh tokens rotate with no cross-process lock; non-atomic token writes; Keychain secret passed in argv; plaintext cookie jar | Encrypted token file written atomically (tmp + rename, 0600), key from env or Keychain (fed through stdin, never argv), refresh under a lock file, no cookie jar persisted |
| Model-supplied download URLs (SSRF), arbitrary local path reads (Casperjuel, ilenhart) | Attachments are fetched only by reference to an item the server lists itself, host allowlist, redirects re-validated, streamed size cap, scoped output dir |
| No tool annotations, errors returned as success | `readOnlyHint` on reads, `destructiveHint` on writes, failures returned with `isError` and a hint |
| Unread messages invisible past page 1 (Casperjuel #81) | `unreadOnly` scans pages up to a bound and says when it stopped early |
| Calendar range over 50 days fails silently (scaarup #380) | Ranges are chunked to 50 days and deduplicated |
| One lesson per co-teacher shows as duplicates (scaarup #379) | Lessons deduplicated by child, title and time, teachers merged |

## Scope

Read tools (always on):

| Tool | Purpose |
| --- | --- |
| `aula_status` | Login state, token expiry, children with institutions, detected sources |
| `aula_today` | Digest for one day: presence, events, unread messages, new posts, homework due |
| `aula_presence` | Check-in status now, and the planned drop-off/pick-up for a date range |
| `aula_calendar` | Events for a range, or full details for one event |
| `aula_messages` | List or search threads, unread-only scan |
| `aula_thread` | Read one thread as text |
| `aula_posts` | News feed posts |
| `aula_notifications` | Notification feed |
| `aula_weekplan` | Weekly plan, homework, weekly letters and reminders from every vendor widget |
| `aula_gallery` | Albums and media metadata |
| `aula_download` | Save an attachment or photo listed by another tool to a local file |

Write tools (only with `AULA_ENABLE_WRITE=1`):

| Tool | Purpose |
| --- | --- |
| `aula_report_sick` | Report a child sick, or undo it when the child is currently reported sick |
| `aula_set_pickup` | Set the drop-off/pick-up plan for a child and date |
| `aula_mark_read` | Move a thread's read marker to its latest message |

Out of scope for v1: sending or replying to messages (no one has captured the
endpoint), event RSVP, vacation registration, HTTP transport (stdio only keeps the
attack surface at zero; tokens can be moved to a server with the encrypted file).

## Auth

Pure HTTP, no browser. Ported from Casperjuel/aula-mcp (MIT), which ported
scaarup/aula. Chain: Aula OIDC (PKCE, mobile client) through the UniLogin broker
to NemLog-in and the MitID core client (custom SRP-6a), back by SAML to Aula, then
a code exchange. Interactive login is a CLI command (`aula-mcp login`) that shows
the MitID QR or OTP in the terminal. The server itself only refreshes.

Fixes over the port source: timeouts on every request, multi-hop redirect after
post-broker-login, bot-defense detection on every hop, refresh-token rotation
under a lock, typed `reauth_required` error with the exact command to run.

STIL blocks the interactive login from datacenter IPs. Log in on a home
machine; refresh talks only to `login.aula.dk` and works anywhere.

## Storage

`~/.config/aula-mcp/` (override `AULA_MCP_DIR`), directory 0700:

- `tokens.enc`: AES-256-GCM of the token record, written atomically, 0600.
- `state.json`: non-secret cache (API version, last login time).
- `refresh.lock`: held while refreshing.

Encryption key, first match wins: `AULA_MCP_KEY` (64 hex chars, or a passphrase run
through scrypt); macOS Keychain item `aula-mcp` / `token-key` (created on first
login, written through `security -i` on stdin); `key` file 0600 (other platforms).

## Aula API notes the code relies on

- One RPC endpoint: `https://www.aula.dk/api/v{N}/?method=<ns.method>&access_token=<jwt>`.
  An `Authorization` header as well gives 400. Retired versions answer 410.
- `profiles.getProfileContext&portalrole=guardian` must run before POSTs and several
  GETs in a session (otherwise 403, code 10, subCode 23).
- POSTs send `csrfp-token` from the `Csrfp-Token` cookie when present.
- Envelope `{status:{code,message,subCode}, data}`; HTTP 200 can carry `status.code` 403
  (sensitive thread needs step-up, calendar range over 50 days).
- Ids: `children[].id` is the institution profile id (presence, calendar, templates);
  `children[].userId` is the unilogin id vendors want; guardian `userId` comes from the
  profile context.
- Widget tokens: `aulaToken.getAulaToken&widgetId=<id>`, short lived, vendors may report
  expiry as HTTP 200 with a message.
