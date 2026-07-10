import { describe, expect, it } from 'bun:test'
import type { Transport } from '../types.js'

/**
 * The transport contract suite — what keeps "pluggable" honest. Every transport (local SQLite, ntfy, future relays)
 * must pass exactly these specs; a new transport gets its test file by calling this with a factory.
 */

export interface PartyHarness {
  /** A fresh connection to the same party — a distinct Transport instance. */
  connectAs(name: string): Promise<Transport>
}

const expectRejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the promise to reject')
}

export const describeTransportContract = (label: string, makeParty: () => Promise<PartyHarness>): void => {
  describe(`${label} · transport contract`, () => {
    it('join registers an active participant', async () => {
      const party = await makeParty()
      const t = await party.connectAs('a')
      const joined = await t.join('a')
      expect(joined.name).toBe('a')
      const participants = await t.participants()
      expect(participants.map((p) => p.name)).toEqual(['a'])
      expect(participants[0]?.leftTs).toBeUndefined()
      await t.close()
    })

    it('rejects reserved and malformed names', async () => {
      const party = await makeParty()
      const t = await party.connectAs('validator')
      for (const bad of ['all', 'ALL', '*', 'a b', 'x,y', '@host', 'host@', '', 'a'.repeat(33)]) {
        const error = await expectRejection(t.join(bad))
        expect(error.message).toMatch(/reserved|Invalid participant name/)
      }
      await t.close()
    })

    it('rejects a name that is already active', async () => {
      const party = await makeParty()
      const first = await party.connectAs('a')
      await first.join('a')
      const second = await party.connectAs('a')
      const error = await expectRejection(second.join('a'))
      expect(error.message).toContain('already taken')
      await first.close()
      await second.close()
    })

    it('allows rejoining after leave', async () => {
      const party = await makeParty()
      const t = await party.connectAs('a')
      await t.join('a')
      await t.leave('a')
      const afterLeave = await t.participants()
      expect(afterLeave.find((p) => p.name === 'a')?.leftTs).toBeDefined()
      await t.join('a')
      const rejoined = await t.participants()
      expect(rejoined.find((p) => p.name === 'a')?.leftTs).toBeUndefined()
      await t.close()
    })

    it('rejects sends from someone who never joined', async () => {
      const party = await makeParty()
      const t = await party.connectAs('ghost')
      const error = await expectRejection(t.send({ from: 'ghost', to: 'all', kind: 'message', text: 'boo' }))
      expect(error.message).toContain('join first')
      await t.close()
    })

    it('delivers broadcasts to everyone, including the sender', async () => {
      const party = await makeParty()
      const a = await party.connectAs('a')
      const b = await party.connectAs('b')
      await a.join('a')
      await b.join('b')
      await a.send({ from: 'a', to: 'all', kind: 'message', text: 'hello all' })
      for (const [t, name] of [
        [a, 'a'],
        [b, 'b'],
      ] as const) {
        const texts = (await t.read({ for: name })).map((m) => m.text)
        expect(texts).toContain('hello all')
      }
      await a.close()
      await b.close()
    })

    it('delivers addressed messages only to recipients (and the sender)', async () => {
      const party = await makeParty()
      const a = await party.connectAs('a')
      const b = await party.connectAs('b')
      const c = await party.connectAs('c')
      await a.join('a')
      await b.join('b')
      await c.join('c')
      await a.send({ from: 'a', to: ['b'], kind: 'message', text: 'secret for b' })
      const forB = (await b.read({ for: 'b' })).map((m) => m.text)
      const forC = (await c.read({ for: 'c' })).map((m) => m.text)
      const forA = (await a.read({ for: 'a' })).map((m) => m.text)
      expect(forB).toContain('secret for b')
      expect(forC).not.toContain('secret for b')
      expect(forA).toContain('secret for b')
      await a.close()
      await b.close()
      await c.close()
    })

    it('reads strictly after a since cursor', async () => {
      const party = await makeParty()
      const t = await party.connectAs('a')
      await t.join('a')
      const first = await t.send({ from: 'a', to: 'all', kind: 'message', text: 'one' })
      await t.send({ from: 'a', to: 'all', kind: 'message', text: 'two' })
      const after = await t.read({ for: 'a', since: first.cursor })
      expect(after.map((m) => m.text)).toEqual(['two'])
      await t.close()
    })

    it('cursors chain: reading since the last message returns nothing', async () => {
      const party = await makeParty()
      const t = await party.connectAs('a')
      await t.join('a')
      await t.send({ from: 'a', to: 'all', kind: 'message', text: 'tail' })
      const all = await t.read({ for: 'a' })
      const last = all.at(-1)
      expect(last).toBeDefined()
      expect(await t.read({ for: 'a', since: last?.cursor })).toEqual([])
      await t.close()
    })

    it('emits join and leave events in the stream', async () => {
      const party = await makeParty()
      const a = await party.connectAs('a')
      const b = await party.connectAs('b')
      await a.join('a')
      await b.join('b')
      await b.leave('b')
      const kinds = (await a.read({ for: 'a' })).map((m) => `${m.kind}:${m.from}`)
      expect(kinds).toContain('join:a')
      expect(kinds).toContain('join:b')
      expect(kinds).toContain('leave:b')
      await a.close()
      await b.close()
    })

    it('preserves message order', async () => {
      const party = await makeParty()
      const t = await party.connectAs('a')
      await t.join('a')
      for (let i = 0; i < 5; i++) {
        await t.send({ from: 'a', to: 'all', kind: 'message', text: `msg ${i}` })
      }
      const texts = (await t.read({ for: 'a' })).filter((m) => m.kind === 'message').map((m) => m.text)
      expect(texts).toEqual(['msg 0', 'msg 1', 'msg 2', 'msg 3', 'msg 4'])
      await t.close()
    })

    it('carries the participant description from join to who', async () => {
      const party = await makeParty()
      const t = await party.connectAs('a')
      const joined = await t.join('a', { desc: 'reviews the diffs' })
      expect(joined.desc).toBe('reviews the diffs')
      const listed = await t.participants()
      expect(listed.find((p) => p.name === 'a')?.desc).toBe('reviews the diffs')
      await t.close()
    })

    it('carries replyTo through send and read', async () => {
      const party = await makeParty()
      const t = await party.connectAs('a')
      await t.join('a')
      const original = await t.send({ from: 'a', to: 'all', kind: 'message', text: 'question' })
      await t.send({ from: 'a', to: 'all', kind: 'message', text: 'answer', replyTo: original.id })
      const answer = (await t.read({ for: 'a' })).find((m) => m.text === 'answer')
      expect(answer?.replyTo).toBe(original.id)
      await t.close()
    })

    it('a close event freezes the party: no new sends or joins', async () => {
      const party = await makeParty()
      const a = await party.connectAs('a')
      await a.join('a')
      await a.send({ from: 'a', to: 'all', kind: 'close', text: 'party closed by a' })
      const sendError = await expectRejection(a.send({ from: 'a', to: 'all', kind: 'message', text: 'too late' }))
      expect(sendError.message).toContain('closed')
      const b = await party.connectAs('b')
      const joinError = await expectRejection(b.join('b'))
      expect(joinError.message).toContain('closed')
      await a.close()
      await b.close()
    })

    it('handles concurrent writers without losing messages', async () => {
      const party = await makeParty()
      const a = await party.connectAs('a')
      const b = await party.connectAs('b')
      await a.join('a')
      await b.join('b')
      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => a.send({ from: 'a', to: 'all', kind: 'message', text: `a${i}` })),
        ...Array.from({ length: 10 }, (_, i) => b.send({ from: 'b', to: 'all', kind: 'message', text: `b${i}` })),
      ])
      const messages = (await a.read({ for: 'a' })).filter((m) => m.kind === 'message')
      expect(messages).toHaveLength(20)
      expect(new Set(messages.map((m) => m.id)).size).toBe(20)
      await a.close()
      await b.close()
    })
  })
}
