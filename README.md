# aula-mcp

MCP server (stdio) for [Aula](https://www.aula.dk), the Danish school and daycare platform. It logs in with MitID over plain HTTP (no browser), keeps itself logged in with refresh tokens, and gives an LLM client compact, family-centred tools: today's digest, check-in status and pick-up plans, calendar, messages, posts, notifications, weekly plans and homework from every vendor widget, photos and attachments.

Built after reading the existing implementations in full: [Casperjuel/aula-mcp](https://github.com/Casperjuel/aula-mcp) (the MitID login is ported from it, MIT), [scaarup/aula](https://github.com/scaarup/aula), [miklen/aula_mcp](https://github.com/miklen/aula_mcp), [ilenhart/aula-mcp-server](https://github.com/ilenhart/aula-mcp-server), madslundt/aula-mcp-ha and fhvilshoj/aula-mcp. See [docs/DESIGN.md](docs/DESIGN.md) for what it does differently and why.

## What is different

- **Children by name.** Every tool takes `child: "Ørn"` (case, prefix and æøå insensitive, refuses to guess between same-name siblings) or nothing for all children. The server maps names to the five different ids Aula and the vendors want.
- **Local time everywhere.** Aula's calendar answers in UTC; everything shown is Europe/Copenhagen, and "today"/"this week" are local.
- **Small answers.** Plain text, HTML converted once, no raw payloads, per-call size budget that says what it left out. A week of calendar for two children is a few kilobytes, not 200.
- **One weekly-plan tool.** `aula_weekplan` merges EasyIQ (ugeplan, SkolePortal, lektier), Meebook, Min Uddannelse (ugebrev, opgaver) and Systematic Huskelisten, routed by the widgets the account has.
- **Self-healing session.** Timeouts, retries on reads, refresh-and-retry on auth errors, API version bump on 410 with the request replayed, profile-context bootstrap, cross-process refresh lock.
- **Safer by default.** stdio only; tokens encrypted at rest with the key in the Keychain; downloads by reference only (no model-supplied URLs), Aula hosts only; write tools off unless enabled, annotated as destructive.

## Install

```sh
git clone https://github.com/thrugz/aula-mcp.git
cd aula-mcp
npm install
npm run build
```

## Log in (once, then it refreshes itself)

```sh
AULA_MITID_USERNAME=<your MitID user ID> node dist/index.js login
```

Open the MitID app and scan the QR code shown in the terminal (it alternates between two frames, like on the web), or type the code it shows. If your MitID has several identities you pick one. Code token users: `--method token` asks for the six digits and the password.

`node dist/index.js status` shows the children and the enabled sources; `node dist/index.js doctor` calls every endpoint once and reports what works.

The interactive login must run from a home connection: STIL's bot protection blocks it from datacenter IPs. Refresh only talks to `login.aula.dk` and works anywhere, so to run on a server, log in at home and copy `~/.config/aula-mcp/tokens.enc` with the same `AULA_MCP_KEY`.

## Register with Claude Code

```sh
claude mcp add aula -- node /path/to/aula-mcp/dist/index.js
```

Any MCP client that runs stdio servers works the same way: the command is `node /path/to/aula-mcp/dist/index.js`.

## Tools

| Tool | What it answers |
| --- | --- |
| `aula_status` | Logged in? Children, institutions, classes, enabled weekly-plan sources |
| `aula_today` | One day at a glance: check-in or plan, events, plan items and homework, unread messages and posts |
| `aula_presence` | Checked in now (present, sick, gone home, at a location...) and the drop-off/pick-up plan |
| `aula_calendar` | Lessons and events in local time; substitutes, moved lessons, replies needed; `eventId` for full details |
| `aula_messages` | Threads with unread flag; `unreadOnly` and `query` scan past the first page |
| `aula_thread` | One thread as text, with attachment ids |
| `aula_posts` | News feed posts as text |
| `aula_notifications` | Notification feed |
| `aula_weekplan` | Weekly plan, homework, weekly letters, reminders from every vendor, merged |
| `aula_gallery` | Albums and photos |
| `aula_download` | Save an attachment or photo by reference; returns the local path |
| `aula_report_sick` | Report a child sick today, or undo it (write) |
| `aula_set_pickup` | Set drop-off/pick-up for a date, optionally weekly (write) |
| `aula_mark_read` | Mark a thread read (write) |

Write tools are registered only with `AULA_ENABLE_WRITE=1`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AULA_MITID_USERNAME` | | MitID user ID for `login` |
| `AULA_MCP_KEY` | macOS Keychain item `aula-mcp`/`token-key` (created on first login) | Token encryption key: 64 hex chars, or a passphrase (scrypt) |
| `AULA_MCP_KEYCHAIN` | default keychain | Keychain file for the key item |
| `AULA_MCP_NO_KEYCHAIN=1` | | Use a `key` file (0600) instead of the Keychain |
| `AULA_MCP_DIR` | `~/.config/aula-mcp` | Tokens (`tokens.enc`), `state.json`, lock |
| `AULA_MCP_DOWNLOAD_DIR` | `$AULA_MCP_DIR/downloads` | Where `aula_download` saves files |
| `AULA_ENABLE_WRITE=1` | off | Register the write tools |
| `AULA_MCP_DEBUG=1` | off | Request log on stderr, tokens redacted |

## Status of the parts

Verified by tests (71, `npm test`): the MitID SRP math against the Python reference's golden vectors and against a simulated MitID server; the whole login chain against a simulated Aula/broker/NemLog-in/MitID (identity picker, first-broker-login redirects, confirmation page, S4-only accounts, bot defense); token encryption, rotation and the refresh lock; the API client's version bump, bootstrap and refresh paths; time zones and ISO weeks; the MCP surface.

Verified live: the real chain from Aula's authorize endpoint to the MitID identity claim, from Node on macOS.

Not yet verified live (needs a MitID approval): the steps after the app approval, and the shape of each Aula and vendor response on a real account. The vendor request shapes follow the upstream code that is in use; where Casperjuel and scaarup disagree (EasyIQ child ids, the SkolePortal `x-login` value, Huskelisten `children`), this follows Casperjuel's released version. Gallery and notification shapes are read defensively. `aula-mcp doctor` is the first thing to run after logging in.

## About

Made by [Skarnlabs](https://skarnlabs.dk) in Denmark, shared for the Danish community.

## Licence

MIT. The MitID/UniLogin login code is ported from Casperjuel/aula-mcp (MIT, copyright Casper Juel), see [LICENSE](LICENSE).
