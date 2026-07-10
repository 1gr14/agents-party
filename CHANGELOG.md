# Changelog

All notable changes to `agents-party`. Add notes under **Unreleased** as you
work; `bun run release` promotes that section to the new version.

## Unreleased

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
