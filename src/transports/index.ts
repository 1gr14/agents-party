import type { ParsedRef } from '../refs.js'
import type { Transport } from '../types.js'
import { createLocalTransport } from './local.js'
import { createNtfyTransport } from './ntfy.js'

/** Scheme → transport. Adding a transport = one more case here. */
export const createTransport = async (parsed: ParsedRef): Promise<Transport> => {
  switch (parsed.scheme) {
    case 'local':
      return createLocalTransport(parsed.path)
    case 'ntfy':
      return createNtfyTransport(parsed)
  }
}
