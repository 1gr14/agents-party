#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'
import { text as readStream } from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import { install } from './install.js'
import { generateInvitePrompt, generateSkillInvite } from './invite.js'
import { runPartyMcpServer } from './mcp.js'
import { connect } from './party.js'
import { REMOTE_COMING_SOON } from './transports/index.js'
import { createLocalParty } from './transports/local.js'
import { createNtfyParty } from './transports/ntfy.js'
import type { Message, Recipients } from './types.js'

const HELP = `agents-party — a party line for AI agents

Usage:
  agents-party create [--name <slug>] [--as host] [--desc <role>] [--ntfy] [--server <url>] [--dir <path>]
  agents-party join <ref> --as <name> [--desc <role>]
  agents-party send <ref> --as <name> [--to a,b | --to '*'] [--reply-to <msg-id>] [--diff] [text | reads stdin]
  agents-party read <ref> --as <name> [--since <cursor>] [--json]
  agents-party listen <ref> --as <name> [--since <cursor>] [--timeout <sec>] [--to-me] [--json]
  agents-party tail <ref> --as <name> [--since <cursor>] [--timeout <sec>] [--json]
  agents-party who <ref>
  agents-party leave <ref> --as <name>
  agents-party close <ref> --as <name>
  agents-party export <ref> --as <name> [--json]
  agents-party invite <ref> [--for <guest-name>] [--desc <role>] [--from <name>] [--skill]
  agents-party mcp [--ref <ref>] [--as <name>]
  agents-party install <claude|cursor|codex> [--global]
  agents-party help

A party is one shared channel for several agents; every command is stateless —
pass the ref and your name (--as) each time. Quote refs in single quotes (they
can contain # and other shell characters).

Refs:
  local:<path>                        SQLite file — agents on this machine
  ntfy:<server>/<topic>#k=<key>       E2E-encrypted ntfy topic — agents anywhere
  party:<host>/<id>#k=<key>&i=<inv>   hosted party on an agents-party relay

create --remote (hosted parties on agents-party.com — persistent history, no
rate limits, watch and reply from a browser) is coming soon; use --ntfy today.

Exit codes: 0 ok · 1 error · 2 listen timeout`

const formatTo = (to: Recipients): string => (to === 'all' ? 'all' : to.join(','))

const formatMessage = (msg: Message, json: boolean): string => {
  if (json) return JSON.stringify(msg)
  if (msg.kind !== 'message') return `[${msg.cursor}] * ${msg.text}`
  const diffMark = msg.diff === true ? ' [diff]' : ''
  return `[${msg.cursor}] ${msg.from} → ${formatTo(msg.to)}${diffMark}: ${msg.text}`
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

const run = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      as: { type: 'string' },
      to: { type: 'string' },
      since: { type: 'string' },
      timeout: { type: 'string' },
      server: { type: 'string' },
      dir: { type: 'string' },
      for: { type: 'string' },
      from: { type: 'string' },
      desc: { type: 'string' },
      ref: { type: 'string' },
      global: { type: 'boolean', default: false },
      'reply-to': { type: 'string' },
      'to-me': { type: 'boolean', default: false },
      remote: { type: 'boolean', default: false },
      ntfy: { type: 'boolean', default: false },
      diff: { type: 'boolean', default: false },
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
    if (values.remote) throw new Error(REMOTE_COMING_SOON)
    const as = values.as ?? 'host'
    const created = values.ntfy
      ? createNtfyParty({ server: values.server })
      : await createLocalParty({ name: values.name, dir: values.dir })
    const client = await connect(created.ref, { as })
    await client.join({ desc: values.desc })
    await client.close()
    console.log(`ref:    ${created.ref}`)
    console.log(`joined: ${as}`)
    if (values.ntfy) {
      console.log(`note:   the ref carries the E2E key (#k=…) — share it only with invitees`)
    }
    console.log(`invite: agents-party invite '${created.ref}' --for <guest-name>`)
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
    const result = install(process.cwd(), target, { global: values.global })
    if (result.file !== undefined) console.log(`installed: ${result.file}`)
    if (result.snippet !== undefined) console.log(result.snippet)
    return 0
  }

  if (command === 'invite') {
    const invite = { ref: need(ref, '<ref>'), guestName: values.for, desc: values.desc, from: values.from }
    console.log(values.skill ? generateSkillInvite(invite) : generateInvitePrompt(invite))
    return 0
  }

  if (command === 'who') {
    const client = await connect(need(ref, '<ref>'), { as: 'observer' })
    try {
      for (const p of await client.who()) {
        const status = p.leftTs === undefined ? 'active' : 'left'
        const desc = p.desc === undefined ? '' : `\t${p.desc}`
        console.log(`${p.name}\t${status}\tjoined ${new Date(p.joinedTs).toISOString()}${desc}`)
      }
    } finally {
      await client.close()
    }
    return 0
  }

  const knownCommands = ['join', 'send', 'read', 'listen', 'tail', 'leave', 'close', 'export']
  if (!knownCommands.includes(command)) {
    throw new Error(`unknown command "${command}" — run: agents-party help`)
  }

  const client = await connect(need(ref, '<ref>'), { as: need(values.as, '--as <name>') })
  try {
    switch (command) {
      case 'join': {
        await client.join({ desc: values.desc })
        console.log(`joined: ${client.name}`)
        return 0
      }
      case 'send': {
        const raw = rest.length > 0 ? rest.join(' ') : await readStream(process.stdin)
        // A diff is sent verbatim — trimming could damage the patch.
        const text = values.diff ? raw : raw.trim()
        if (!text.trim()) throw new Error('nothing to send — pass text or pipe it via stdin')
        const to: Recipients = values.to && values.to !== '*' ? values.to.split(',').map((s) => s.trim()) : 'all'
        const msg = await client.send(text, { to, replyTo: values['reply-to'], diff: values.diff })
        console.log(values.json ? JSON.stringify(msg) : `sent [${msg.cursor}] → ${formatTo(to)}`)
        return 0
      }
      case 'read': {
        for (const msg of await client.read({ since: values.since })) {
          console.log(formatMessage(msg, values.json))
        }
        return 0
      }
      case 'listen': {
        const timeoutMs = parseTimeoutMs(values.timeout)
        const messages = await client.listen({ since: values.since, timeoutMs, toMe: values['to-me'] })
        if (messages.length === 0) return 2
        for (const msg of messages) console.log(formatMessage(msg, values.json))
        return 0
      }
      case 'tail': {
        // Follow mode for humans: print the history, then messages as they
        // come, until --timeout (or forever without one). Own messages too.
        const timeoutMs = parseTimeoutMs(values.timeout)
        const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs
        const initial = await client.read({ since: values.since })
        for (const msg of initial) console.log(formatMessage(msg, values.json))
        let since = initial.at(-1)?.cursor ?? values.since
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, client.transport.pollIntervalMs))
          const messages = await client.read({ since })
          for (const msg of messages) console.log(formatMessage(msg, values.json))
          if (messages.length > 0) since = messages.at(-1)?.cursor
        }
        return 0
      }
      case 'leave': {
        await client.leave()
        console.log(`left: ${client.name}`)
        return 0
      }
      case 'close': {
        await client.endParty()
        console.log(`party closed by ${client.name} — no new joins or messages`)
        return 0
      }
      case 'export': {
        const [participants, messages] = await Promise.all([client.who(), client.read()])
        if (values.json) {
          for (const msg of messages) console.log(JSON.stringify(msg))
          return 0
        }
        console.log(`# agents-party transcript`)
        console.log(``)
        console.log(`- ref: \`${client.ref}\``)
        console.log(`- exported by: ${client.name} (their view) at ${new Date().toISOString()}`)
        console.log(
          `- participants: ${participants.map((p) => (p.desc === undefined ? p.name : `${p.name} (${p.desc})`)).join(', ')}`,
        )
        console.log(``)
        for (const msg of messages) {
          const time = new Date(msg.ts).toISOString()
          if (msg.kind !== 'message') {
            console.log(`- _${time} — ${msg.text}_`)
          } else {
            const reply = msg.replyTo === undefined ? '' : ` (reply to ${msg.replyTo})`
            if (msg.diff === true) {
              console.log(`- **${msg.from} → ${formatTo(msg.to)}**${reply} (${time}) sent a diff:`)
              console.log('')
              console.log('```diff')
              console.log(msg.text)
              console.log('```')
            } else {
              console.log(`- **${msg.from} → ${formatTo(msg.to)}**${reply} (${time}): ${msg.text}`)
            }
          }
        }
        return 0
      }
    }
    return 0
  } finally {
    await client.close()
  }
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
