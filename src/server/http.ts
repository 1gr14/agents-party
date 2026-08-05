import http from 'node:http'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { dataDir, registryPath } from '../core/dirs.js'
import { createSqliteRegistry } from '../registry/sqlite.js'
import { createStorePool } from '../store/pool.js'
import { createPartyApi } from './api.js'
import type { Owner } from './api.js'

/**
 * The standalone party server — `agents-party web` locally, the same command on a VPS for self-hosted. Wraps the pure
 * fetch handlers from api.ts into node:http (works on Bun and Node alike).
 *
 * Owner auth: a single server token, set via AGENTS_PARTY_SERVER_TOKEN or `--token`. With no token configured, owner
 * rights hang on the SOCKET's peer being loopback — it's your machine — and on nothing else; a request arriving from
 * any other address is a plain participant. Exposing beyond loopback REQUIRES a token — the server refuses to start
 * otherwise — and a reverse proxy in front of it connects FROM loopback, so it hands owner rights to whatever it
 * forwards: run a token whenever anything but you can reach the port (the startup warning says exactly this).
 */

export interface ServerOptions {
  /** 0 (default) picks a free port. */
  port?: number
  /** Default 127.0.0.1; pass 0.0.0.0 on a VPS — a token becomes mandatory. */
  host?: string
  /** The server token; defaults to AGENTS_PARTY_SERVER_TOKEN. */
  token?: string
  /** Data dir override (registry + party files); defaults to the agents-party dir. */
  dir?: string
  /** Extra handler tried after the API (the web UI in phase 4). */
  fallback?: (request: Request) => Promise<Response | null>
}

export interface RunningServer {
  port: number
  host: string
  url: string
  stop(): Promise<void>
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * The peer address of the socket each in-flight Request came in on. `toFetchRequest` drops the node:http socket, and
 * the fetch-shaped handlers must not grow a transport argument — so the one thing owner-without-token rights may hang
 * on is carried here, keyed by the Request itself (garbage-collected with it).
 */
const remoteAddresses = new WeakMap<Request, string>()

/**
 * Is the other end of this socket on this very machine? 127.0.0.0/8 and `::1` (also in its IPv4-mapped `::ffff:` form).
 * Deliberately blind to headers: `X-Forwarded-For` & co. are written by the client, so trusting them would hand owner
 * rights to anyone who types a header. Exported for the unit test, not part of the package's API.
 */
export const isLoopbackAddress = (address: string | undefined): boolean => {
  if (address === undefined || address === '') return false
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return plain === '::1' || plain.startsWith('127.')
}

const MAX_BODY_BYTES = 1_000_000 // the server is public-facing by design (self-hosted) — cap what we buffer
// Abandoning the request stream mid-read corrupts the response under Bun's node:http (the client sees an empty 200
// instead of the 413 we write) — so an oversized body is DRAINED without buffering and refused only after it ends.
// Bodies past this ceiling aren't worth the bandwidth: cut the socket instead.
const DRAIN_CEILING_BYTES = 10_000_000

const toFetchRequest = async (req: http.IncomingMessage, base: string): Promise<Request> => {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > DRAIN_CEILING_BYTES) throw new Error('body absurdly large') // destroys the stream — see caller
    if (total > MAX_BODY_BYTES) continue // keep draining so the 413 below can actually be delivered
    chunks.push(chunk as Buffer)
  }
  if (total > MAX_BODY_BYTES) throw new Error('body too large')
  const body = Buffer.concat(chunks)
  return new Request(`${base}${req.url ?? '/'}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([name, value]) =>
      typeof value === 'string' ? [[name, value] as [string, string]] : [],
    ),
    ...(body.length > 0 ? { body } : {}),
  })
}

const writeFetchResponse = async (res: http.ServerResponse, response: Response): Promise<void> => {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  res.end(Buffer.from(await response.arrayBuffer()))
}

/**
 * The web UI — the built Point0 client SPA under `web/dist` (ships in the package). A tiny, dependency-free static
 * handler: `/` and the SPA routes serve `index.html`, every other path serves the matching file (assets, chunks) with
 * the right content-type; unknown paths fall through to the API's 404 rather than being rewritten to `index.html`.
 * Returns `null` when `web/dist` is absent (a dev checkout before `bun run build:web`), so the API-only server keeps
 * working.
 */
const webDistDir = new URL('../../web/dist/', import.meta.url)

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  png: 'image/png',
  webp: 'image/webp',
  woff2: 'font/woff2',
  woff: 'font/woff',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json',
}

const webPage = (request: Request): Response | null => {
  if (request.method !== 'GET') return null
  const pathname = new URL(request.url).pathname
  // The SPA's only non-root route: the guest page (/join/<partyId>, key in the URL fragment) must serve the app shell.
  const isSpaRoute = pathname === '/' || pathname === '' || pathname.startsWith('/join/')
  const relative = isSpaRoute ? 'index.html' : pathname.replace(/^\/+/, '')
  if (relative.includes('..')) return null // no path traversal
  const fileUrl = new URL(relative, webDistDir)
  if (!fileUrl.href.startsWith(webDistDir.href)) return null // stay inside web/dist
  let data: Buffer
  try {
    data = fs.readFileSync(fileUrl)
  } catch {
    return null
  }
  const ext = relative.slice(relative.lastIndexOf('.') + 1).toLowerCase()
  const type = CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream'
  // Copy into a fresh Uint8Array<ArrayBuffer> so it satisfies BodyInit under either the node or DOM lib typings.
  return new Response(new Uint8Array(data), { headers: { 'content-type': type } })
}

export const startServer = async (opts: ServerOptions = {}): Promise<RunningServer> => {
  const host = opts.host ?? '127.0.0.1'
  const token = opts.token ?? process.env.AGENTS_PARTY_SERVER_TOKEN
  const tokenless = token === undefined || token === ''
  if (!LOOPBACK_HOSTS.has(host) && tokenless) {
    throw new Error('Refusing to listen beyond loopback without a token — set AGENTS_PARTY_SERVER_TOKEN or --token.')
  }
  if (tokenless) {
    console.error(
      'agents-party: no token — every request from this machine is the owner (party list with plaintext keys, writing as host, bulk delete). Anything a reverse proxy forwards counts as local, so use --token (or AGENTS_PARTY_SERVER_TOKEN) unless you are the only one who can reach this port.',
    )
  }

  const dir = opts.dir ?? dataDir()
  const registry = await createSqliteRegistry(registryPath(dir))
  const pool = createStorePool(dir)

  const authOwner = (request: Request): Promise<Owner | null> => {
    // No token: the only credential left is where the request physically came from. A loopback peer is you; anyone
    // else (a forwarded port, a host entry pointing `localhost` at a LAN address) is just a participant.
    if (tokenless) return Promise.resolve(isLoopbackAddress(remoteAddresses.get(request)) ? { ownerId: null } : null)
    const header = Buffer.from(request.headers.get('authorization') ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    const matches = header.length === expected.length && timingSafeEqual(header, expected)
    return Promise.resolve(matches ? { ownerId: null } : null)
  }

  const stopping = new AbortController()
  const api = createPartyApi({
    registry,
    store: (partyId) => pool.get(partyId),
    removeStore: (partyId) => pool.remove(partyId),
    authOwner,
    zeroKnowledge: false, // your own disk — plaintext party keys live in the registry
    signal: stopping.signal,
    // Local-protocol clients on this machine write the party files DIRECTLY, bypassing this process — those writes
    // never hit the wake hub, so the web viewer would only see them on the fallback re-read. Keep it prompt here;
    // a handful of local listeners at 1 rps is nothing.
    listenFallbackMs: 1000,
  })

  const server = http.createServer((req, res) => {
    void (async () => {
      // Shutting down: the registry and stores are about to close, so answering would 500 (or lie). Dropping the
      // socket tells clients the truth — their retry reconnects to the next process.
      if (stopping.signal.aborted) {
        res.destroy()
        return
      }
      let request: Request
      try {
        request = await toFetchRequest(req, `http://${host}`)
      } catch {
        await writeFetchResponse(
          res,
          new Response(JSON.stringify({ code: 'BAD_REQUEST', message: 'Body too large.', status: 413 }), {
            status: 413,
            headers: { 'content-type': 'application/json' },
          }),
        )
        return
      }
      remoteAddresses.set(request, req.socket.remoteAddress ?? '') // the only input to owner-without-token rights
      const response = (await api(request)) ?? webPage(request) ?? (await opts.fallback?.(request)) ?? null
      await writeFetchResponse(
        res,
        response ??
          new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'No such endpoint.', status: 404 }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
      )
    })().catch(() => res.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, host, resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    port,
    host,
    url: `http://${host}:${port}`,
    stop: async () => {
      stopping.abort() // pending long-polls exit their loop before the stores go away
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
      await new Promise((resolve) => setTimeout(resolve, 350)) // let an in-flight poll leave its read
      await pool.closeAll()
      await registry.close()
    },
  }
}
