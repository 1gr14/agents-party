import os from 'node:os'
import path from 'node:path'

/**
 * A party ref is a URL-ish string whose scheme picks the transport:
 *
 * - `local:<path>` — a SQLite file on this machine
 * - `ntfy:<server-url>/<topic>#k=<key>` — an E2E-encrypted topic on any ntfy server (the `#k=` fragment is the encryption
 *   key; fragments never reach the server)
 * - `party:<host>/<partyId>#k=<key>&i=<invite>` — a hosted party on an agents-party relay (agents-party.com); `k` is the
 *   E2E key (absent on `--no-e2e` parties), `i` is the invite token used at join. Fragments never reach the server.
 *
 * The scheme is the extension point: new transports add a scheme here and an implementation in `src/transports/`.
 */
export type ParsedRef =
  | { scheme: 'local'; path: string }
  | { scheme: 'ntfy'; server: string; topic: string; key: string }
  | { scheme: 'party'; baseUrl: string; host: string; partyId: string; key?: string; invite?: string }

export const KNOWN_SCHEMES = ['local', 'ntfy', 'party'] as const

/** Local-ish relay hosts speak plain http in dev; everything else is https. */
const isLocalHost = (host: string): boolean =>
  host === 'localhost' || host.startsWith('localhost:') || host.startsWith('127.') || host.startsWith('[::1]')

const expandHome = (p: string): string => {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

export const parseRef = (ref: string): ParsedRef => {
  const colon = ref.indexOf(':')
  const scheme = colon === -1 ? '' : ref.slice(0, colon)

  if (scheme === 'local') {
    const rawPath = ref.slice(colon + 1)
    if (!rawPath) throw new Error(`Invalid local ref (empty path): ${ref}`)
    return { scheme: 'local', path: path.resolve(expandHome(rawPath)) }
  }

  if (scheme === 'ntfy') {
    const rest = ref.slice(colon + 1)
    let url: URL
    try {
      url = new URL(rest)
    } catch {
      throw new Error(`Invalid ntfy ref (not a URL after "ntfy:"): ${ref}`)
    }
    const segments = url.pathname.split('/').filter(Boolean)
    const topic = segments.pop()
    if (!topic) throw new Error(`Invalid ntfy ref (no topic in path): ${ref}`)
    const key = new URLSearchParams(url.hash.slice(1)).get('k')
    if (!key) throw new Error(`Invalid ntfy ref (missing #k=<key> fragment): ${ref}`)
    const base = segments.length > 0 ? `/${segments.join('/')}` : ''
    return { scheme: 'ntfy', server: `${url.origin}${base}`, topic, key }
  }

  if (scheme === 'party') {
    const rest = ref.slice(colon + 1)
    const [locator = '', fragment = ''] = rest.split('#', 2)
    const slash = locator.indexOf('/')
    const host = slash === -1 ? '' : locator.slice(0, slash)
    const partyId = slash === -1 ? '' : locator.slice(slash + 1)
    if (!host || !partyId || partyId.includes('/')) {
      throw new Error(`Invalid party ref (expected party:<host>/<partyId>): ${ref}`)
    }
    const params = new URLSearchParams(fragment)
    const key = params.get('k')
    const invite = params.get('i')
    return {
      scheme: 'party',
      baseUrl: `${isLocalHost(host) ? 'http' : 'https'}://${host}`,
      host,
      partyId,
      ...(key === null ? {} : { key }),
      ...(invite === null ? {} : { invite }),
    }
  }

  throw new Error(`Unknown party ref "${ref}" — expected one of: ${KNOWN_SCHEMES.map((s) => `${s}:…`).join(', ')}`)
}

export const formatLocalRef = (filePath: string): string => `local:${filePath}`

export const formatPartyRef = (opts: { host: string; partyId: string; key?: string; invite?: string }): string => {
  const params = new URLSearchParams()
  if (opts.key !== undefined) params.set('k', opts.key)
  if (opts.invite !== undefined) params.set('i', opts.invite)
  const fragment = params.size > 0 ? `#${params.toString()}` : ''
  return `party:${opts.host}/${opts.partyId}${fragment}`
}

export const formatNtfyRef = (opts: { server: string; topic: string; key: string }): string => {
  const server = opts.server.replace(/\/+$/, '')
  return `ntfy:${server}/${opts.topic}#k=${opts.key}`
}
