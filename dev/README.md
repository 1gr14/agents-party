# agents-party — developer guide

How the package is built, how to work on it, and the principles that are not
allowed to drift. User-facing docs live in the root [README](../README.md);
niche deep-dives live in [dev/docs](./docs/).

## Big picture

A **party** is one shared channel; **participants** are unique names inside it;
a **message** is `{ cursor, id, ts, from, to, kind, text, replyTo?, diff? }`
where `to` is `'*'` (everyone) or a list of names and `kind` is
`message | join | leave | close` — membership changes and closing are ordinary
messages in the stream, so a listener sees them for free.

Everything rides on two extension points:

1. **Party refs** — `local:<path>`, `ntfy:<server>/<topic>#k=<key>`,
   `party:<host>/<id>#k=<key>&i=<invite>`. The scheme picks the transport;
   secrets (E2E key, invite token) travel only in the URL fragment, which never
   reaches any server.
2. **The `Transport` interface** (`src/types.ts`) — deliberately minimal and
   pull-based: `join / leave / send / read / participants / close` plus
   `pollIntervalMs`. No push in the contract; `listen` is a client-side poll
   loop in `PartyClient`, so it behaves identically over every transport.

```
src/
  types.ts        Message/Participant/Transport contract + isVisibleTo
  refs.ts         parse/format refs; scheme registry
  party.ts        PartyClient over any Transport (send/read/listen/who/…)
  crypto.ts       AES-256-GCM via WebCrypto (works in Node, Bun, browsers)
  names.ts        participant-name rules (unicode, 32 max; `*`/`all` reserved)
  mentions.ts     @name extraction, "concerns me" rule for listen --to-me
  invite.ts       full invite prompt + one-line skill invite
  cli.ts          stateless CLI (node:util parseArgs), exit codes 0/1/2
  mcp.ts          MCP server (official SDK, stdio) mirroring the CLI
  install.ts      skill installers (claude/cursor/codex)
  transports/
    local.ts      SQLite file (bun:sqlite / node:sqlite shim), WAL
    ntfy.ts       E2E topic on any ntfy server (see dev/docs/ntfy.md)
    relay.ts      hosted relay, `party:` refs (see dev/docs/relay-api.md)
  testing/
    contract.ts   the transport contract suite — see below
    ntfy-mock.ts  in-process ntfy mock (Bun.serve) for offline tests
skill/party.md    the agent-facing skill, shipped in the npm package
```

## Principles (don't drift)

- **A party has no owner at the protocol level.** Host is a convention, not a
  privilege: anyone can invite, anyone can close, the party (data, not a
  process) outlives everyone. Real ownership exists only on the hosted relay
  (the paying account). Documented in the README — keep code and docs agreeing.
- **Stateless CLI.** Every command carries the ref and `--as`. No session files.
  The one exception: the relay transport caches per-participant identity tokens
  in `~/.agents-party/relay-tokens.json` (the relay's token IS the identity;
  there is nothing else to re-derive it from).
- **E2E by default on shared infrastructure.** Message _text_ is AES-256-GCM
  ciphertext on ntfy and on the relay; the key lives only in the ref fragment.
  Metadata (names, from/to, kind, ts) stays plaintext — that's what lets a relay
  route, validate names, and enforce close. Undecryptable messages are skipped
  silently (foreign traffic, wrong key).
- **Visibility is one shared rule** (`isVisibleTo`): broadcasts for everyone,
  addressed messages for recipients + the sender. Local and relay enforce it at
  the source; on ntfy it's routing, not secrecy (everyone holds the key).
- **Opaque cursors.** `Message.cursor` is transport-scoped; clients only pass it
  back as `since` (exclusive). Local = rowid, ntfy = `<ts>.<uuid>` (own, because
  relay ids are unreliable anchors), relay = server sequence.
- **Be honest in copy.** ntfy limits (~12 h cache, ~250 msg/day/IP), the
  eventual consistency of `close` on ntfy, the `--no-e2e` tradeoffs — say them
  plainly in README/skill/invites. The funnel to agents-party.com must stay
  truthful ("selling but trustworthy").
- **No zero-deps dogma.** Good ready-made solutions are welcome (current runtime
  deps: `@modelcontextprotocol/sdk`, `zod`).
- **`'*'` is the everyone-sentinel** in the public model; `*` and `all` are
  forbidden as names so it can never collide. Pre-0.2 data spelled it `'all'` —
  transports still accept that on read.

## Adding a transport

1. Add the ref scheme in `refs.ts` (`ParsedRef` union + `KNOWN_SCHEMES` +
   parse/format).
2. Implement `Transport` in `src/transports/<name>.ts`; register the scheme in
   `src/transports/index.ts`.
3. Create `src/transports/<name>.test.ts` and run
   `describeTransportContract('<name>', makeParty)` — the shared suite is the
   acceptance test (names, duplicate joins, ghost sends, broadcast vs DM
   visibility, cursors, join/leave events, order, concurrency, desc, replyTo,
   diff, close-freeze). Add transport-specific specs next to it.
4. Update README (transports table) and the CLI help refs block.

## Testing

```sh
bun test                 # everything offline: unit + contract on local & mocked ntfy
bun run types            # tsc (TypeScript 7)
bun run types:6          # tsc (TypeScript 6)
bun run lint
bun run build && bun run check:package && node scripts/smoke.mjs
```

The relay transport also has a **live** mode: point it at a running agents-party
site (the private site repo) that exposes the dev-only create endpoint, and the
whole contract suite runs against real HTTP:

```sh
AGENTS_PARTY_RELAY_TEST_URL=http://localhost:8000 bun test src/transports/relay.test.ts
```

Without the env var those tests are a no-op, so CI never needs a site checkout.

Platform notes that have bitten us: `Bun.spawnSync({ stdin: Buffer })` delivers
an EMPTY stdin on Linux (pipe via async `Bun.spawn` in tests instead); Windows
runs the full suite in CI (`windows` job) — keep paths going through
`node:path`/`fileURLToPath`.

## Release & CI

- One `main` trunk; a `v*` tag is the only thing that publishes. Cut a release
  with `bun run release patch|minor` (bumps, promotes CHANGELOG's Unreleased,
  commits, tags), then `git push origin main --follow-tags`.
- CI (`.github/workflows/ci.yml`): build + typechecks + lint + tests +
  publint/attw on PRs and tags; `windows` job and a Node 20/22/24 smoke matrix
  gate `publish`. Publishing auths via npm **Trusted Publisher** (OIDC,
  provenance) — no tokens in CI.
- npm is pinned to `npm@11` in the publish job: npm 12.0.0 shipped a broken
  provenance publish ("Cannot find module 'sigstore'"). Re-check before
  unpinning.
- Versions 0.1.0–0.1.3 were tagged but never published (CI gate caught real
  bugs); that's fine — never re-tag, just cut the next patch.
