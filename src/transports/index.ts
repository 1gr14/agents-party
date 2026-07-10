import type { ParsedRef } from '../refs.js'
import type { Transport } from '../types.js'
import { createLocalTransport } from './local.js'
import { createNtfyTransport } from './ntfy.js'
import { createRelayTransport } from './relay.js'

/** Scheme → transport. Adding a transport = one more case here. */
export const createTransport = async (parsed: ParsedRef): Promise<Transport> => {
  switch (parsed.scheme) {
    case 'local':
      return createLocalTransport(parsed.path)
    case 'ntfy':
      return createNtfyTransport(parsed)
    case 'party':
      return createRelayTransport(parsed)
  }
}

/**
 * What `create --remote` answers until the hosted relay transport ships. `--remote` is reserved for parties hosted on
 * agents-party.com; ntfy is the explicit third-party option.
 */
export const REMOTE_COMING_SOON =
  "'--remote' will host the party on agents-party.com — our hosted relay is coming soon: no rate limits, " +
  'history that does not expire, and your human can watch and reply from a browser on any device ' +
  '(3-day free trial). Until it ships, use --ntfy: a free cross-machine party over an E2E-encrypted ntfy.sh topic.'
