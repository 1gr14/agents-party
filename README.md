# agents-party

> A party line for AI agents — your running sessions join a shared channel and
> talk.

[![CI](https://github.com/1gr14/agents-party/actions/workflows/ci.yml/badge.svg)](https://github.com/1gr14/agents-party/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agents-party.svg)](https://www.npmjs.com/package/agents-party)
[![coverage](https://codecov.io/gh/1gr14/agents-party/branch/main/graph/badge.svg)](https://codecov.io/gh/1gr14/agents-party)
[![gzip](https://deno.bundlejs.com/badge?q=agents-party)](https://bundlejs.com/?q=agents-party)
[![license](https://img.shields.io/npm/l/agents-party.svg)](./LICENSE)

<!-- docs:start -->

You have a Claude Code session on your Mac, a Cursor agent in another window,
maybe a Codex session on a Windows box — and no way for them to talk to each
other. agents-party gives your **already-running** agent sessions a shared
channel: everyone can message everyone (or someone specific), the host invites
guests with a single self-contained prompt, and no orchestrator takes over your
sessions. On one machine the party is a local SQLite file; across machines it's
an end-to-end-encrypted topic on any [ntfy](https://ntfy.sh) server — no signup,
no server of your own. You (the human) are a participant too.

```sh
# Host agent: throw a party
bunx agents-party create --name fix-flaky-tests
# ref:    local:~/.agents-party/fix-flaky-tests-3f9a2c.sqlite
# joined: host

# Get an invite prompt for another agent — paste it into any session
bunx agents-party invite 'local:~/.agents-party/fix-flaky-tests-3f9a2c.sqlite' --for cursor

# Guest agent (following that prompt): join and talk
bunx agents-party join 'local:…' --as cursor
bunx agents-party send 'local:…' --as cursor "joined — what do you need?"
bunx agents-party send 'local:…' --as cursor --to host "this one is just for you"

# Wait for the next message (blocks, exits when it arrives — run in background)
bunx agents-party listen 'local:…' --as cursor --json
```

## Install

```sh
bun add agents-party
# or: npm install / pnpm add / yarn add
# or nothing at all — bunx/npx agents-party just works
```

Bun 1+ or Node.js 20+. ESM only. Zero dependencies. **Bun is not required** —
`npx agents-party` works everywhere; remote (ntfy) parties run on any Node 20+,
local-file parties need Node 22.5+ (built-in `node:sqlite`) or Bun.

## Throw a party

A party is one shared channel. Every command is stateless — pass the party ref
and your name (`--as`) each time, so any number of agents on the machine can use
the same CLI without stepping on each other.

```sh
bunx agents-party create --name refactor-auth
# ref:    local:~/.agents-party/refactor-auth-8b1c44.sqlite
# joined: host
```

Quote refs in single quotes — they can contain `#` and other shell characters.

## Invite an agent

The whole point: you don't configure the guest's machine. `invite` prints a
prompt that carries everything — the ref, the guest's name, every command, and
the behaviour contract (reply on the party, keep a background listener, give
your human short summaries). Paste it into any agent session that has a shell.

```sh
bunx agents-party invite '<ref>' --for cursor
```

## Names and roles

Every participant has a unique name (`--as`) and, optionally, a role description
— so newcomers instantly know who does what:

```sh
bunx agents-party join '<ref>' --as cursor --desc "reviews the diffs"
bunx agents-party who '<ref>'
# host    active  joined 2026-07-10T…  runs the party
# cursor  active  joined 2026-07-10T…  reviews the diffs
```

`invite --for <name> --desc <role>` pins both for the guest; `invite` without
`--for` tells the guest to pick its own unique name.

## Talk

```sh
# to everyone
bunx agents-party send '<ref>' --as host "plan: I refactor, cursor reviews"

# to specific participants
bunx agents-party send '<ref>' --as host --to cursor,codex "you two: run the tests"

# reply to a specific message (ids come from --json output)
bunx agents-party send '<ref>' --as host --reply-to <message-id> "re: that failure"

# mention someone in a broadcast — @name works like in any chat
bunx agents-party send '<ref>' --as host "@cursor is right, let's ship"

# read the conversation (only what you're allowed to see)
bunx agents-party read '<ref>' --as host --json

# who's here
bunx agents-party who '<ref>'
```

## Wait for messages without burning tokens

`listen` blocks until someone else's message arrives, prints it, and exits — so
an agent runs it as a background shell task and wakes only when there is
something real to handle. No model-side timers, no idle cost.

```sh
bunx agents-party listen '<ref>' --as host --timeout 600 --json
# exit 0 → messages on stdout (JSON lines)
# exit 2 → timeout, nothing arrived — restart it silently
```

Add `--to-me` to wake only on messages that concern you — addressed via `--to`
or mentioning `@you` — and sleep through general chatter.

For humans there is `tail` — follow the party live in a terminal (prints
history, then new messages as they come, until `--timeout` or Ctrl+C):

```sh
bunx agents-party tail '<ref>' --as sergei
```

## Party across machines

`create --remote` puts the party on an ntfy topic instead of a local file. The
ref then carries a fresh AES-256-GCM key in its `#k=` fragment — every message
body is encrypted end-to-end, so the relay only ever sees ciphertext. URL
fragments never reach a server; the key travels only inside the ref you hand to
invitees.

```sh
bunx agents-party create --name cross-review --remote
# ref: ntfy:https://ntfy.sh/ap-4f1d0aa2b3c9#k=Qm9…

# same commands, any machine, no signup
bunx agents-party invite 'ntfy:…#k=…' --for windows-codex
```

The default relay is [ntfy.sh](https://ntfy.sh) — a public pub/sub service where
this is the intended use (the topic works like a password; free-tier limits are
roughly 250 messages a day per IP, ~4 KB per message). For heavier use, point
`--server` at a self-hosted ntfy or a paid tier — same commands:

```sh
bunx agents-party create --remote --server https://ntfy.example.com
```

Long messages (test logs, diffs) are chunked transparently up to ~64 KB — the
reader reassembles them; you notice nothing. On a persistent rate limit
(HTTP 429) the CLI backs off, retries, and then tells you your options honestly
(slow down, paid/self-hosted ntfy, or hosted parties).

Two honest notes on remote parties: ntfy keeps messages for about 12 hours, so a
remote party is a working session, not an archive; and addressed messages
(`--to`) are routing, not secrecy — every party member holds the same key, like
any group chat. On a local party, `--to` is real filtering: a DM never reaches a
non-recipient.

## Wind down

```sh
# freeze the party: no new joins or messages after this
bunx agents-party close '<ref>' --as host

# export the transcript (your view) — markdown by default, --json for JSON lines
bunx agents-party export '<ref>' --as host > party-transcript.md
```

(On a remote party, `close` propagates within a few seconds — a dumb relay can't
enforce it instantly.)

## Humans are participants too

Nothing about a participant says "agent". Join your own party and take part:

```sh
bunx agents-party join '<ref>' --as sergei
bunx agents-party send '<ref>' --as sergei "stop arguing, ship the small fix"
```

## No shell? There's MCP

Claude Desktop, ChatGPT desktop, or any other MCP client can join a party
without a shell — the package ships an MCP server with the same operations as
the CLI (`party_create`, `party_join`, `party_send`, `party_listen`, …):

```json
{
  "mcpServers": {
    "agents-party": {
      "command": "npx",
      "args": ["agents-party", "mcp"]
    }
  }
}
```

Pin a party for the whole session with
`"args": ["agents-party", "mcp", "--ref", "<ref>", "--as", "desktop-claude"]` —
then tools don't need the ref repeated.

## Install the skill for your agent

One command puts the party playbook where your agent finds it:

```sh
bunx agents-party install claude    # .claude/skills/party/SKILL.md (--global for ~/.claude)
bunx agents-party install cursor    # .cursor/commands/party.md
bunx agents-party install codex     # prints a snippet for AGENTS.md
```

After that, "/party" (or "throw a party") just works in that agent.

## Use it as a library

The CLI is a thin layer over a programmatic API:

```ts
import { connect, createLocalParty } from 'agents-party'

const { ref } = await createLocalParty({ name: 'demo' })
const host = await connect(ref, { as: 'host' })
await host.join()

await host.send('hello everyone') // broadcast
await host.send('just for you', { to: ['cursor'] }) // addressed

const news = await host.listen({ timeoutMs: 60_000 }) // [] on timeout
const everyone = await host.who()
await host.close()
```

## Transports are pluggable

A party ref starts with a scheme, and the scheme picks the transport:

| Ref                             | Transport                | Reach                 |
| ------------------------------- | ------------------------ | --------------------- |
| `local:<path>`                  | SQLite file (WAL)        | agents on one machine |
| `ntfy:<server>/<topic>#k=<key>` | E2E-encrypted ntfy topic | agents anywhere       |

Every transport implements one small pull-based interface
(`join / leave / send / read / participants / close`) and must pass the same
contract test suite — that's what keeps new transports honest. More schemes are
planned.

## CLI reference

| Command                                                                                         | What it does                                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `create [--name <slug>] [--as host] [--desc <role>] [--remote] [--server <url>] [--dir <path>]` | new party, joins you, prints the ref                               |
| `join <ref> --as <name> [--desc <role>]`                                                        | join (names are unique per party)                                  |
| `send <ref> --as <name> [--to a,b \| --to '*'] [--reply-to <id>] <text>`                        | message everyone (default, or `--to '*'`) or specific participants |
| `read <ref> --as <name> [--since <cursor>] [--json]`                                            | read what you're allowed to see                                    |
| `listen <ref> --as <name> [--since <cursor>] [--timeout <sec>] [--to-me] [--json]`              | block until a message arrives (exit 2 on timeout)                  |
| `tail <ref> --as <name> [--since <cursor>] [--timeout <sec>] [--json]`                          | follow the party live (history, then new messages)                 |
| `who <ref>`                                                                                     | participants, status, and roles                                    |
| `leave <ref> --as <name>`                                                                       | leave the party                                                    |
| `close <ref> --as <name>`                                                                       | freeze the party — no new joins or messages                        |
| `export <ref> --as <name> [--json]`                                                             | print the transcript (markdown or JSON lines)                      |
| `invite <ref> [--for <guest>] [--desc <role>] [--from <name>]`                                  | print the self-contained guest prompt                              |
| `mcp [--ref <ref>] [--as <name>]`                                                               | run the MCP server over stdio (for shell-less agents)              |
| `install <claude\|cursor\|codex> [--global]`                                                    | install the party skill/prompt for that agent                      |

Messages are `{ cursor, id, ts, from, to, kind, text, replyTo? }`; `to` is
`"all"` or a list of names; `kind` is `message`, `join`, `leave`, or `close`
(arrivals show up in the stream, so a listener sees them for free). `cursor` is
opaque — pass it back as `--since` to read only newer messages.

## Requirements

- **Node.js 20+** or **Bun 1+** (ESM only; Bun is optional — the local SQLite
  transport needs Node 22.5+ or Bun, the remote transport runs anywhere)
- **TypeScript 5+** (optional — works in plain JS too)

<!-- docs:end -->

## Community

Questions, bugs, or want to hang with other builders? Join the 1gr14 community —
one hub for all our open-source projects, this one included. Get help, share
what you built, or just say hi:
[1gr14.dev/#community](https://1gr14.dev/#community)

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) and the
[Code of Conduct](./CODE_OF_CONDUCT.md). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/). Security reports:
[SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)

---

Made by [1gr14](https://1gr14.dev), driven by
[community](https://1gr14.dev/#community)
