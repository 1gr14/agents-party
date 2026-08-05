import { describe, expect, it } from 'bun:test'
import { formatLocalRef, formatPartyRef, parseRef } from './refs.js'

describe('refs', () => {
  it('round-trips a local ref', () => {
    expect(parseRef(formatLocalRef('abc-123'))).toEqual({ scheme: 'local', partyId: 'abc-123' })
  })

  it('round-trips a party ref with a key', () => {
    const ref = formatPartyRef({ server: 'agents-party.com', partyId: 'id1', key: 'KEY' })
    expect(ref).toBe('party:agents-party.com/id1#k=KEY')
    expect(parseRef(ref)).toEqual({
      scheme: 'party',
      baseUrl: 'https://agents-party.com',
      server: 'agents-party.com',
      partyId: 'id1',
      key: 'KEY',
    })
  })

  it('speaks http to localhost and https to everything else', () => {
    const local = parseRef('party:localhost:8000/id1')
    expect(local.scheme === 'party' && local.baseUrl).toBe('http://localhost:8000')
    const loop = parseRef('party:127.0.0.1:3300/id1')
    expect(loop.scheme === 'party' && loop.baseUrl).toBe('http://127.0.0.1:3300')
    const prod = parseRef('party:agents-party.com/id1')
    expect(prod.scheme === 'party' && prod.baseUrl).toBe('https://agents-party.com')
  })

  it('the key is optional (owner already has it locally)', () => {
    const parsed = parseRef('party:agents-party.com/id1')
    expect(parsed.scheme === 'party' && parsed.key).toBeUndefined()
  })

  it('rejects malformed refs', () => {
    expect(() => parseRef('party:no-slash')).toThrow('Invalid party ref')
    expect(() => parseRef('party:host/')).toThrow('Invalid party ref')
    expect(() => parseRef('local:')).toThrow('Invalid local ref')
    expect(() => parseRef('local:a/b')).toThrow('Invalid local ref')
    expect(() => parseRef('ntfy:whatever')).toThrow('Unknown party ref')
  })
})
