/**
 * A party ref is what you hand to an agent — it carries everything needed to participate:
 *
 * - `local:<partyId>` — a party on this machine (the file path derives from the agents-party dir)
 * - `party:<server>/<partyId>#k=<key>` — a party on a server (our site or self-hosted); `k` is the encryption key. URL
 *   fragments never reach a server.
 *
 * There is no invite entity: give someone the ref, they're in.
 */

export type ParsedRef =
  | { scheme: 'local'; partyId: string }
  | { scheme: 'party'; baseUrl: string; server: string; partyId: string; key?: string }

export const KNOWN_SCHEMES = ['local', 'party'] as const

/** Local-ish servers speak plain http in dev; everything else is https. */
const isLocalServer = (server: string): boolean =>
  server === 'localhost' || server.startsWith('localhost:') || server.startsWith('127.') || server.startsWith('[::1]')

export const parseRef = (ref: string): ParsedRef => {
  const colon = ref.indexOf(':')
  const scheme = colon === -1 ? '' : ref.slice(0, colon)

  if (scheme === 'local') {
    const partyId = ref.slice(colon + 1)
    if (!partyId || partyId.includes('/') || partyId.includes('#')) {
      throw new Error(`Invalid local ref (expected local:<partyId>): ${ref}`)
    }
    return { scheme: 'local', partyId }
  }

  if (scheme === 'party') {
    const rest = ref.slice(colon + 1)
    const [locator = '', fragment = ''] = rest.split('#', 2)
    const slash = locator.indexOf('/')
    const server = slash === -1 ? '' : locator.slice(0, slash)
    const partyId = slash === -1 ? '' : locator.slice(slash + 1)
    if (!server || !partyId || partyId.includes('/')) {
      throw new Error(`Invalid party ref (expected party:<server>/<partyId>): ${ref}`)
    }
    const key = new URLSearchParams(fragment).get('k')
    return {
      scheme: 'party',
      baseUrl: serverBaseUrl(server),
      server,
      partyId,
      ...(key === null ? {} : { key }),
    }
  }

  throw new Error(`Unknown party ref "${ref}" — expected one of: ${KNOWN_SCHEMES.map((s) => `${s}:…`).join(', ')}`)
}

/** The HTTP base for talking to a party server by hostname — plain http on loopback, https anywhere else. */
export const serverBaseUrl = (server: string): string => `${isLocalServer(server) ? 'http' : 'https'}://${server}`

export const formatLocalRef = (partyId: string): string => `local:${partyId}`

export const formatPartyRef = (opts: { server: string; partyId: string; key?: string }): string =>
  `party:${opts.server}/${opts.partyId}${opts.key === undefined ? '' : `#k=${opts.key}`}`

/**
 * The browser link a HUMAN opens to join a server party as a guest — the web guest page. Same information as the ref,
 * URL-shaped: the key rides in the fragment, so it never reaches the server. Every server deployment (our site,
 * self-hosted `agents-party web`) serves this page. Dropping the key only works on your own machine: a self-hosted
 * server keeps party keys openly and returns one with the meta, but the guest page takes it only when the page itself
 * is served from loopback (`guestPartyKey`) — from anywhere else a link without `#k=` opens keyless.
 */
export const guestJoinUrl = (opts: { server: string; partyId: string; key?: string }): string =>
  `${serverBaseUrl(opts.server)}/join/${opts.partyId}${opts.key === undefined ? '' : `#k=${opts.key}`}`
