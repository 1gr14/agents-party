import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connect } from './party.js'
import { createLocalParty } from './transports/local.js'

const makeParty = async (): Promise<string> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-client-'))
  const { ref } = await createLocalParty({ dir })
  return ref
}

describe('PartyClient', () => {
  it('connect does not join — sending before join fails', async () => {
    const client = await connect(await makeParty(), { as: 'a' })
    await expect(client.send('too early')).rejects.toThrow('join first')
    await client.close()
  })

  it('send/read round-trip with default broadcast', async () => {
    const ref = await makeParty()
    const a = await connect(ref, { as: 'a' })
    await a.join()
    await a.send('hello')
    const texts = (await a.read()).filter((m) => m.kind === 'message').map((m) => m.text)
    expect(texts).toEqual(['hello'])
    await a.close()
  })

  it('listen wakes on another participant message and skips own ones', async () => {
    const ref = await makeParty()
    const a = await connect(ref, { as: 'a' })
    const b = await connect(ref, { as: 'b' })
    await a.join()
    await b.join()
    await a.send('my own message — must not wake me')

    const listening = a.listen({ pollMs: 20, timeoutMs: 3000 })
    setTimeout(() => {
      void b.send('wake up, a!', { to: ['a'] })
    }, 60)
    const messages = await listening
    expect(messages.map((m) => m.text)).toEqual(['wake up, a!'])
    expect(messages[0]?.from).toBe('b')
    await a.close()
    await b.close()
  })

  it('listen returns [] on timeout', async () => {
    const ref = await makeParty()
    const a = await connect(ref, { as: 'a' })
    await a.join()
    const messages = await a.listen({ pollMs: 20, timeoutMs: 150 })
    expect(messages).toEqual([])
    await a.close()
  })

  it('listen starts from an explicit since cursor', async () => {
    const ref = await makeParty()
    const a = await connect(ref, { as: 'a' })
    const b = await connect(ref, { as: 'b' })
    await a.join()
    await b.join()
    const old = await b.send('already seen')
    await b.send('new one')
    const messages = await a.listen({ since: old.cursor, pollMs: 20, timeoutMs: 3000 })
    expect(messages.map((m) => m.text)).toEqual(['new one'])
    await a.close()
    await b.close()
  })

  it('tailCursor points at the latest visible message', async () => {
    const ref = await makeParty()
    const a = await connect(ref, { as: 'a' })
    await a.join()
    const sent = await a.send('tail')
    expect(await a.tailCursor()).toBe(sent.cursor)
    await a.close()
  })

  it('who reflects join and leave', async () => {
    const ref = await makeParty()
    const a = await connect(ref, { as: 'a' })
    const b = await connect(ref, { as: 'b' })
    await a.join()
    await b.join()
    await b.leave()
    const who = await a.who()
    expect(who.find((p) => p.name === 'a')?.leftTs).toBeUndefined()
    expect(who.find((p) => p.name === 'b')?.leftTs).toBeDefined()
    await a.close()
    await b.close()
  })

  it('requires a participant name', async () => {
    await expect(connect(await makeParty(), { as: '' })).rejects.toThrow('--as')
  })

  it('listen --to-me wakes only on messages that concern me', async () => {
    const ref = await makeParty()
    const a = await connect(ref, { as: 'a' })
    const b = await connect(ref, { as: 'b' })
    await a.join()
    await b.join()

    const listening = a.listen({ pollMs: 20, timeoutMs: 3000, toMe: true })
    await b.send('general chatter, not for a specifically')
    setTimeout(() => {
      void b.send('hey @a, look at this')
    }, 80)
    const messages = await listening
    expect(messages.map((m) => m.text)).toEqual(['hey @a, look at this'])
    await a.close()
    await b.close()
  })

  it('endParty freezes the party', async () => {
    const ref = await makeParty()
    const a = await connect(ref, { as: 'a' })
    await a.join()
    await a.endParty()
    await expect(a.send('too late')).rejects.toThrow('closed')
    await a.close()
  })

  it('join carries the description', async () => {
    const ref = await makeParty()
    const a = await connect(ref, { as: 'a' })
    await a.join({ desc: 'runs the tests' })
    expect((await a.who()).find((p) => p.name === 'a')?.desc).toBe('runs the tests')
    await a.close()
  })
})
