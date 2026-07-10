import { describe, expect, expectTypeOf, it } from 'bun:test'
import {
  connect,
  createLocalParty,
  createNtfyParty,
  createTransport,
  decryptText,
  DEFAULT_NTFY_SERVER,
  encryptText,
  generateInvitePrompt,
  generateKey,
  isVisibleTo,
  KNOWN_SCHEMES,
  parseRef,
  PartyClient,
} from './index.js'
import type { Message, ParsedRef, Participant, Recipients, Transport } from './index.js'

describe('public API', () => {
  it('exports the whole surface', () => {
    for (const value of [
      connect,
      createLocalParty,
      createNtfyParty,
      createTransport,
      decryptText,
      encryptText,
      generateInvitePrompt,
      generateKey,
      isVisibleTo,
      parseRef,
      PartyClient,
    ]) {
      expect(typeof value === 'function').toBe(true)
    }
    expect(DEFAULT_NTFY_SERVER).toBe('https://ntfy.sh')
    expect(KNOWN_SCHEMES).toEqual(['local', 'ntfy'])
  })

  it('visibility rule: broadcasts for all, DMs for recipients and sender', () => {
    expect(isVisibleTo({ from: 'a', to: 'all' }, 'b')).toBe(true)
    expect(isVisibleTo({ from: 'a', to: ['b'] }, 'b')).toBe(true)
    expect(isVisibleTo({ from: 'a', to: ['b'] }, 'c')).toBe(false)
    expect(isVisibleTo({ from: 'a', to: ['b'] }, 'a')).toBe(true)
  })
})

// Type-level tests. We test public types too, not just runtime behavior.
// This function is never called — `tsc` (and `tsgo`) check its body, nothing runs.
function assertTypes() {
  expectTypeOf(connect).toEqualTypeOf<(ref: string, opts: { as: string }) => Promise<PartyClient>>()
  expectTypeOf(parseRef).returns.toEqualTypeOf<ParsedRef>()
  expectTypeOf(createTransport).returns.toEqualTypeOf<Promise<Transport>>()

  expectTypeOf<Message['cursor']>().toBeString()
  expectTypeOf<Message['to']>().toEqualTypeOf<Recipients>()
  expectTypeOf<Recipients>().toEqualTypeOf<'all' | string[]>()
  expectTypeOf<Message['kind']>().toEqualTypeOf<'message' | 'join' | 'leave' | 'close'>()
  expectTypeOf<Participant['leftTs']>().toEqualTypeOf<number | undefined>()

  // The ref union is discriminated by `scheme`.
  const parsed = parseRef('local:/tmp/x.sqlite')
  if (parsed.scheme === 'local') expectTypeOf(parsed.path).toBeString()
  if (parsed.scheme === 'ntfy') {
    expectTypeOf(parsed.topic).toBeString()
    expectTypeOf(parsed.key).toBeString()
  }

  // PartyClient surface.
  const client = {} as PartyClient
  expectTypeOf(client.send).parameter(0).toBeString()
  expectTypeOf(client.listen).returns.toEqualTypeOf<Promise<Message[]>>()
  expectTypeOf(client.who).returns.toEqualTypeOf<Promise<Participant[]>>()
}

describe('types', () => {
  it('compile-time type assertions hold', () => {
    expect(typeof assertTypes).toBe('function') // referenced so tsc checks it; never invoked
  })
})
