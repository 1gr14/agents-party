import os from 'node:os'
import path from 'node:path'

/**
 * A party ref is a URL-ish string whose scheme picks the transport:
 *
 * - `local:<path>` — a SQLite file on this machine
 * - `ntfy:<server-url>/<topic>#k=<key>` — an E2E-encrypted topic on any ntfy server (the `#k=` fragment is the encryption
 *   key; fragments never reach the server)
 *
 * The scheme is the extension point: new transports add a scheme here and an implementation in `src/transports/`.
 */
export type ParsedRef =
  | { scheme: 'local'; path: string }
  | { scheme: 'ntfy'; server: string; topic: string; key: string }

export const KNOWN_SCHEMES = ['local', 'ntfy'] as const

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

  throw new Error(`Unknown party ref "${ref}" — expected one of: ${KNOWN_SCHEMES.map((s) => `${s}:…`).join(', ')}`)
}

export const formatLocalRef = (filePath: string): string => `local:${filePath}`

export const formatNtfyRef = (opts: { server: string; topic: string; key: string }): string => {
  const server = opts.server.replace(/\/+$/, '')
  return `ntfy:${server}/${opts.topic}#k=${opts.key}`
}
