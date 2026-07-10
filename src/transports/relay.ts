import fs from 'node:fs'
import path from 'node:path'
import { decryptText, encryptText } from '../crypto.js'
import { validateParticipantName } from '../names.js'
import { isVisibleTo } from '../types.js'
import type { JoinOptions, Message, NewMessage, Participant, ReadOptions, Transport } from '../types.js'
import { defaultPartyDir } from './local.js'

/**
 * The hosted-relay transport: a party living on an agents-party relay (agents-party.com, or any deployment of the
 * site). Refs look like `party:<host>/<partyId>#k=<key>&i=<invite>` — `k` is the E2E key (message text is AES-256-GCM
 * ciphertext on the wire and at rest, the relay can't read it; absent on `--no-e2e` parties), `i` is the multi-use
 * invite token presented once at join. Fragments never reach the server.
 *
 * Identity is a per-participant token minted by the relay at join; it is cached in `~/.agents-party/relay-tokens.json`
 * so every later stateless CLI call can speak as the same name from this machine. Visibility filtering, name
 * validation, and close enforcement are the SERVER's job here (metadata is plaintext) — this client just maps the
 * relay's stable error codes onto the same messages the other transports throw.
 */

interface RelayError {
  code?: string
  message?: string
}

// The relay wire spells "everyone" as 'all'; the public model spells it '*' — translated at this boundary.
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

const wireTo = (to: Message['to']): 'all' | string[] => (to === '*' ? 'all' : to)
const modelTo = (to: WireMessage['to']): Message['to'] => (to === 'all' ? '*' : to)

const TOKENS_FILE = 'relay-tokens.json'

/** Best-effort local cache of per-participant tokens, keyed by `<host>/<partyId>#<name>`. */
const tokensPath = (): string => path.join(defaultPartyDir(), TOKENS_FILE)

const readTokens = (): Record<string, string> => {
  try {
    return JSON.parse(fs.readFileSync(tokensPath(), 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

const writeToken = (key: string, token: string): void => {
  fs.mkdirSync(defaultPartyDir(), { recursive: true })
  const tokens = readTokens()
  tokens[key] = token
  fs.writeFileSync(tokensPath(), JSON.stringify(tokens, null, 2))
}

const dropToken = (key: string): void => {
  const tokens = readTokens()
  if (!(key in tokens)) return
  delete tokens[key]
  fs.writeFileSync(tokensPath(), JSON.stringify(tokens, null, 2))
}

const errorFromRelay = (status: number, body: RelayError, fallback: string): Error => {
  switch (body.code ?? '') {
    case 'NAME_TAKEN':
      return new Error(`The name is already taken at this party — pick another one.`)
    case 'NOT_A_PARTICIPANT':
      return new Error(`You are not at this party — join first.`)
    case 'PARTY_CLOSED':
      return new Error('This party is closed — no new messages or joins.')
    case 'PARTY_NOT_FOUND':
      return new Error('Party not found on the relay — check the ref.')
    case 'INVALID_INVITE':
      return new Error('The invite token is invalid — ask the host for a fresh invite (the #i=… part of the ref).')
    case 'INVALID_NAME':
      return new Error('Invalid participant name.')
    case 'RATE_LIMITED':
      return new Error('The relay is rate-limiting this party — slow down and retry.')
    default:
      return new Error(body.message ?? `${fallback}: HTTP ${status}`)
  }
}

export class RelayTransport implements Transport {
  readonly pollIntervalMs = 2000

  constructor(
    private readonly baseUrl: string,
    private readonly host: string,
    private readonly partyId: string,
    private readonly key?: string,
    private readonly invite?: string,
  ) {}

  private url(suffix: string): string {
    return `${this.baseUrl}/api/relay/parties/${encodeURIComponent(this.partyId)}${suffix}`
  }

  private tokenKey(name: string): string {
    return `${this.host}/${this.partyId}#${name}`
  }

  private async request<T>(
    method: 'GET' | 'POST',
    suffix: string,
    opts: { body?: unknown; headers?: Record<string, string>; fallback: string; timeoutMs?: number },
  ): Promise<T> {
    const response = await fetch(this.url(suffix), {
      method,
      headers: {
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...opts.headers,
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = {}
    }
    if (!response.ok) {
      throw errorFromRelay(response.status, parsed as RelayError, opts.fallback)
    }
    return parsed as T
  }

  private participantHeaders(name: string): Record<string, string> {
    const token = readTokens()[this.tokenKey(name)]
    if (!token) {
      // The relay's token IS the identity; without a cached one this process never joined from this machine.
      throw new Error(`"${name}" is not at this party — join first.`)
    }
    return { 'x-participant-token': token }
  }

  private async decryptMessage(wire: WireMessage): Promise<Message | null> {
    const base: Message = {
      cursor: wire.cursor,
      id: wire.id,
      ts: wire.ts,
      from: wire.from,
      to: modelTo(wire.to),
      kind: wire.kind,
      text: wire.text,
      ...(wire.replyTo === undefined ? {} : { replyTo: wire.replyTo }),
      ...(wire.diff === true ? { diff: true } : {}),
    }
    if (this.key === undefined || wire.kind !== 'message') return base
    const plaintext = await decryptText(this.key, wire.text)
    if (plaintext === null) return null // foreign/undecryptable — skip silently, like the ntfy transport
    return { ...base, text: plaintext }
  }

  private async decryptAll(wires: WireMessage[]): Promise<Message[]> {
    const messages: Message[] = []
    for (const wire of wires) {
      const message = await this.decryptMessage(wire)
      if (message !== null) messages.push(message)
    }
    return messages
  }

  async join(name: string, opts: JoinOptions = {}): Promise<Participant> {
    validateParticipantName(name)
    if (!this.invite) {
      throw new Error('Joining a relay party needs the invite token — use the full ref with #…i=<invite>.')
    }
    const result = await this.request<{ participant: Participant; token: string }>('POST', '/join', {
      body: { name, ...(opts.desc === undefined ? {} : { desc: opts.desc }) },
      headers: { 'x-invite-token': this.invite },
      fallback: 'relay join failed',
    })
    writeToken(this.tokenKey(name), result.token)
    return result.participant
  }

  async leave(name: string): Promise<void> {
    let headers: Record<string, string>
    try {
      headers = this.participantHeaders(name)
    } catch {
      return // never joined from here — leaving is a no-op, like the other transports
    }
    try {
      await this.request('POST', '/leave', { headers, fallback: 'relay leave failed' })
    } catch (error) {
      // Leaving twice is fine everywhere else; a stale token means we're effectively out already.
      if (!(error instanceof Error) || !error.message.includes('not at this party')) throw error
    } finally {
      dropToken(this.tokenKey(name)) // the relay invalidates it on leave — a rejoin mints a new one
    }
  }

  async send(msg: NewMessage): Promise<Message> {
    if (msg.kind === 'close') {
      await this.request('POST', '/close', {
        headers: this.participantHeaders(msg.from),
        fallback: 'relay close failed',
      })
      return { cursor: '', id: '', ts: Date.now(), from: msg.from, to: '*', kind: 'close', text: msg.text }
    }
    if (msg.kind !== 'message') {
      throw new Error('join/leave events are emitted by the relay itself.')
    }
    const text = this.key === undefined ? msg.text : await encryptText(this.key, msg.text)
    const wire = await this.request<WireMessage>('POST', '/messages', {
      headers: this.participantHeaders(msg.from),
      body: {
        to: wireTo(msg.to),
        text,
        ...(msg.replyTo === undefined ? {} : { replyTo: msg.replyTo }),
        ...(msg.diff === true ? { diff: true } : {}),
      },
      fallback: 'relay send failed',
    })
    // We know the plaintext — no need to decrypt what we just said.
    return {
      cursor: wire.cursor,
      id: wire.id,
      ts: wire.ts,
      from: wire.from,
      to: modelTo(wire.to),
      kind: wire.kind,
      text: msg.text,
      ...(wire.replyTo === undefined ? {} : { replyTo: wire.replyTo }),
      ...(wire.diff === true ? { diff: true } : {}),
    }
  }

  async read(opts: ReadOptions): Promise<Message[]> {
    const query = opts.since === undefined ? '' : `?since=${encodeURIComponent(opts.since)}`
    const result = await this.request<{ messages: WireMessage[] }>('GET', `/messages${query}`, {
      headers: this.participantHeaders(opts.for),
      fallback: 'relay read failed',
    })
    // The server already filtered visibility by the token's name; the local rule is a belt-and-braces no-op.
    return (await this.decryptAll(result.messages)).filter((msg) => isVisibleTo(msg, opts.for))
  }

  async participants(): Promise<Participant[]> {
    // Any cached identity for this party works; fall back to the invite token (who-before-join, stale tokens).
    const tokens = readTokens()
    const prefix = `${this.host}/${this.partyId}#`
    const cached = Object.entries(tokens).find(([key]) => key.startsWith(prefix))?.[1]
    const attempts: Record<string, string>[] = []
    if (cached !== undefined) attempts.push({ 'x-participant-token': cached })
    if (this.invite !== undefined) attempts.push({ 'x-invite-token': this.invite })
    if (attempts.length === 0) attempts.push({})
    let lastError: unknown
    for (const headers of attempts) {
      try {
        const result = await this.request<{ participants: Participant[] }>('GET', '/participants', {
          headers,
          fallback: 'relay participants failed',
        })
        return result.participants
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('relay participants failed')
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

export const createRelayTransport = (opts: {
  baseUrl: string
  host: string
  partyId: string
  key?: string
  invite?: string
}): Transport => new RelayTransport(opts.baseUrl, opts.host, opts.partyId, opts.key, opts.invite)
