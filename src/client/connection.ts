import { randomUUID } from 'node:crypto'
import { decryptText, encryptText, generatePartyKey, seal } from '../core/crypto.js'
import { dataDir, registryPath } from '../core/dirs.js'
import { errorFromCode, PartyError } from '../core/errors.js'
import { keyFromValue } from '../core/keys.js'
import type { KeyResolver } from '../core/keys.js'
import { formatLocalRef, formatPartyRef, parseRef } from '../core/refs.js'
import { createSqliteRegistry } from '../registry/sqlite.js'
import { defaultSettings } from '../core/types.js'
import type { Message, NewMessage, Participant, Recipients } from '../core/types.js'
import { createStorePool } from '../store/pool.js'

/**
 * The client layer — one interface over both protocols. `local:` talks to the files directly; `party:` talks HTTP.
 * Encryption lives exactly here: `send` encrypts before anything is stored or sent, `read`/`listen` decrypt after.
 * Everything below this layer moves ciphertext only.
 *
 * A message that does not decrypt (wrong or missing key) comes back with empty text and `undecrypted: true` — callers
 * can tell the user to check the ref instead of showing a silently empty party.
 */

export interface SendOptions {
  to?: Recipients
  replyTo?: string
}

export interface PartyConnection {
  ref: string
  partyId: string
  /** How often listen/tail should poll: aggressive on local files, gentle on servers. */
  pollIntervalMs: number
  join(name: string, opts?: { desc?: string }): Promise<Participant>
  leave(name: string): Promise<void>
  send(from: string, text: string, opts?: SendOptions): Promise<Message>
  read(opts?: { for?: string; since?: string; before?: string; limit?: number }): Promise<Message[]>
  /**
   * Blocks until a message from someone else arrives — returns the fresh foreign messages. With no `timeoutMs` it waits
   * indefinitely (the cheap way to park an agent: wake only on a real message); pass one to bound the wait.
   */
  listen(forName: string, opts?: { since?: string; timeoutMs?: number }): Promise<Message[]>
  participants(): Promise<Participant[]>
  close(): Promise<void>
}

export type DecryptableMessage = Message & { undecrypted?: true }

const decryptAll = async (messages: Message[], key: string | null): Promise<DecryptableMessage[]> => {
  const out: DecryptableMessage[] = []
  for (const msg of messages) {
    if (msg.kind !== 'message') {
      out.push(msg)
      continue
    }
    const plaintext = key === null ? null : await decryptText(key, msg.text)
    out.push(plaintext === null ? { ...msg, text: '', undecrypted: true } : { ...msg, text: plaintext })
  }
  return out
}

const requireKey = async (resolve: KeyResolver, partyId: string): Promise<string> => {
  const key = await resolve(partyId)
  if (key === null) {
    throw new PartyError('BAD_REQUEST', 'No encryption key for this party — use the full ref with #k=<key>.')
  }
  return key
}

/** A woken listen waits this long for the rest of a burst before answering — mirrors the server (server/api.ts). */
const LISTEN_SETTLE_MS = 400

// ── Local protocol ────────────────────────────────────────────────────────────

const connectLocal = async (partyId: string, dir?: string): Promise<PartyConnection> => {
  const registry = await createSqliteRegistry(registryPath(dir ?? dataDir()))
  const pool = createStorePool(dir)
  const entry = await registry.get(partyId)
  if (entry === null) {
    await registry.close()
    throw new PartyError('PARTY_NOT_FOUND', 'Party not found in the local registry — check the ref.')
  }
  const resolveKey = keyFromValue(entry.key ?? undefined)
  const store = await pool.get(partyId)

  const touch = async (): Promise<void> => registry.touch(partyId, await store.stats())

  return {
    ref: formatLocalRef(partyId),
    partyId,
    pollIntervalMs: 300,
    join: async (name, opts = {}) => {
      // Local files are the owner's machine by definition — `host` is allowed here.
      const participant = await store.join(name, { ...opts, owner: true })
      await touch()
      return participant
    },
    leave: async (name) => {
      await store.leave(name)
      await touch()
    },
    send: async (from, text, opts = {}) => {
      const key = await requireKey(resolveKey, partyId)
      const msg: NewMessage = {
        from,
        to: opts.to ?? '*',
        kind: 'message',
        text: await encryptText(key, text),
        ...(opts.replyTo === undefined ? {} : { replyTo: opts.replyTo }),
      }
      const stored = await store.append(msg)
      await touch()
      return { ...stored, text } // the sender knows their own plaintext
    },
    read: async (opts = {}) => decryptAll(await store.read(opts), await resolveKey(partyId)),
    listen: async (forName, opts = {}) => {
      const deadline = opts.timeoutMs === undefined ? Infinity : Date.now() + opts.timeoutMs
      // No cursor means "from now": without this the first read returns the whole history, any old message from
      // somebody else ends the wait at once, and `listen` degrades into `read`. The backlog is what `read` is for.
      let since = opts.since ?? (await store.read({ for: forName })).at(-1)?.cursor
      while (Date.now() < deadline) {
        const messages = await store.read({ for: forName, ...(since === undefined ? {} : { since }) })
        const foreign = messages.filter((m) => m.from !== forName)
        if (foreign.length > 0) {
          // Let the burst settle, exactly as the server does: a participant joining and speaking is one action and
          // two rows, and answering the join alone wakes the reader twice for it.
          await new Promise((resolve) => setTimeout(resolve, LISTEN_SETTLE_MS))
          const settled = (await store.read({ for: forName, ...(since === undefined ? {} : { since }) })).filter(
            (m) => m.from !== forName,
          )
          return decryptAll(settled.length > foreign.length ? settled : foreign, await resolveKey(partyId))
        }
        if (messages.length > 0) since = messages.at(-1)?.cursor
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      return []
    },
    participants: () => store.participants(),
    close: async () => {
      await pool.closeAll()
      await registry.close()
    },
  }
}

// ── Remote protocol ───────────────────────────────────────────────────────────

/** Pause before re-trying a listen whose CONNECTION failed (vs. answered) — covers restarts and network blips. */
const LISTEN_RETRY_MS = 2000

/** Statuses a proxy or load balancer emits on its own, without the app ever seeing the request. */
const GATEWAY_STATUSES = new Set([502, 503, 504])

/**
 * The request never reached the party server, or its answer did not come from it — a dropped socket, a restart, a proxy
 * cutting a long poll. Deliberately NOT a `PartyError`: those are answers, and `listen` ends on an answer while it
 * retries a broken connection.
 */
export class PartyTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PartyTransportError'
  }
}

interface RemoteAuth {
  /** API key (our site) or server token (self-hosted) — only needed for owner actions, not for participating. */
  token?: string
}

const remoteRequest = async <T>(
  baseUrl: string,
  path: string,
  opts: { method?: string; body?: unknown; token?: string; timeoutMs?: number } = {},
): Promise<T> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` }),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  })
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = text === '' ? {} : JSON.parse(text)
  } catch {
    parsed = {}
  }
  if (!response.ok) {
    const body = parsed as { code?: string; message?: string }
    // A gateway status is the infrastructure talking, not the party server: a proxy cutting a long poll answers 502
    // with an HTML page, which used to be dressed up as a party error and ended the listen for good. Anything that
    // did not come from the app is a broken connection, and a broken connection is worth retrying.
    if (body.code === undefined && GATEWAY_STATUSES.has(response.status)) {
      throw new PartyTransportError(`HTTP ${response.status} from the party server (gateway, not the app)`)
    }
    throw errorFromCode(body.code ?? 'BAD_REQUEST', body.message ?? `HTTP ${response.status} from the party server`)
  }
  return parsed as T
}

const connectRemote = (opts: {
  baseUrl: string
  server: string
  partyId: string
  key?: string
  auth?: RemoteAuth
}): PartyConnection => {
  const { baseUrl, partyId } = opts
  const api = `/api/parties/${encodeURIComponent(partyId)}`
  const resolveKey = keyFromValue(opts.key)
  const token = opts.auth?.token

  return {
    ref: formatPartyRef({ server: opts.server, partyId, ...(opts.key === undefined ? {} : { key: opts.key }) }),
    partyId,
    pollIntervalMs: 2000,
    join: async (name, joinOpts = {}) => {
      const result = await remoteRequest<{ participant: Participant }>(baseUrl, `${api}/join`, {
        method: 'POST',
        body: { name, ...joinOpts },
        token,
      })
      return result.participant
    },
    leave: async (name) => {
      await remoteRequest(baseUrl, `${api}/leave`, { method: 'POST', body: { name }, token })
    },
    send: async (from, text, sendOpts = {}) => {
      const key = await requireKey(resolveKey, partyId)
      const result = await remoteRequest<{ message: Message }>(baseUrl, `${api}/messages`, {
        method: 'POST',
        body: {
          from,
          to: sendOpts.to ?? '*',
          text: await encryptText(key, text),
          ...(sendOpts.replyTo === undefined ? {} : { replyTo: sendOpts.replyTo }),
        },
        token,
      })
      return { ...result.message, text }
    },
    read: async (readOpts = {}) => {
      const params = new URLSearchParams()
      if (readOpts.since !== undefined) params.set('since', readOpts.since)
      if (readOpts.before !== undefined) params.set('before', readOpts.before)
      if (readOpts.limit !== undefined) params.set('limit', String(readOpts.limit))
      if (readOpts.for !== undefined) params.set('for', readOpts.for)
      const query = params.size > 0 ? `?${params.toString()}` : ''
      const result = await remoteRequest<{ messages: Message[] }>(baseUrl, `${api}/messages${query}`)
      return decryptAll(result.messages, await resolveKey(partyId))
    },
    listen: async (forName, listenOpts = {}) => {
      const deadline = listenOpts.timeoutMs === undefined ? Infinity : Date.now() + listenOpts.timeoutMs
      // "From now" is resolved here as well as on the server, so the promise holds against an older server too: one
      // that still replays its whole history for a cursor-less listen would end this wait on the archive.
      let since =
        listenOpts.since ??
        (
          await remoteRequest<{ messages: Message[] }>(
            baseUrl,
            `${api}/messages?${new URLSearchParams({ for: forName, limit: '1' }).toString()}`,
          )
        ).messages.at(-1)?.cursor
      while (Date.now() < deadline) {
        const started = Date.now()
        const secLeft = Math.ceil((deadline - started) / 1000)
        const params = new URLSearchParams({ for: forName, timeoutSec: String(Math.min(50, Math.max(1, secLeft))) })
        if (since !== undefined) params.set('since', since)
        let result: { messages: Message[] }
        try {
          result = await remoteRequest<{ messages: Message[] }>(baseUrl, `${api}/listen?${params.toString()}`, {
            timeoutMs: 60_000,
          })
        } catch (error) {
          // The server ANSWERED with an error (party deleted, bad request) — that's final. A dropped socket, a
          // server restart or a network blip is not: the message is still on the server, so retry within the window.
          if (error instanceof PartyError) throw error
          if (Date.now() + LISTEN_RETRY_MS >= deadline) break
          await new Promise((resolve) => setTimeout(resolve, LISTEN_RETRY_MS))
          continue
        }
        const foreign = result.messages.filter((m) => m.from !== forName)
        if (foreign.length > 0) return decryptAll(foreign, await resolveKey(partyId))
        if (result.messages.length > 0) since = result.messages.at(-1)?.cursor
        // An empty answer long before the window we asked for means the server is not holding the poll (it is
        // shutting down, or something in between cut it short) — pace the re-poll instead of hammering it.
        if (Date.now() - started < LISTEN_RETRY_MS) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(LISTEN_RETRY_MS, deadline - Date.now())))
        }
      }
      return []
    },
    participants: async () =>
      (await remoteRequest<{ participants: Participant[] }>(baseUrl, `${api}/participants`)).participants,
    close: async () => {},
  }
}

// ── Entry points ──────────────────────────────────────────────────────────────

export interface ConnectOptions {
  /** Owner credentials for remote refs (API key / server token) — needed only to act as the owner. */
  token?: string
  /** Data dir override for local refs (tests). */
  dir?: string
}

/** Connect to an existing party by ref. */
export const connectParty = async (ref: string, opts: ConnectOptions = {}): Promise<PartyConnection> => {
  const parsed = parseRef(ref)
  if (parsed.scheme === 'local') return connectLocal(parsed.partyId, opts.dir)
  return connectRemote({ ...parsed, auth: { ...(opts.token === undefined ? {} : { token: opts.token }) } })
}

export interface CreatePartyOptions {
  title?: string
  /** Where: omit for local; a server hostname (e.g. agents-party.com) for remote. */
  server?: string
  /** Owner credentials for remote creation (API key / server token). */
  token?: string
  /** Party key sealed for the owner's cabinet (zero-knowledge servers require it; harmless elsewhere). */
  keyWrapped?: string
  dir?: string
}

/** Create a party (local by default, on a server with `server`) and return a ready connection. */
export const createParty = async (
  opts: CreatePartyOptions = {},
): Promise<{ ref: string; partyId: string; key: string; connection: PartyConnection }> => {
  const key = generatePartyKey()
  const title = opts.title ?? 'party'

  if (opts.server === undefined) {
    const registry = await createSqliteRegistry(registryPath(opts.dir ?? dataDir()))
    const partyId = randomUUID()
    await registry.create({
      id: partyId,
      title,
      createdAt: Date.now(),
      lastMessageAt: null,
      messagesCount: 0,
      sizeBytes: 0,
      key,
      keyWrapped: opts.keyWrapped ?? null,
      settings: defaultSettings(),
    })
    await registry.close()
    return { ref: formatLocalRef(partyId), partyId, key, connection: await connectLocal(partyId, opts.dir) }
  }

  const parsed = parseRef(formatPartyRef({ server: opts.server, partyId: 'x' })) // reuse http(s) selection
  if (parsed.scheme !== 'party') throw new Error('unreachable')
  // Zero-knowledge is enforced CLIENT-side too: the plaintext key must never even transit to such a server — we seal
  // it with the owner's public key (from /api/owner) and send only the wrapped form. Self-hosted servers store the
  // key openly instead.
  const info = await remoteRequest<{ zeroKnowledge: boolean }>(parsed.baseUrl, '/api/server')
  const owner = await remoteRequest<{ publicKey: string | null }>(parsed.baseUrl, '/api/owner', { token: opts.token })
  const keyWrapped = owner.publicKey === null ? opts.keyWrapped : await seal(owner.publicKey, key)
  if (info.zeroKnowledge && keyWrapped === undefined) {
    throw new PartyError(
      'BAD_REQUEST',
      'This server is zero-knowledge but published no public key to seal the party key for — set up the master password in your account first.',
    )
  }
  const created = await remoteRequest<{ id: string }>(parsed.baseUrl, '/api/parties', {
    method: 'POST',
    body: {
      title,
      ...(info.zeroKnowledge ? {} : { key }),
      ...(keyWrapped === undefined ? {} : { keyWrapped }),
    },
    token: opts.token,
  })
  const connection = connectRemote({
    baseUrl: parsed.baseUrl,
    server: opts.server,
    partyId: created.id,
    key,
    auth: { ...(opts.token === undefined ? {} : { token: opts.token }) },
  })
  return { ref: connection.ref, partyId: created.id, key, connection }
}
