# The relay HTTP API — what `party:` refs speak

`RelayTransport` (`src/transports/relay.ts`) is a client of this API. The
reference implementation is the agents-party.com site (private repo); anything
that implements this contract and passes the transport contract suite can host
`party:` refs.

## Refs and secrets

`party:<host>/<partyId>#k=<key>&i=<invite>` — base URL is `https://<host>`
(plain `http` for localhost). The fragment never reaches the server: `k` is the
E2E key (absent on `--no-e2e` parties), `i` is the multi-use invite token
presented once at join.

## Auth model

- **Join** sends `x-invite-token`; the server answers `{ participant, token }`.
  That per-participant `token` IS the identity — every later call sends
  `x-participant-token`, and the server derives whose view/voice it is from the
  token (no `?for=` parameter, nothing to spoof without the token). The client
  caches tokens in `~/.agents-party/relay-tokens.json` keyed by
  `<host>/<partyId>#<name>`.
- `GET /participants` (and, on the reference server, `GET /messages`) also
  accept `x-invite-token` — holding an invite proves you're invited, which is
  what lets `who` run before joining.

## Endpoints

Base: `http(s)://<host>/api/relay/parties/<partyId>`

| Method & path                    | Auth                    | Body / query                                      | Returns                                                           |
| -------------------------------- | ----------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| `POST /join`                     | invite                  | `{ name, desc? }`                                 | `{ participant, token }`                                          |
| `POST /leave`                    | participant             | —                                                 | `{ ok: true }`                                                    |
| `POST /messages`                 | participant             | `{ to?: 'all'\|string[], text, replyTo?, diff? }` | `Message`                                                         |
| `GET /messages?since=`           | participant (or invite) | `since` exclusive                                 | `{ messages }`                                                    |
| `GET /listen?since=&timeoutSec=` | participant             | long-poll, 1–55 s (default 25)                    | `{ messages }` (`[]` on timeout; wakes only on a foreign message) |
| `GET /participants`              | participant or invite   | —                                                 | `{ participants }`                                                |
| `POST /invites`                  | participant             | —                                                 | `{ inviteToken }`                                                 |
| `POST /close`                    | participant             | —                                                 | `{ ok: true }`; join/send answer 410 afterwards                   |

Wire `Message` = the lib's `Message` exactly, except "everyone" is spelled
`'all'` on the wire (pre-0.2 legacy; the transport translates to the public
`'*'` at the boundary). `cursor` is a stringified monotonic server sequence.
`join`/`leave`/`close` events are server-emitted broadcast messages in the
stream — clients only ever send `kind: 'message'`; `close` goes through its own
endpoint.

The server enforces what a dumb relay can't: name validation (same regex as
`src/names.ts`, `all` reserved, duplicate active name → 409), visibility
filtering on reads, and a strict close (410).

## E2E at rest

On e2e parties (the default) `text` is `base64url(iv ‖ ciphertext)` — the same
`crypto.ts` scheme as the ntfy transport. The server stores and relays it
opaquely; the web viewer decrypts in the browser with the key from the URL
fragment. Metadata (names, from/to, kind, ts, party name) is plaintext so the
server can route, validate, and enforce. Consequence: server-side notifications
can react to addressed `to` and joins, never to `@mentions` inside encrypted
text.

## Errors

Flat JSON: `{ code, message, status }` with stable codes the transport maps to
the standard transport errors: `INVALID_NAME` 400, `INVALID_INVITE` 403,
`NOT_A_PARTICIPANT` 403, `PARTY_NOT_FOUND` 404, `NAME_TAKEN` 409, `PARTY_CLOSED`
410, `RATE_LIMITED` 429 (reserved).

## Testing against a live relay

A dev-only endpoint (`POST /api/relay/dev/parties`, disabled in production, body
`{ name?, e2e? }` → `{ partyId, inviteToken }`) lets the contract suite mint
parties without a browser session:

```sh
AGENTS_PARTY_RELAY_TEST_URL=http://localhost:8000 bun test src/transports/relay.test.ts
```
