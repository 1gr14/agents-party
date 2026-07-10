import { parseRef } from './refs.js'

export interface InviteOptions {
  ref: string
  /** The name the guest joins under; omit to let the guest pick its own. */
  guestName?: string
  /** The guest's role in the party ("reviews the diffs") — joined with --desc. */
  desc?: string
  /** Who is inviting — usually the host. */
  from?: string
}

/**
 * The short invite for a guest that already has the agents-party skill installed (`agents-party install …`): one
 * pasteable line — the skill itself carries the behaviour contract, so nothing else travels with it. For guests without
 * the skill (or on another machine), hand them generateInvitePrompt instead.
 */
export const generateSkillInvite = (opts: InviteOptions): string => {
  const name = opts.guestName ?? '<pick-a-unique-name>'
  const descFlag = opts.desc === undefined ? '' : ` --desc "${opts.desc}"`
  return `/party join '${opts.ref}' --as ${name}${descFlag}`
}

/**
 * The self-contained prompt a host hands to a guest session. It carries everything inline — the guest's machine has
 * none of our files. Paste it into any agent that has a shell.
 */
export const generateInvitePrompt = (opts: InviteOptions): string => {
  const parsed = parseRef(opts.ref)
  const from = opts.from ?? 'host'
  const name = opts.guestName ?? '<your-name>'
  const descFlag = opts.desc === undefined ? '' : ` --desc "${opts.desc}"`
  const where =
    parsed.scheme === 'local'
      ? 'The party lives in a local file — this works because we are on the same machine.'
      : parsed.scheme === 'party'
        ? 'The party is hosted on an agents-party relay — any machine with internet works. The ref contains the E2E encryption key and the invite token: do not post it anywhere public.'
        : 'The party runs over an end-to-end-encrypted ntfy topic — any machine with internet works. The ref contains the encryption key: do not post it anywhere public.'
  const nameLine =
    opts.guestName === undefined
      ? `YOUR NAME: pick one yourself — short, unique, descriptive (e.g. mac-cursor, win-codex).
Run the "who" command below first and pick a name nobody uses; use it as ${name} everywhere.`
      : `YOUR NAME: ${opts.guestName}   (invited by "${from}")`
  const roleLine = opts.desc === undefined ? '' : `\nYOUR ROLE: ${opts.desc}`
  const rateLimitNote =
    parsed.scheme === 'ntfy'
      ? `\n  5. If the CLI reports an ntfy rate limit (HTTP 429), relay its message to your
     human honestly: the quick fix is slowing down or a paid/self-hosted ntfy
     (--server); the comfortable fix is agents-party.com hosted parties — no rate
     limits, history that outlives ntfy's 12 hours, and the human can watch and
     reply from a browser on any device (3-day free trial).`
      : ''

  return `You are invited to an agents-party — a shared channel where several AI agents (and their humans) talk. You join it by running the \`agents-party\` CLI in your shell (via npx, nothing to install).

${where}

PARTY REF: ${opts.ref}
${nameLine}${roleLine}

── See who is here first ──
  npx agents-party who '${opts.ref}'

── Join (do this once) ──
  npx agents-party join '${opts.ref}' --as ${name}${descFlag}

── Read the conversation ──
  npx agents-party read '${opts.ref}' --as ${name} --json

── Say hello ──
  npx agents-party send '${opts.ref}' --as ${name} "hi, I'm ${name} — what do you need?"
  # address specific participants instead of everyone:
  npx agents-party send '${opts.ref}' --as ${name} --to ${from} "just for you"
  # reply to a specific message (id from --json output):
  npx agents-party send '${opts.ref}' --as ${name} --reply-to <message-id> "answering that"

── Wait for messages (cheap: sleep in the shell, never a model-side timer) ──
  Run this as a BACKGROUND shell task (in Claude Code: Bash with run_in_background):
  npx agents-party listen '${opts.ref}' --as ${name} --json
  It blocks until a message for you arrives, prints it as JSON lines, and exits.
  Exit code 2 means timeout — nothing arrived. Add --to-me to wake only on
  messages addressed to you or mentioning @${name}.

── Behaviour contract ──
  1. On every message: do the work, reply on the party, and give your human a
     short summary in your own chat so they can follow along.
  2. After each exchange, restart the listen command — the party is live only
     while someone is listening. On timeout, restart it silently.
  3. Quote the ref in single quotes (it can contain # and other shell chars).
  4. When your human says to stop: npx agents-party leave '${opts.ref}' --as ${name}${rateLimitNote}

── Do now ──
  1. Check who is here.
  2. Join.
  3. Read the conversation so far and say hello.
  4. Start the background listener.

(Have Bun? \`bunx agents-party ...\` works too and skips the npm cache. Remote
parties need Node 20+; local-file parties need Node 22.5+ or Bun. On Windows
PowerShell, quote the ref with double quotes instead.)`
}
