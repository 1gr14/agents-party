import type { Registry } from '../registry/registry.js'

/**
 * The KeyResolver seam: crypto code never knows where a party key comes from. Implementations:
 *
 * - from a ref's `#k=` fragment (remote participants),
 * - from the local registry, where keys live openly (your own disk / your own server),
 * - in the site's browser: unsealing `keyWrapped` with the private key from the master-password session.
 */

export type KeyResolver = (partyId: string) => Promise<string | null>

export const keyFromValue = (key: string | undefined): KeyResolver => {
  return () => Promise.resolve(key ?? null)
}

export const keyFromRegistry = (registry: Registry): KeyResolver => {
  return async (partyId) => (await registry.get(partyId))?.key ?? null
}

/** Ref key wins (explicit beats stored); otherwise the registry. */
export const keyFromRefOrRegistry = (key: string | undefined, registry: Registry): KeyResolver => {
  const fromRegistry = keyFromRegistry(registry)
  return async (partyId) => key ?? (await fromRegistry(partyId))
}
