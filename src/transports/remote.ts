import { generateKey } from '../crypto.js'
import { formatPartyRef, isLocalHost } from '../refs.js'

/**
 * `create --remote` — mint a hosted party on an agents-party relay (agents-party.com). Needs an account token (`apt_…`,
 * from the site's settings page) in `AGENTS_PARTY_TOKEN` or `--token`; the E2E key is generated CLIENT-side and lives
 * only in the ref's `#k=` fragment — the relay never sees it.
 */

export const DEFAULT_RELAY_HOST = 'agents-party.com'

const TOKEN_HINT = 'get your account token at https://agents-party.com/settings and put it in AGENTS_PARTY_TOKEN'

export const createRemoteParty = async (opts: {
  name?: string
  token?: string
  /** Relay host, e.g. `agents-party.com` — defaults to AGENTS_PARTY_RELAY or agents-party.com. */
  host?: string
}): Promise<{ ref: string; host: string; partyId: string }> => {
  const token = opts.token ?? process.env.AGENTS_PARTY_TOKEN
  if (!token) {
    throw new Error(`--remote needs an account token — ${TOKEN_HINT} (or pass --token).`)
  }
  const host = opts.host ?? process.env.AGENTS_PARTY_RELAY ?? DEFAULT_RELAY_HOST
  const baseUrl = `${isLocalHost(host) ? 'http' : 'https'}://${host}`
  const response = await fetch(`${baseUrl}/api/relay/parties`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...(opts.name === undefined ? {} : { name: opts.name }), e2e: true }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    let code = ''
    let message = ''
    try {
      const body = (await response.json()) as { code?: string; message?: string }
      code = body.code ?? ''
      message = body.message ?? ''
    } catch {
      // non-JSON error body — fall through to the generic message
    }
    if (code === 'INVALID_TOKEN') throw new Error(`The account token was rejected — ${TOKEN_HINT}.`)
    if (code === 'NO_ACCESS') {
      throw new Error(
        'This account has no active subscription — hosted parties need one (3-day free trial at https://agents-party.com).',
      )
    }
    if (code === 'RATE_LIMITED') {
      throw new Error('Party creation is rate-limited (daily per-account quota) — try again later.')
    }
    throw new Error(message || `creating the hosted party failed: HTTP ${response.status}`)
  }
  const { partyId, inviteToken } = (await response.json()) as { partyId?: string; inviteToken?: string }
  if (!partyId || !inviteToken) {
    throw new Error('The relay returned an unexpected response to party creation — check the relay host.')
  }
  return { ref: formatPartyRef({ host, partyId, key: generateKey(), invite: inviteToken }), host, partyId }
}
