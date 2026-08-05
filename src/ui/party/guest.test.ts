import { describe, expect, it } from 'bun:test'
import { guestPartyKey } from './guest.js'

/**
 * The guest page's key rule. It decides whether a browser gets the party key at all, so it is worth pinning: on a
 * hosted server the meta reaches everyone who opens the link, and handing them the key would undo the encryption.
 */

describe('guest key resolution', () => {
  const HASH_KEY = 'key-from-the-link'
  const META_KEY = 'key-the-server-handed-out'

  it('the link fragment always wins — it is the form that never reaches a server', () => {
    for (const hostname of ['localhost', 'agents-party.com', 'party.example.org']) {
      expect(guestPartyKey({ fromHash: HASH_KEY, fromMeta: META_KEY, hostname })).toBe(HASH_KEY)
    }
  })

  it('falls back to the meta key only on a page served from this machine', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]', '::1']) {
      expect(guestPartyKey({ fromHash: null, fromMeta: META_KEY, hostname })).toBe(META_KEY)
    }
  })

  it('never takes the meta key off loopback — a bare /join/<id> link stays keyless', () => {
    for (const hostname of ['agents-party.com', '203.0.113.9', 'localhost.evil.com', '127.0.0.1.nip.io']) {
      expect(guestPartyKey({ fromHash: null, fromMeta: META_KEY, hostname })).toBeNull()
    }
  })

  it('no key anywhere is null, not undefined (the composer keys off exactly that)', () => {
    expect(guestPartyKey({ fromHash: null, fromMeta: null, hostname: 'localhost' })).toBeNull()
    expect(guestPartyKey({ fromHash: null, hostname: 'localhost' })).toBeNull()
  })
})
