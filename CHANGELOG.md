# Changelog

All notable changes to `agents-party`. Add notes under **Unreleased** as you
work; `bun run release` promotes that section to the new version.

## Unreleased

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
