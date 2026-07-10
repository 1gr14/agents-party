import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { HTTP_STATUS, TransportError } from './errors.js'
import { formatPartyRef } from './refs.js'
import { createLocalTransport, defaultPartyDir } from './transports/local.js'
import type { Message, Recipients, Transport } from './types.js'

/**
 * `agents-party serve` — expose one local party file over the relay HTTP API (dev/docs/relay-api.md), so relay clients
 * (the agents-party.com web chat pointed at another base URL, or the lib's own RelayTransport) can view and join a
 * LOCAL party. The server binds to 127.0.0.1 only: the file is plaintext and there is no TLS — this is a loopback
 * bridge, not a public relay.
 *
 * Auth mirrors the relay: one multi-use invite token is minted at startup (printed as a `party:` ref), join exchanges
 * it for a per-participant token. Tokens persist in `<dir>/serve-tokens.json` so a restarted serve doesn't lock
 * participants out of their names. CORS is open — auth lives in non-ambient custom headers, so a foreign page can't do
 * anything without the token, and the preflight answers `Access-Control-Allow-Private-Network` for Chrome's local
 * network access checks.
 */

interface WireMessage {
  cursor: string
  id: string
  ts: number
  from: string
  to: 'all' | string[]
  kind: Message['kind']
  text: string
  replyTo?: string
  diff?: boolean
}

const toWire = (msg: Message): WireMessage => ({
  cursor: msg.cursor,
  id: msg.id,
  ts: msg.ts,
  from: msg.from,
  to: msg.to === '*' ? 'all' : msg.to,
  kind: msg.kind,
  text: msg.text,
  ...(msg.replyTo === undefined ? {} : { replyTo: msg.replyTo }),
  ...(msg.diff === true ? { diff: true } : {}),
})

const fromWireTo = (to: unknown): Recipients => {
  if (to === undefined || to === 'all' || to === '*') return '*'
  if (Array.isArray(to) && to.every((n) => typeof n === 'string')) return to as string[]
  throw new TransportError('INVALID_NAME', 'Invalid "to" — expected "all" or an array of names.')
}

// A name no participant can have (names can't contain '@') — reads with only the invite token see broadcasts.
const INVITE_VIEWER = '@invite'

const TOKENS_FILE = 'serve-tokens.json'

/** Persisted per-participant tokens, keyed by `<file-path>#<name>` — same pattern as relay-tokens.json. */
class ServeTokens {
  private readonly file: string
  constructor(dir: string) {
    this.file = path.join(dir, TOKENS_FILE)
  }
  private readAll(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }
  mint(partyPath: string, name: string): string {
    const token = randomBytes(24).toString('base64url')
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tokens = this.readAll()
    tokens[`${partyPath}#${name}`] = token
    fs.writeFileSync(this.file, JSON.stringify(tokens, null, 2))
    return token
  }
  drop(partyPath: string, name: string): void {
    const tokens = this.readAll()
    if (!(`${partyPath}#${name}` in tokens)) return
    delete tokens[`${partyPath}#${name}`]
    fs.writeFileSync(this.file, JSON.stringify(tokens, null, 2))
  }
  nameFor(partyPath: string, token: string): string | undefined {
    const prefix = `${partyPath}#`
    for (const [key, value] of Object.entries(this.readAll())) {
      if (value === token && key.startsWith(prefix)) return key.slice(prefix.length)
    }
    return undefined
  }
}

export interface ServeOptions {
  /** Absolute path to the local party's SQLite file. */
  path: string
  /** Port to bind on 127.0.0.1; 0 (default) picks a free one. */
  port?: number
  /** Where serve-tokens.json lives — defaults to the agents-party dir. */
  dir?: string
}

export interface ServeHandle {
  port: number
  partyId: string
  inviteToken: string
  /** `party:127.0.0.1:<port>/<partyId>#i=<invite>` — hand this to relay clients. */
  ref: string
  stop(): Promise<void>
}

const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
}

const sendError = (res: http.ServerResponse, error: unknown): void => {
  if (error instanceof TransportError) {
    const status = HTTP_STATUS[error.code]
    sendJson(res, status, { code: error.code, message: error.message, status })
    return
  }
  sendJson(res, 500, { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error), status: 500 })
}

const readBody = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    throw new TransportError('INVALID_NAME', 'Invalid JSON body.')
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const startServe = async (opts: ServeOptions): Promise<ServeHandle> => {
  const partyPath = path.resolve(opts.path)
  if (!fs.existsSync(partyPath)) {
    throw new TransportError('PARTY_NOT_FOUND', `No party file at ${partyPath}`)
  }
  const transport: Transport = await createLocalTransport(partyPath)
  let closed = false
  const partyId = path.basename(partyPath).replace(/\.sqlite$/, '')
  const inviteToken = randomBytes(24).toString('base64url')
  const tokens = new ServeTokens(opts.dir ?? defaultPartyDir())

  const participantName = (req: http.IncomingMessage): string => {
    const token = req.headers['x-participant-token']
    const name = typeof token === 'string' ? tokens.nameFor(partyPath, token) : undefined
    if (name === undefined) throw new TransportError('NOT_A_PARTICIPANT', 'You are not at this party — join first.')
    return name
  }

  /** Participant token, or the startup invite token for read-only endpoints (who-before-join). */
  const viewerName = (req: http.IncomingMessage): string => {
    const invite = req.headers['x-invite-token']
    if (typeof invite === 'string') {
      if (invite !== inviteToken) throw new TransportError('INVALID_INVITE', 'The invite token is invalid.')
      return INVITE_VIEWER
    }
    return participantName(req)
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-invite-token, x-participant-token',
        'access-control-allow-private-network': 'true',
        'access-control-max-age': '86400',
      })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const prefix = `/api/relay/parties/${encodeURIComponent(partyId)}/`
    if (!url.pathname.startsWith(prefix)) {
      throw new TransportError('PARTY_NOT_FOUND', 'Party not found on this server — check the ref.')
    }
    const endpoint = `${req.method} ${url.pathname.slice(prefix.length)}`

    switch (endpoint) {
      case 'POST join': {
        const invite = req.headers['x-invite-token']
        if (invite !== inviteToken) {
          throw new TransportError('INVALID_INVITE', 'The invite token is invalid.')
        }
        const body = await readBody(req)
        const name = typeof body.name === 'string' ? body.name : ''
        const desc = typeof body.desc === 'string' ? body.desc : undefined
        const participant = await transport.join(name, desc === undefined ? {} : { desc })
        return sendJson(res, 200, { participant, token: tokens.mint(partyPath, name) })
      }
      case 'POST leave': {
        const name = participantName(req)
        await transport.leave(name)
        tokens.drop(partyPath, name)
        return sendJson(res, 200, { ok: true })
      }
      case 'POST messages': {
        const name = participantName(req)
        const body = await readBody(req)
        if (typeof body.text !== 'string') throw new TransportError('INVALID_NAME', 'Missing "text".')
        const msg = await transport.send({
          from: name,
          to: fromWireTo(body.to),
          kind: 'message',
          text: body.text,
          ...(typeof body.replyTo === 'string' ? { replyTo: body.replyTo } : {}),
          ...(body.diff === true ? { diff: true } : {}),
        })
        return sendJson(res, 200, toWire(msg))
      }
      case 'GET messages': {
        const name = viewerName(req)
        const since = url.searchParams.get('since') ?? undefined
        const messages = await transport.read({ for: name, ...(since === undefined ? {} : { since }) })
        return sendJson(res, 200, { messages: messages.map(toWire) })
      }
      case 'GET listen': {
        const name = participantName(req)
        const since = url.searchParams.get('since') ?? undefined
        const timeoutSec = Math.min(55, Math.max(1, Number(url.searchParams.get('timeoutSec')) || 25))
        const deadline = Date.now() + timeoutSec * 1000
        while (!closed && Date.now() < deadline) {
          // Re-read from the caller's own `since` each tick: the response must be the full gapless batch — an
          // internal cursor would skip the caller's own messages from the stream forever (the client advances
          // `since` past them). A foreign message is what ends the long-poll; own sends don't.
          const messages = await transport.read({ for: name, ...(since === undefined ? {} : { since }) })
          if (messages.some((m) => m.from !== name)) return sendJson(res, 200, { messages: messages.map(toWire) })
          await sleep(transport.pollIntervalMs)
        }
        return sendJson(res, 200, { messages: [] })
      }
      case 'GET participants': {
        viewerName(req) // any valid credential — the list itself is not filtered
        return sendJson(res, 200, { participants: await transport.participants() })
      }
      case 'POST invites': {
        participantName(req)
        return sendJson(res, 200, { inviteToken })
      }
      case 'POST close': {
        const name = participantName(req)
        await transport.send({ from: name, to: '*', kind: 'close', text: `${name} closed the party` })
        return sendJson(res, 200, { ok: true })
      }
      default:
        throw new TransportError('PARTY_NOT_FOUND', `Unknown endpoint: ${endpoint}`)
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => sendError(res, error))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const host = `127.0.0.1:${port}`

  return {
    port,
    partyId,
    inviteToken,
    ref: formatPartyRef({ host, partyId, invite: inviteToken }),
    stop: async () => {
      closed = true // ends pending /listen loops; server.close alone would wait out their long-polls
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
      // Give any in-flight poll one tick to leave its read before the db handle goes away.
      await sleep(transport.pollIntervalMs)
      await transport.close()
    },
  }
}
