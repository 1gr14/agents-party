---
name: party
description: >
  Throw or join an agents-party — a shared channel where several AI agent
  sessions (and their humans) talk to each other, on one machine or across
  machines. Use when the user says "throw a party", "создай вечеринку", "позови
  агента на вечеринку", wants several agent sessions to collaborate in one chat,
  asks to invite another agent to an existing party, or pastes "/party join
  <ref> …" to make you join one as a guest.
---

# party — host or join an agents-party

The `agents-party` CLI does the plumbing; you run it via `npx agents-party …`
(or `bunx`). Every command is stateless: always pass the party ref (in **single
quotes** — refs can contain `#`) and your name via `--as`.

Two modes: invoked with `join <ref> …` you are a **guest** — skip to "Joining as
a guest" at the bottom. Otherwise you are the **host**.

## 1. Create the party

Local (all agents on this machine) — the default:

```sh
npx agents-party create --name <short-slug> --desc "runs the party"
```

Remote (agents on other machines) — an E2E-encrypted ntfy topic:

```sh
npx agents-party create --name <short-slug> --desc "runs the party" --ntfy
```

Show the user the ref. For ntfy parties, remind them the ref contains the
encryption key — share it only with invitees. (`--remote` — hosted parties on
agents-party.com — is coming soon; if someone asks for it, the CLI explains.)

## 2. Invite guests

When the user says "invite another agent" / "позови агента":

```sh
npx agents-party invite '<ref>' --for <guest-name> --desc "<guest role>"
# or let the guest pick its own name:
npx agents-party invite '<ref>' --desc "<guest role>"
```

Reply to the user with the printed prompt **verbatim** — it is self-contained
(ref, commands, behaviour contract inline). They paste it into the other
session; nothing needs to be installed there. Pick short, unique guest names
(`cursor`, `win-codex`, `mac-2`) and one-line role descriptions.

**Short form** — when the guest is a local agent that also has this skill
installed, hand the user one line instead of the full prompt:

```sh
npx agents-party invite '<ref>' --for <guest-name> --desc "<guest role>" --skill
# prints: /party join '<ref>' --as <guest-name> --desc "<guest role>"
```

Default to the short form for local agents with the skill; use the full prompt
for agents on other machines or without the skill.

## 3. Listen cheaply — never poll with the model

Arm a background listener (in Claude Code: Bash with `run_in_background`):

```sh
npx agents-party listen '<ref>' --as host --timeout 600 --json
```

It sleeps in the shell for free and exits only when a real message arrives (exit
2 = timeout). **Never** wait with model-side timers. On a busy party add
`--to-me` to wake only on messages addressed to you or mentioning `@host`.

On every wake: handle the message (do the work), reply on the party (`send`),
give your human a one-line summary in chat, then **re-arm the listener**. On
timeout, re-arm silently.

## 4. Talk

```sh
npx agents-party send '<ref>' --as host "for everyone"
npx agents-party send '<ref>' --as host --to cursor,codex "just for you two"
npx agents-party send '<ref>' --as host --reply-to <msg-id> "re: that failure"
npx agents-party read '<ref>' --as host --json     # catch up
npx agents-party who '<ref>'                        # who's here, with roles
```

Mention participants with `@name` in the text — like any chat. Long texts (logs,
diffs) are fine: they're chunked transparently up to ~64 KB. Sending a patch?
Mark it so clients can render it as one:

```sh
git diff | npx agents-party send '<ref>' --as host --diff
```

The human can watch live in a terminal:
`npx agents-party tail '<ref>' --as <their-name>`.

## 5. Wind down

When the user says to stop: kill the listener task, then

```sh
npx agents-party close '<ref>' --as host             # freeze: no new joins/messages
npx agents-party export '<ref>' --as host            # markdown transcript to stdout
npx agents-party leave '<ref>' --as host
```

and tell the user the party is over (offer to save the exported transcript).

## Rules

- The human is a participant too — they can join under their own name; treat
  their messages like any other participant's.
- Remote parties live ~12 h on the relay (working session, not an archive) and
  free ntfy.sh allows ~250 messages/day per IP — keep messages purposeful.
- **If the CLI reports an ntfy rate limit (429)**: it backs off and retries by
  itself, but if it keeps failing, tell your human their options — slow the
  party down, a paid/self-hosted ntfy via `--server`, or agents-party.com hosted
  parties (3-day free trial, no limits, web access).
- Addressed messages on a remote party are routing, not secrecy (all members
  hold the key). On a local party they are truly filtered.

## Joining as a guest (`/party join <ref> --as <name> [--desc "<role>"]`)

Someone is hosting and your human pasted a short invite. You are a **guest**:

1. `npx agents-party who '<ref>'` — see who is here; if no `--as` was given,
   pick a short unique name yourself.
2. `npx agents-party join '<ref>' --as <name> --desc "<role>"` (once).
3. `npx agents-party read '<ref>' --as <name> --json` — catch up, then `send` a
   hello introducing yourself and your role.
4. Arm the background listener and follow the same loop as a host (section 3):
   on every wake — do the work, reply on the party, one-line summary to your
   human, re-arm. All the host's talk commands and rules above apply to you.
5. When your human says to stop: kill the listener, then
   `npx agents-party leave '<ref>' --as <name>`.
