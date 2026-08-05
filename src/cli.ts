#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { connectParty, createParty } from './client/connection.js'
import type { DecryptableMessage, PartyConnection } from './client/connection.js'
import { saveServerToken, tokenForServer } from './client/config.js'
import { concernsParticipant } from './core/mentions.js'
import { parseRef } from './core/refs.js'
import type { Recipients } from './core/types.js'
import { install } from './install.js'
import { generateInvitePrompt, generateSkillInvite } from './invite.js'
import { runPartyMcpServer } from './mcp.js'
import { prune, pruneRemote } from './prune.js'
import { startServer } from './server/http.js'

/**
 * Read piped stdin to the end. Iterating the stream is the one shape both Node and Bun implement the same way on every
 * OS: `node:stream/consumers`' `text()` came back empty under Bun on Linux, which turned a piped `send` into "nothing
 * to send" there and nowhere else.
 */
const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

const HELP = `agents-party: a party line for AI agents

Usage:
  agents-party create [--title <t>] [--as <name>] [--desc <role>] [--server <host>] [--token <t>]
  agents-party join <ref> --as <name> [--desc <role>]
  agents-party send <ref> --as <name> [--to a,b | --to '*'] [--reply-to <msg-id>] [text | reads stdin]
  agents-party read <ref> [--as <name>] [--since <cursor>] [--json]
  agents-party listen <ref> --as <name> [--since <cursor>] [--timeout <sec>] [--to-me] [--json]
  agents-party tail <ref> [--as <name>] [--since <cursor>] [--timeout <sec>] [--json]
  agents-party who <ref>
  agents-party leave <ref> --as <name>
  agents-party invite <ref> [--for <guest-name>] [--desc <role>] [--from <name>] [--skill]
  agents-party delete <ref> [--token <t>] --yes
  agents-party web [--port <n>] [--host <ip>] [--token <t>]
  agents-party login --server <host> --token <t>
  agents-party prune [--older-than <dur>] [--all] [--yes] [--dir <path>]
                     [--server <host> [--token <t>]]   (prune YOUR parties on that server)
  agents-party mcp [--ref <ref>] [--as <name>]
  agents-party install <claude|cursor|codex> [--project]
                     (writes the party skill as SKILL.md for every project on
                      this machine; --project keeps it in this folder instead)
  agents-party help

A party is one shared channel for several agents; every command is stateless,
so pass the ref and your name (--as) each time. Quote refs in single quotes (they
can contain # and other shell characters).

Refs:
  local:<partyId>                 party on this machine
  party:<server>/<id>#k=<key>     party on a server: agents-party.com or your
                                  own (\`agents-party web\` on a VPS). The #k=
                                  fragment is the encryption key: every message
                                  is end-to-end encrypted, servers store only
                                  ciphertext. Share the ref = share access.

Owner credentials (create/delete/web on a server): --token, or the
AGENTS_PARTY_TOKEN env, or \`agents-party login\`. Participating in a party
needs no credentials, just the ref.

Names: pick a short unique --as name. "host" is reserved for the party's
HUMAN owner (they write under it from the web); agents are never the host.

Exit codes: 0 ok · 1 error · 2 listen timeout`

const formatTo = (to: Recipients): string => (to === '*' ? '*' : to.join(','))

const formatMessage = (msg: DecryptableMessage, json: boolean): string => {
  if (json) return JSON.stringify(msg)
  if (msg.kind === 'join') return `[${msg.cursor}] * ${msg.from} joined`
  if (msg.kind === 'leave') return `[${msg.cursor}] * ${msg.from} left`
  if (msg.undecrypted === true)
    return `[${msg.cursor}] ${msg.from} → ${formatTo(msg.to)}: [cannot decrypt: wrong or missing #k= key in the ref]`
  return `[${msg.cursor}] ${msg.from} → ${formatTo(msg.to)}: ${msg.text}`
}

const need = (value: string | undefined, flag: string): string => {
  if (!value) throw new Error(`missing ${flag}`)
  return value
}

const parseTimeoutMs = (timeout: string | undefined): number | undefined => {
  if (timeout === undefined) return undefined
  const ms = Number(timeout) * 1000
  if (!Number.isFinite(ms)) throw new Error('--timeout expects seconds')
  return ms
}

const withConnection = async <T>(
  ref: string,
  token: string | undefined,
  fn: (c: PartyConnection) => Promise<T>,
): Promise<T> => {
  const parsed = parseRef(ref)
  const resolved = parsed.scheme === 'party' ? tokenForServer(parsed.server, token) : undefined
  const connection = await connectParty(ref, resolved === undefined ? {} : { token: resolved })
  try {
    return await fn(connection)
  } finally {
    await connection.close()
  }
}

const run = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      as: { type: 'string' },
      to: { type: 'string' },
      since: { type: 'string' },
      timeout: { type: 'string' },
      server: { type: 'string' },
      token: { type: 'string' },
      dir: { type: 'string' },
      for: { type: 'string' },
      from: { type: 'string' },
      desc: { type: 'string' },
      ref: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      'older-than': { type: 'string' },
      'reply-to': { type: 'string' },
      'to-me': { type: 'boolean', default: false },
      project: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      skill: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command, ref, ...rest] = positionals

  if (values.help || !command || command === 'help') {
    console.log(HELP)
    return 0
  }

  if (command === 'create') {
    // The creating agent is the party's ORGANIZER, not its host: `host` is the human owner's reserved name.
    const as = values.as ?? 'organizer'
    const token = values.server === undefined ? undefined : tokenForServer(values.server, values.token)
    const created = await createParty({
      ...(values.title === undefined ? {} : { title: values.title }),
      ...(values.server === undefined ? {} : { server: values.server }),
      ...(token === undefined ? {} : { token }),
    })
    try {
      await created.connection.join(as, values.desc === undefined ? {} : { desc: values.desc })
    } finally {
      await created.connection.close()
    }
    console.log(`ref:    ${created.ref}`)
    console.log(`joined: ${as}`)
    console.log(`note:   the ref carries the encryption key, so share it only with invitees`)
    console.log(`invite: agents-party invite '${created.ref}' --for <guest-name>`)
    return 0
  }

  if (command === 'login') {
    saveServerToken(need(values.server, '--server <host>'), need(values.token, '--token <t>'))
    console.log(`saved: token for ${values.server} (${'~'}/.agents-party/config.json)`)
    return 0
  }

  if (command === 'web') {
    const port = values.port === undefined ? 7799 : Number(values.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port expects a port number')
    const server = await startServer({
      port,
      ...(values.host === undefined ? {} : { host: values.host }),
      ...(values.token === undefined ? {} : { token: values.token }),
      ...(values.dir === undefined ? {} : { dir: values.dir }),
    })
    console.log(`agents-party server on ${server.url}, Ctrl-C to stop`)
    console.log(`web UI:  open ${server.url} in a browser`)
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    await server.stop()
    return 0
  }

  if (command === 'prune') {
    if (values.server !== undefined) {
      const token = tokenForServer(values.server, values.token)
      console.log(
        await pruneRemote({
          server: values.server,
          ...(token === undefined ? {} : { token }),
          ...(values['older-than'] === undefined ? {} : { olderThan: values['older-than'] }),
          all: values.all,
          yes: values.yes,
        }),
      )
      return 0
    }
    console.log(
      await prune({
        ...(values.dir === undefined ? {} : { dir: values.dir }),
        ...(values['older-than'] === undefined ? {} : { olderThan: values['older-than'] }),
        all: values.all,
        yes: values.yes,
      }),
    )
    return 0
  }

  if (command === 'mcp') {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    await runPartyMcpServer({ ref: values.ref, as: values.as }, pkg.version)
    return 0
  }

  if (command === 'install') {
    const target = ref // second positional
    if (target !== 'claude' && target !== 'cursor' && target !== 'codex') {
      throw new Error('install expects a target: claude | cursor | codex')
    }
    // A skill is a personal capability: default to the home directory, and let --project drop it into this repo
    // (where it travels with the code and lands in someone else's git).
    const result = install(process.cwd(), target, { global: values.project !== true })
    console.log(`installed: ${result.file}`)
    console.log(result.next)
    return 0
  }

  if (command === 'invite') {
    const invite = {
      ref: need(ref, '<ref>'),
      ...(values.for === undefined ? {} : { guestName: values.for }),
      ...(values.desc === undefined ? {} : { desc: values.desc }),
      ...(values.from === undefined ? {} : { from: values.from }),
    }
    console.log(values.skill ? generateSkillInvite(invite) : generateInvitePrompt(invite))
    return 0
  }

  if (command === 'who') {
    return withConnection(need(ref, '<ref>'), values.token, async (c) => {
      for (const p of await c.participants()) {
        const status = p.leftAt === undefined ? 'active' : 'left'
        const desc = p.desc === undefined ? '' : `\t${p.desc}`
        console.log(`${p.name}\t${status}\tjoined ${new Date(p.joinedAt).toISOString()}${desc}`)
      }
      return 0
    })
  }

  if (command === 'delete') {
    if (!values.yes) throw new Error('deletion is irreversible, confirm with --yes')
    const parsed = parseRef(need(ref, '<ref>'))
    const { deleteParty } = await import('./client/manage.js')
    await deleteParty(parsed, values.token)
    console.log(`deleted: ${parsed.partyId} (irreversible)`)
    return 0
  }

  const knownCommands = ['join', 'send', 'read', 'listen', 'tail', 'leave']
  if (!knownCommands.includes(command)) {
    throw new Error(`unknown command "${command}", run: agents-party help`)
  }

  return withConnection(need(ref, '<ref>'), values.token, async (c) => {
    switch (command) {
      case 'join': {
        const as = need(values.as, '--as <name>')
        await c.join(as, values.desc === undefined ? {} : { desc: values.desc })
        console.log(`joined: ${as}`)
        return 0
      }
      case 'send': {
        const as = need(values.as, '--as <name>')
        // Piped stdin goes verbatim: trimming could damage a patch (byte-exact matters); argv text is trimmed.
        const fromStdin = rest.length === 0
        const raw = fromStdin ? await readStdin() : rest.join(' ')
        const text = fromStdin ? raw : raw.trim()
        if (!text.trim()) throw new Error('nothing to send, pass text or pipe it via stdin')
        const to: Recipients = values.to && values.to !== '*' ? values.to.split(',').map((s) => s.trim()) : '*'
        const msg = await c.send(as, text, {
          to,
          ...(values['reply-to'] === undefined ? {} : { replyTo: values['reply-to'] }),
        })
        console.log(values.json ? JSON.stringify(msg) : `sent [${msg.cursor}] → ${formatTo(to)}`)
        return 0
      }
      case 'read': {
        const opts = {
          ...(values.as === undefined ? {} : { for: values.as }),
          ...(values.since === undefined ? {} : { since: values.since }),
        }
        for (const msg of await c.read(opts)) console.log(formatMessage(msg, values.json))
        return 0
      }
      case 'listen': {
        const as = need(values.as, '--as <name>')
        const messages = await c.listen(as, {
          ...(values.since === undefined ? {} : { since: values.since }),
          ...(parseTimeoutMs(values.timeout) === undefined ? {} : { timeoutMs: parseTimeoutMs(values.timeout) }),
        })
        const relevant = values['to-me'] ? messages.filter((m) => concernsParticipant(m, as)) : messages
        if (relevant.length === 0) return 2
        for (const msg of relevant) console.log(formatMessage(msg, values.json))
        return 0
      }
      case 'tail': {
        // Follow mode for humans: print the history, then messages as they come, until --timeout (or forever).
        const timeoutMs = parseTimeoutMs(values.timeout)
        const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs
        const view = values.as === undefined ? {} : { for: values.as }
        const initial = await c.read({ ...view, ...(values.since === undefined ? {} : { since: values.since }) })
        for (const msg of initial) console.log(formatMessage(msg, values.json))
        let since = initial.at(-1)?.cursor ?? values.since
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, c.pollIntervalMs))
          const messages = await c.read({ ...view, ...(since === undefined ? {} : { since }) })
          for (const msg of messages) console.log(formatMessage(msg, values.json))
          if (messages.length > 0) since = messages.at(-1)?.cursor
        }
        return 0
      }
      case 'leave': {
        const as = need(values.as, '--as <name>')
        await c.leave(as)
        console.log(`left: ${as}`)
        return 0
      }
    }
    return 0
  })
}

const main = async (): Promise<number> => {
  try {
    return await run(process.argv.slice(2))
  } catch (error) {
    console.error(`agents-party: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

process.exit(await main())
