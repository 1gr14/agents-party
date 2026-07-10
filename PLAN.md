# agents-party — PLAN (v0.1)

Working doc for the first release. Not published (`files` ships only `dist`,
README, LICENSE).

## Name & package

- npm: **`agents-party`** (unscoped on purpose, like `cursor-pair` and `1gr14` —
  the name is the product). Checked free on npm; `1gr14/agents-party` free on
  GitHub.
- Repo: `github.com/1gr14/agents-party` (private, `dev` branch until first
  release).
- Stage: `dev` → `experimental` on first publish.

## Pitch

Throw a party for your AI agents. Any already-running agent sessions — Claude
Code, Cursor, Codex, anything with a shell — join a shared party and talk:
broadcast to everyone or message specific participants. The host hands each
guest a self-contained invite prompt; no orchestrator owns your sessions, they
just chat. Transports are pluggable — v0.1 ships two: a local SQLite channel
(one machine, zero infra) and an end-to-end-encrypted ntfy channel
(cross-machine, zero signup — ntfy.sh by default, `--server` for self-hosted /
paid). More transports (Nostr relays, own relay) slot in behind the same
interface later.

What the alternatives don't do: orchestrators (claude-flow, claude-swarm, Agent
Teams) spawn and own agents top-down; Agent Room is broadcast-only on a hosted
backend; Walkie-Talkie is Claude-Code-only. agents-party joins _existing_
sessions of _any_ tool, with both broadcast and addressed messages, and no
server.

## Hero example

Host agent (in any CLI session):

```sh
bunx agents-party create --name fix-flaky-tests
# → party ref: local:~/.agents-party/fix-flaky-tests-k3f9.sqlite  (joined as "host")

bunx agents-party invite local:~/.agents-party/fix-flaky-tests-k3f9.sqlite --for mac-cursor
# → prints a self-contained prompt to paste into the guest session
```

Guest agent (pasted prompt tells it exactly this):

```sh
bunx agents-party join <ref> --as mac-cursor
bunx agents-party send <ref> --as mac-cursor "joined, what do you need?"
bunx agents-party listen <ref> --as mac-cursor        # blocks until a message for me, prints it, exits
bunx agents-party send <ref> --as mac-cursor --to host "test run: 3 failures, log attached below"
```

Programmatic API (same engine the CLI uses):

```ts
import { connect } from 'agents-party'

const party = await connect('local:~/.agents-party/demo.sqlite', { as: 'host' })
await party.send('hello everyone')
await party.send('just for you', { to: ['mac-cursor'] })
const msgs = await party.read({ since: 42 })
const everyone = await party.who()
```

## Model

- **Party** — one channel with an id/name. **Participant** — unique name inside
  the party (`host`, `mac-cursor`, `sergei`, …). A human is just a participant.
- **Message** — `{ seq, id, ts, from, to, kind, text }`.
  - `to`: `"all"` or `string[]` (addressed). Addressed messages are delivered
    only to the named participants (in the local transport that's a real query
    filter, not a convention).
  - `kind`: `"message" | "join" | "leave"` — join/leave are system messages in
    the same stream, so `listen` sees arrivals for free.
  - `cursor`: an **opaque string** the transport attaches to every message — the
    `since` argument for the next read. Local = SQLite rowid as string; ntfy =
    our own `<ts>.<id>` (relay-independent: exact anchor match with a timestamp
    fallback — live testing showed ntfy.sh commits messages to its cache with a
    lag, so relay ids are unreliable anchors). Opaque cursors are what keep the
    contract implementable by any transport.
- **Party ref** — a URL-ish string that carries the transport scheme:
  `local:<path>` and `ntfy:<server-url>/<topic>#k=<key>` in v0.1; later e.g.
  `nostr:<relays>#<key>`, `party:<relay-url>`. The scheme is the extension
  point.

## Architecture — pluggable transports, no cleverness

```
src/
  types.ts             Party, Participant, Message, Transport — the contract
  party.ts             PartyClient over any Transport: send/read/listen/who
  invite.ts            invite prompt generation (self-contained, agent-bridge style)
  refs.ts              parse/format party refs; scheme → transport registry
  crypto.ts            AES-256-GCM via WebCrypto (zero deps) for remote transports
  transports/
    local.ts           LocalTransport — SQLite file (bun:sqlite / node:sqlite shim)
    ntfy.ts            NtfyTransport — E2E-encrypted pub/sub over any ntfy server
    contract.ts        reusable transport contract suite (see Tests)
  cli.ts               thin arg parsing (node:util parseArgs) → PartyClient
  index.ts             public exports
```

The `Transport` interface is deliberately minimal and pull-based — the lowest
common denominator every future transport (HTTP relay, ntfy-style pub/sub) can
implement:

```ts
interface Transport {
  join(name: string): Promise<Participant>
  leave(name: string): Promise<void>
  send(msg: NewMessage): Promise<Message>
  read(opts: { for: string; since?: string }): Promise<Message[]>
  participants(): Promise<Participant[]>
  close(): Promise<void>
}
```

- No push/subscribe in the contract (v0.1): `listen` is a client-side poll loop
  in `PartyClient`, so it works identically over any transport. A push-capable
  transport can be added later as an _optional_ capability without breaking the
  contract.
- Adding a transport = implement the interface + register the scheme + pass the
  contract test suite. Nothing else changes.

## CLI (v0.1)

Stateless by design — every call carries `<ref>` and `--as <name>`; no hidden
session files, so any number of agents can share one machine safely.

- `create [--name <slug>] [--as host] [--remote] [--server <url>]` — new party,
  joins, prints the ref. Default is local; `--remote` makes an ntfy party
  (random topic + fresh E2E key, `--server` defaults to `https://ntfy.sh`)
- `join <ref> --as <name>`
- `send <ref> --as <name> [--to a,b] <text>` (or text from stdin)
- `read <ref> --as <name> [--since <seq>]` — one-shot, JSON lines
- `listen <ref> --as <name> [--since <seq>] [--timeout <sec>]` — blocks until a
  message for me arrives → prints JSON lines, exit 0; timeout → exit 2. Made for
  `run_in_background`: the agent sleeps in the shell, wakes only on a real
  message (agent-bridge listener contract, ~0 idle model cost)
- `who <ref>`
- `leave <ref> --as <name>`
- `invite <ref> --for <guest-name>` — prints the self-contained guest prompt
  (ref, name, all commands inline; assumes only `bunx`/`npx` on the guest side)

Default party dir: `~/.agents-party/` (override via ref path or
`AGENTS_PARTY_DIR`).

## The skill side

The repo ships the agent-facing prompt as `skill/party.md` (how a host runs a
party: create → invite → listen loop → relay to the human). README shows how to
install it into Claude Code / Cursor. Sergei's personal `/party` skill in
`~/cc/agents` will be a thin pointer at this. A polished `install` command
(cursor-pair-style installer) is **out** of v0.1.

## ntfy transport notes

Research verdict (July 2026): ntfy.sh is the one zero-signup public pub/sub
where this is the _intended_ use — published ToS ("your topic name functions as
a password"), published limits (~250 msgs/day **per IP** — parties span
machines, so limits multiply; ~4 KB body; 60-request burst), and paid tiers that
make free-tier use a designed business model. Public MQTT brokers say "testing
only", smee.io is dev-only with no replay, ppng.io is a 1:1 pipe,
dweet.io/patchbay.pub are dead. Nostr relays (ephemeral events + NIP-44) are the
best _second_ remote transport later — decentralized, Trystero precedent — at
the cost of a WebSocket client and `nostr-tools`.

Implementation:

- **E2E encryption always on** — the relay sees only ciphertext. AES-256-GCM via
  WebCrypto (`crypto.subtle`, built into Bun and Node 20+, zero deps). Key is
  generated at `create --remote`, travels only inside the ref fragment
  (`#k=<base64url>`) — fragments never hit the server; the invite prompt carries
  the full ref. Wire format: base64(iv ‖ ciphertext) as the ntfy body.
- Cursor = ntfy message id (`?poll=1&since=<id>`); undecryptable messages on the
  topic are skipped silently.
- Participants are folded from join/leave messages in the stream (no server
  state). ntfy caches ~12 h — a remote party is a working session, not an
  archive; document honestly.
- Be a good citizen: messages ≤ 4 KB (error with a hint to split), `listen`
  polls at a 3 s interval with jitter, `--server` for self-hosted/paid ntfy.
- Addressed messages over ntfy are **routing, not secrecy** (every party member
  holds the key) — same as any group chat; documented.

## SQLite driver note

`bun:sqlite` when running under Bun, `node:sqlite` when available (Node ≥ 22.5);
otherwise a clear error telling you to run via `bunx`. Lazy-imported inside
LocalTransport only — the package itself stays importable on Node 20 (smoke
matrix stays green; smoke skips the sqlite round-trip where `node:sqlite` is
missing).

## Scope

**In (v0.1):** local SQLite transport, **remote ntfy transport with E2E
encryption**, broadcast + addressed messages, join/leave events, stateless CLI
(create/join/send/read/listen/who/leave/invite), invite prompt, programmatic
API, transport contract test suite, `skill/party.md`, README.

**Out (explicitly):** Nostr / own-relay / SaaS transports, MCP server, web
dashboard, push delivery / Stop-hook integration, installer command, message
attachments. All designed-for but not built.

## Dependencies

Zero runtime deps. CLI parsing via `node:util` `parseArgs`. Dev deps = blank0
standard.

## Tests

- `bun test` unit tests: ref parsing, addressing/filtering rules, invite prompt
  content, seq cursors.
- **Transport contract suite** — `describeTransportContract(factory)` shared
  spec (join/dup-name rejection, broadcast vs addressed delivery, since cursors,
  join/leave events, concurrent writers). Runs against LocalTransport **and**
  NtfyTransport (against an in-process mock ntfy server via `Bun.serve` — tests
  stay offline); every future transport reuses it — that's what keeps
  "pluggable" honest.
- Crypto round-trip tests (encrypt/decrypt, tamper detection, foreign-blob
  skip).
- Concurrency test: parallel writers via multiple connections to one party file
  (WAL).
- CLI e2e: spawn built `dist/cli.js` for a create→invite→join→send→listen
  round-trip.
- Type tests: `expectTypeOf` on public API (never-called function body).
- `scripts/smoke.mjs`: import under plain Node 20/22/24; sqlite round-trip only
  where a driver exists.

## Keywords

agent, agents, multi-agent, claude, claude-code, cursor, codex, chat, channel,
party, collaboration, cli, sqlite

## Open questions

- `party0` vs `agents-party` was considered — settled on `agents-party`
  (googlable, the `0` carries no meaning here).
- Guest names: required `--as` (no auto-naming) — keeps addressing predictable.
- First publish timing: build v0.1 fully, then decide when to reserve the npm
  name (bootstrap script + OIDC) — separate explicit step.
