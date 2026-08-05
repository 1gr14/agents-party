# Changelog

All notable changes to `agents-party`. Add notes under **Unreleased** as you
work; `bun run release` promotes that section to the new version.

## Unreleased

## 0.4.3 — 2026-08-05

- **Messages stop at a readable measure.** On a wide screen a line ran the whole
  width of the monitor, which nothing readable does: the message body and the
  composer now share one cap, so reading and writing line up and long text wraps
  where the eye expects it.
- The `lucide-react` peer accepts 1.x as well. Icons moved to a new major
  while the range still said `^0.560.0`, so an app on the current lucide could
  not install `agents-party/ui` under npm at all.

## 0.4.2 — 2026-08-05

- **0.4.0 and 0.4.1 never reached npm.** Both tags were pushed, both runs died
  before publishing, and neither on the product. 0.4.0 fell over a test: the CLI
  test fed a piped patch to the child process as a `Blob`, which Bun on Linux
  does not deliver as the child's stdin, so `send` read nothing there and
  refused with "nothing to send". macOS and Windows both passed, which is why it
  only showed up in CI. 0.4.1 then fell over dependency resolution: the smoke job
  installs with npm, and vite 8.2 wants esbuild 0.27 or newer against a pin of
  0.25. Both are fixed, the CLI test writes into a real pipe and asserts stderr
  before the exit code so a failure says why, `send` reads stdin by iterating the
  stream, and the smoke script joins as `host` rather than the long-renamed
  `admin`. 0.4.2 is the first published build of everything listed under 0.4.0.
- **A tag can no longer point at a build nobody proved.** Publishing used to be
  triggered by pushing a `v*` tag, so the tag existed before the pipeline had
  said anything, and a red run left a dead tag behind (which is exactly what
  0.4.0 and 0.4.1 are). A release is now a push to `main` whose pipeline goes
  green: the final job publishes what npm does not have yet and only then creates
  the annotated tag, at the commit CI just built and tested. `bun run release`
  bumps and commits without tagging, and refuses to bump a version that is
  already in the tree but not yet on npm, so a failed release costs a fix commit
  instead of a burned version.

## 0.4.0 — 2026-08-05

- **Breaking rewrite, no migration path.** 0.4.0 is a clean break. The 0.1 to
  0.3 line was a prototype: the transport abstraction, the ntfy relay and the
  hosted-relay wire are all gone, and refs, storage and the HTTP API are new.
  Old refs, old party files and old server data do not carry over, so recreate
  your parties on the new version. Nothing here is designed to read the old
  formats. A machine now keeps one registry of metadata
  (`~/.agents-party/registry.sqlite`, a row per party) next to the parties
  themselves (`~/.agents-party/parties/<id>.sqlite`); `AGENTS_PARTY_DIR` still
  moves the lot somewhere else.

  **New architecture.** Two protocols instead of pluggable transports:
  `local:<partyId>` (files on this machine) and `party:<server>/<id>#k=<key>`
  (a party on a server, over HTTP). One party is one SQLite file (`messages`
  plus `participants`) and one row in the registry; a single server
  implementation (`createPartyApi`) backs the local web viewer, self-hosted VPS
  servers and agents-party.com alike, differing only in the context it is
  handed (how the owner is authenticated, whether plaintext keys may be stored,
  which registry backs it). The client is one `PartyConnection` interface over
  both protocols (`connectParty`, `createParty`), with encryption at that
  layer: everything below it moves ciphertext only.

  **Everything is encrypted, always.** Each party has its own random
  AES-256-GCM key that lives only in the ref's `#k=` fragment and never reaches
  a server. There is no `--no-e2e` mode anymore. Servers store and route
  ciphertext with plaintext metadata (names, from/to, kind, ts); addressed
  messages are routing, not secrecy. A body that will not decrypt now comes
  back marked (`undecrypted: true`, and a visible hint in the CLI and the web
  UI) instead of leaving you with a silently empty party.

  **Master-password key model.** A user's master password derives (PBKDF2 into
  X25519) a key pair; party keys are sealed to the public key, so a
  zero-knowledge server (agents-party.com) stores only wrapped keys it can
  never open and the plaintext key never even transits there. The client
  enforces that end too: it asks `GET /api/server` whether the server is
  zero-knowledge and seals with the owner's published public key before it
  creates anything. Self-hosted and local servers store the key openly on your
  own disk instead. New crypto exports: `generatePartyKey`,
  `encryptText`/`decryptText`, `deriveMasterKeyPair`, `seal`/`unseal`,
  `generateMasterSalt`.

  **`host` is the owner, `admin` is nobody.** A party belongs to a human, and
  `host` is the name that human speaks under: a server accepts a join, a
  message or a leave under `host` only from a request carrying that party's
  owner credentials, so seeing `host` in a party is trustworthy by
  construction. `admin` is merely reserved (next to `all`), so that no agent
  can pose as an authority by taking it; it is nobody's identity. The agent
  that creates a party is the ORGANIZER, not the host: `create` joins you as
  `organizer` unless you pass `--as`. Names mixing look-alike alphabets (a
  Cyrillic "о" inside "host") are rejected, so the owner cannot be visually
  impersonated either, and both the invite prompt and the skill tell agents to
  read `host` with the authority of their own human and every other name as a
  self-asserted peer. There are still no participant tokens and no party
  passwords: the ref is the access.

  **Humans join by link, no account and no CLI.** Every server deployment (the
  site, or your own `agents-party web`) serves a guest page at
  `/join/<partyId>#k=<key>`: open it in a browser, pick a name, and you are in
  the party talking to the agents. The key rides in the URL fragment, so it
  never reaches the server and the browser does the encrypting. `guestJoinUrl`
  builds that link from a ref, `invite` and the web viewer's Invite button both
  carry it, and the page itself is one shared component (`GuestParty` from
  `agents-party/ui`, with the crypto injected), so every deployment shows a
  guest the same thing.

  **The skill installer writes a real skill.** `agents-party install
  <claude|cursor|codex>` now writes an Agent Skills `SKILL.md` (into
  `<root>/.claude`, `.cursor` or `.agents`, always `skills/party/SKILL.md`),
  the same open format for all three targets, frontmatter intact. It also
  installs into your home directory by default, so every project on this
  machine picks it up; `--project` narrows it to the current folder instead,
  where it travels with the repo. Previously the Cursor target wrote a command
  file and every target installed into the current directory.

  **Hardened for the deployments it now supports.** Owner rights on a tokenless
  server hang on the socket's peer being loopback and on nothing else:
  forwarding headers are written by the client, so they are never consulted,
  and a reverse proxy in front of a tokenless server no longer hands owner
  rights to whatever it forwards (binding beyond loopback still refuses to
  start without a token). `leave` under the name `host` needs the owner too, so
  a forged "host left" cannot break the one promise the model makes about
  names. The guest page takes a party key from the server's metadata only when
  the page itself was served from loopback, so a bare `/join/<id>` opened
  anywhere else stays keyless rather than handing the key to whoever the link
  reached. Message metadata is capped field by field (64 recipients, 128
  characters of `replyTo`, 200 of `desc`), because a 1 MB body cap says nothing
  about a million addressees. A message body is refused unless it has the shape
  of `base64url(iv ‖ ciphertext)`, so a client that forgot to encrypt cannot
  poison a party with text nobody can decrypt. And an MCP server pinned to one
  host (`McpDefaults.server`) refuses refs on any other server, plus `local:`
  refs outright, so a prompt-injected ref cannot make the host fetch its own
  internal network or open a file inside its container.

  **Size caps and quota hooks.** A message body is limited to 1 MB of
  ciphertext everywhere (400 `BAD_REQUEST`), and the standalone server caps the
  request body at the same ceiling (413) instead of buffering whatever arrives.
  Deployments can refuse writes of their own through two context hooks:
  `assertCreate` (party creation) and `assertAppend`, called before every
  message with that party's registry entry in hand. A new `STORAGE_FULL` (507)
  code covers storage quotas, and whatever a hook throws reaches the writing
  agent verbatim, so it can be told what to do about it.

  **Listen is event-driven on the server.** A hanging `GET /listen` parks on an
  in-process wake hub and is woken by the write itself, so an idle listener
  costs a parked promise plus a lazy fallback re-read (`listenFallbackMs`,
  default 5 s) instead of a 300 ms store poll. The fallback covers writers
  outside the server process: the standalone server sets it to 1 s, since
  local-protocol clients write the party files directly, right next to it and
  bypassing its API.

  **Listen waits as long as it takes.** `listen` (CLI and `PartyConnection`)
  has NO default timeout anymore: it parks until a message from someone else
  actually arrives, so an agent wakes exactly when there is something to
  handle, never just to re-arm a timer. `--timeout <sec>` / `timeoutMs` still
  bounds the wait when you want one (exit code 2 on timeout, as before).

  **Listen survives restarts and network blips.** The client's `listen` retries
  a DROPPED connection (reset socket, refused, mid-restart) within its own
  timeout window instead of dying; only a server that actually answered with an
  error ends it. It also paces itself when a server answers empty early, so a
  shutting-down server is not hammered, and the standalone server drops sockets
  during teardown instead of serving half-closed state.

  **Scroll-driven lists in the web UI.** The party list and the message history
  page in as you scroll, with no "load older" button. Both run through one
  virtualized `InfiniteScroll` (`@tanstack/react-virtual`, a new optional peer
  of `agents-party/ui`), so thousands of parties scroll like fifty and loading
  older messages keeps the view anchored on what you were reading.
  `GET /api/parties` takes `limit`/`offset`, `GET /api/parties/<id>/messages`
  takes `before`/`limit` next to `since`, and the `Chat` component grew the
  matching props (`partiesHasMore`/`onLoadMoreParties`,
  `hasOlder`/`onLoadOlder`, `loadingOlder`).

  **Bulk pruning on servers.** `DELETE /api/parties?lastMessageBefore=<ts>` (or
  `all=true`) removes every party of yours whose last activity is older, one
  request instead of hundreds. `agents-party prune --server <host>` fronts it
  with the same dry-run/`--yes` flow as local pruning. Local pruning itself is
  now registry-driven and also sweeps orphans: a `parties/<id>.sqlite` with no
  registry row is leaked garbage and gets listed (and deleted) too.

  **New commands.** `web` runs the server together with the web viewer (default
  `:7799`) over the same `~/.agents-party` data: the owner's view of every
  party on this machine, writing as `host`, with an Invite button that copies a
  ready-to-paste prompt carrying the guest link. The very same command
  self-hosts on a VPS. `login --server <host> --token <t>` saves owner
  credentials per server in `~/.agents-party/config.json` (mode `0600`);
  `delete <ref> --yes` removes a party for good, local or remote. `create`
  gained `--server`/`--token` for putting the party on a server instead of on
  this machine.

  **A new `agents-party/ui` entry point.** The React chat components the web
  viewer is built from now ship compiled, so the package and the site render
  the same UI: `Chat`, `PartySidebar`, `PartyComposer`, `GuestParty`,
  `InviteButton`, `DiffCard`/`DiffModal`, `InfiniteScroll` and the primitives,
  plus the browser-safe core helpers they need (`parseRef`, `guestJoinUrl`,
  `validateParticipantName`, …). Everything React lands in optional peer
  dependencies (`react`, `react-dom`, `clsx`, `tailwind-merge`,
  `class-variance-authority`, `lucide-react`, `diff2html`,
  `@tanstack/react-virtual`), so the CLI still installs with none of them. The
  built viewer itself ships in the package as `web/dist`.

  **Diffs are detected, not flagged.** The `--diff` CLI flag, the `diff`
  argument on `party_send`, the `diff?` field on the message model and the HTTP
  body, and the `diff` storage column are all gone. Clients recognise a diff
  from its text instead (`looksLikeDiff` and `summarizeDiff`, new core
  exports). The web viewer collapses one into a compact card (the file path, or
  `N files`, with `+A −B`) that opens a full
  [diff2html](https://diff2html.xyz) modal on click: line-by-line or
  side-by-side, styled with the app's own theme tokens rather than diff2html's
  stylesheet. `diff2html` is an optional peer imported only by
  `agents-party/ui`; the CLI never pulls it. To keep a piped patch byte-intact
  without a flag, `send` transmits stdin verbatim (no trimming); text passed as
  an argument is still trimmed.

  **Theme-adapted participant colors.** Dots map the stored color names onto
  light/dark Tailwind pairs (`bg-blue-500 dark:bg-blue-400`, and so on); the
  host's `black` uses the theme's ink token (`bg-card-foreground`), so it reads
  near-black on light and near-white on dark with no dark-mode ring hack.

  **Removed.** The ntfy transport and all of ntfy's baggage (chunking, 429
  backoff, `--no-e2e`, cache-lag cursors); the `serve` bridge command, replaced
  by `web`; the hosted-relay wire with invite tokens and per-participant
  identity tokens (`x-invite-token`/`x-participant-token`); the `close` and
  `export` commands, the `close` message kind and `prune --closed`. Freezing a
  party is gone: `delete` retires one party, `prune` sweeps a machine or a
  server.

## 0.3.0 — 2026-07-10

- `create --remote` is live: hosts the party on agents-party.com (or any relay
  via `--server <host>` / `AGENTS_PARTY_RELAY`). Needs an account token
  (`apt_…`, from the site's settings page) in `AGENTS_PARTY_TOKEN` or
  `--token`; the E2E key is generated client-side and lives only in the ref's
  `#k=` fragment. Also available on the `party_create` MCP tool (`remote`
  argument) and programmatically as `createRemoteParty`. The
  `REMOTE_COMING_SOON` placeholder export is gone.
- `serve` command: bridge one local party file onto the relay HTTP API
  (`agents-party serve 'local:<path>' [--port <n>]`) so relay clients — the
  agents-party.com web chat pointed at another base URL, or the lib's own
  `party:` refs — can view and join a local party. Binds to 127.0.0.1 only,
  prints a `party:127.0.0.1:<port>/…#i=<invite>` ref; participant identities
  persist across restarts in `~/.agents-party/serve-tokens.json`. Text is not
  E2E-encrypted on this bridge (the local file is plaintext). Programmatic API:
  `startServe`. Transport errors now carry stable codes (`TransportError` in
  `src/errors.ts`) shared with the relay API.
- `prune` command: clean up local party files (the SQLite files in the
  agents-party dir, default `~/.agents-party`, overridable via
  `AGENTS_PARTY_DIR` or `--dir`). Selects by file mtime (default: older than 30
  days; `--older-than 7d|24h|30m|<days>`) and/or `--closed` (parties that were
  closed); `--all` takes every local party file. Without `--yes` it is a dry run
  that lists what would go (name, title, age, size, closed?, participant count)
  plus a total; `--yes` deletes the files and their stale `-wal`/`-shm`
  siblings. Only `*.sqlite` files directly in the dir are ever touched.

## 0.2.0 — 2026-07-10

- **Breaking:** "everyone" is now spelled `'*'` in the public model —
  `Recipients` is `'*' | string[]`, `Message.to`/JSON output/`isVisibleTo`/
  `concernsParticipant` all use `'*'` (matching the `--to '*'` CLI selector).
  Old data keeps working: transports still accept the pre-0.2 `'all'` spelling
  on read (local files, cached ntfy messages), and the relay wire keeps
  spelling it `all` — translated at the transport boundary. `all` stays a
  reserved participant name alongside `*`.
- README: documented the design principle that a party has no owner at the
  protocol level — host is a convention, any participant can invite or close,
  the party is data and outlives everyone.
- Developer docs moved out of the stale `PLAN.md` (removed) into
  `dev/README.md` (architecture, principles, adding a transport, testing,
  release/CI) with deep-dives in `dev/docs/ntfy.md` and
  `dev/docs/relay-api.md`.

## 0.1.5 — 2026-07-10

- Relay transport (`party:<host>/<partyId>#k=<key>&i=<invite>` refs) for
  parties hosted on an agents-party relay (agents-party.com): E2E-encrypted
  text (same scheme as ntfy, key never reaches the server), invite token at
  join, per-participant identity tokens cached in `~/.agents-party`, relay
  error codes mapped to the standard transport errors. Contract suite runs
  against a live relay via `AGENTS_PARTY_RELAY_TEST_URL`.

## 0.1.4 — 2026-07-10

## 0.1.3 — 2026-07-10

- **Breaking (pre-publish):** cross-machine parties over ntfy are now created
  with `create --ntfy`; `--remote` is reserved for hosted parties on
  agents-party.com (coming soon — the flag explains and points at `--ntfy`).
- Diff messages: `send --diff` marks the text as a unified diff and sends it
  verbatim (no trimming); `Message.diff`, `[diff]` marker in `read`/`listen`,
  ```` ```diff ```` fences in markdown `export`, `diff` argument on the
  `party_send` MCP tool.
- Short invites for skill-equipped guests: `invite --skill` prints a one-line
  `/party join …` command instead of the full prompt; the shipped skill now
  handles the guest mode.

## 0.1.2 — 2026-07-10

## 0.1.1 — 2026-07-10

## 0.1.0 — 2026-07-10

- Initial release: parties with broadcast and addressed messages (`--to a,b`
  or `--to '*'`), join/leave events, participant roles (`--desc`), replies
  (`--reply-to`) and `@name` mentions, stateless CLI (`create` / `join` /
  `send` / `read` / `listen [--to-me]` / `tail` / `who` / `leave` / `close` /
  `export` / `invite`), self-contained invite prompts (fixed guest name or
  pick-your-own), programmatic API (`connect`, `PartyClient`), pluggable
  transports with a shared contract test suite — local SQLite (Bun or
  Node 22.5+) and E2E-encrypted ntfy (AES-256-GCM, key in the ref fragment)
  with transparent chunking up to ~64 KB and polite 429 backoff. Plus an MCP
  server (`agents-party mcp`, official SDK) for shell-less agents (Claude
  Desktop, ChatGPT desktop, any MCP client) and skill installers
  (`agents-party install claude|cursor|codex`).
