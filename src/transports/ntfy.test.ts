import { afterAll, describe, expect, it } from 'bun:test'
import { encryptText } from '../crypto.js'
import { parseRef } from '../refs.js'
import { startNtfyMock } from '../testing/ntfy-mock.js'
import { describeTransportContract } from '../testing/contract.js'
import type { Transport } from '../types.js'
import { createNtfyParty, createNtfyTransport } from './ntfy.js'

const mock = startNtfyMock()
afterAll(() => {
  mock.stop()
})

const makeParty = (): { ref: string; connectAs: () => Transport } => {
  const { ref } = createNtfyParty({ server: mock.url })
  const parsed = parseRef(ref)
  if (parsed.scheme !== 'ntfy') throw new Error('expected an ntfy ref')
  // Fast backoff so the 429 tests don't sleep for real.
  return { ref, connectAs: () => createNtfyTransport({ ...parsed, retryDelaysMs: [10, 10, 10] }) }
}

describeTransportContract('ntfy', () => {
  const party = makeParty()
  return Promise.resolve({ connectAs: () => Promise.resolve(party.connectAs()) })
})

describe('createNtfyParty', () => {
  it('mints a ref with a random ap-topic and a key in the fragment', () => {
    const { ref } = createNtfyParty({ server: mock.url })
    const parsed = parseRef(ref)
    if (parsed.scheme !== 'ntfy') throw new Error('expected an ntfy ref')
    expect(parsed.server).toBe(mock.url)
    expect(parsed.topic).toMatch(/^ap-[0-9a-f]{12}$/)
    expect(parsed.key.length).toBeGreaterThan(40)
  })

  it('defaults to ntfy.sh', () => {
    const { ref } = createNtfyParty()
    expect(ref.startsWith('ntfy:https://ntfy.sh/ap-')).toBe(true)
  })
})

describe('ntfy transport specifics', () => {
  it('skips foreign (undecryptable) traffic on the topic', async () => {
    const party = makeParty()
    const t = party.connectAs()
    await t.join('a')
    const parsed = parseRef(party.ref)
    if (parsed.scheme !== 'ntfy') throw new Error('expected an ntfy ref')
    await fetch(`${mock.url}/${parsed.topic}`, { method: 'POST', body: 'plaintext junk' })
    await fetch(`${mock.url}/${parsed.topic}`, { method: 'POST', body: 'bm90IG91cnM' })
    await t.send({ from: 'a', to: 'all', kind: 'message', text: 'ours' })
    const texts = (await t.read({ for: 'a' })).map((m) => m.text)
    expect(texts).toContain('ours')
    expect(texts).not.toContain('plaintext junk')
    await t.close()
  })

  it('a different key sees nothing (E2E for real)', async () => {
    const party = makeParty()
    const t = party.connectAs()
    await t.join('a')
    await t.send({ from: 'a', to: 'all', kind: 'message', text: 'secret' })
    const parsed = parseRef(party.ref)
    if (parsed.scheme !== 'ntfy') throw new Error('expected an ntfy ref')
    const stranger = createNtfyTransport({
      server: parsed.server,
      topic: parsed.topic,
      key: 'A'.repeat(43),
    })
    expect(await stranger.read({ for: 'a' })).toEqual([])
    await t.close()
    await stranger.close()
  })

  it('uses its own <ts>.<id> cursors (relay-independent)', async () => {
    const party = makeParty()
    const t = party.connectAs()
    await t.join('a')
    const sent = await t.send({ from: 'a', to: 'all', kind: 'message', text: 'hello' })
    expect(sent.cursor).toBe(`${sent.ts}.${sent.id}`)
    const after = await t.read({ for: 'a', since: sent.cursor })
    expect(after).toEqual([])
    await t.close()
  })

  it('an anchor missing from the stream falls back to the cursor timestamp', async () => {
    const party = makeParty()
    const t = party.connectAs()
    await t.join('a')
    await t.send({ from: 'a', to: 'all', kind: 'message', text: 'old news' })
    const future = await t.read({ for: 'a', since: `${Date.now() + 60_000}.unknown-id` })
    expect(future).toEqual([])
    const everything = await t.read({ for: 'a', since: '0.unknown-id' })
    expect(everything.map((m) => m.text)).toContain('old news')
    await t.close()
  })

  it('chunks long texts transparently and reassembles them on read', async () => {
    const party = makeParty()
    const sender = party.connectAs()
    const reader = party.connectAs()
    await sender.join('a')
    const longText = 'я🎉x'.repeat(3000) // multi-byte chars across chunk borders
    const sent = await sender.send({ from: 'a', to: 'all', kind: 'message', text: longText })
    const received = (await reader.read({ for: 'a' })).find((m) => m.kind === 'message')
    expect(received?.text).toBe(longText)
    expect(received?.id).toBe(sent.id)
    expect(received?.cursor).toBe(sent.cursor)
    await sender.close()
    await reader.close()
  })

  it('skips incomplete chunk groups instead of showing torn messages', async () => {
    const party = makeParty()
    const t = party.connectAs()
    await t.join('a')
    const parsed = parseRef(party.ref)
    if (parsed.scheme !== 'ntfy') throw new Error('expected an ntfy ref')
    const orphan = {
      v: 1,
      id: 'torn-id',
      ts: Date.now(),
      from: 'a',
      to: 'all',
      kind: 'message',
      text: 'first half of',
      part: { i: 0, of: 2 },
    }
    await fetch(`${mock.url}/${parsed.topic}`, {
      method: 'POST',
      body: await encryptText(parsed.key, JSON.stringify(orphan)),
    })
    const texts = (await t.read({ for: 'a' })).map((m) => m.text)
    expect(texts).not.toContain('first half of')
    await t.close()
  })

  it('rejects texts above the total chunked limit', async () => {
    const party = makeParty()
    const t = party.connectAs()
    await t.join('a')
    await expect(t.send({ from: 'a', to: 'all', kind: 'message', text: 'x'.repeat(100_000) })).rejects.toThrow(
      'too large',
    )
    await t.close()
  })

  it('retries politely on 429 and succeeds', async () => {
    const party = makeParty()
    const t = party.connectAs()
    await t.join('a')
    mock.rateLimitNext(2)
    const sent = await t.send({ from: 'a', to: 'all', kind: 'message', text: 'made it' })
    expect(sent.text).toBe('made it')
    await t.close()
  })

  it('gives up on persistent 429 with the funnel hint', async () => {
    const party = makeParty()
    const t = party.connectAs()
    await t.join('a')
    mock.rateLimitNext(50)
    await expect(t.read({ for: 'a' })).rejects.toThrow('agents-party.com')
    mock.rateLimitNext(0)
    await t.close()
  })

  it('a close by one instance is enforced on another long-lived instance', async () => {
    const party = makeParty()
    const veteran = party.connectAs()
    await veteran.join('veteran')
    await veteran.send({ from: 'veteran', to: 'all', kind: 'message', text: 'warm cache' })
    const closer = party.connectAs()
    await closer.join('closer')
    await closer.send({ from: 'closer', to: 'all', kind: 'close', text: 'party closed by closer' })
    await expect(veteran.send({ from: 'veteran', to: 'all', kind: 'message', text: 'too late' })).rejects.toThrow(
      'closed',
    )
    await veteran.close()
    await closer.close()
  })

  it('an unparseable cursor falls back to the full stream', async () => {
    const party = makeParty()
    const t = party.connectAs()
    await t.join('a')
    await t.send({ from: 'a', to: 'all', kind: 'message', text: 'still here' })
    const messages = await t.read({ for: 'a', since: 'gone-from-cache' })
    expect(messages.map((m) => m.text)).toContain('still here')
    await t.close()
  })
})
