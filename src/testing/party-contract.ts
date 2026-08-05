import { describe, expect, it } from 'bun:test'
import type { PartyConnection } from '../client/connection.js'

/**
 * The v2 contract suite — what keeps "one interface over both protocols" honest. Local connections, connections to the
 * package server, and connections to the site must all pass exactly these specs; a deployment gets its test file by
 * calling this with a factory.
 */

export interface PartyHarness {
  /** A fresh connection to the same party (a distinct client instance, same ref). */
  connect(): Promise<PartyConnection>
}

const expectRejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the promise to reject')
}

export const describePartyContract = (label: string, makeParty: () => Promise<PartyHarness>): void => {
  describe(`${label} · party contract`, () => {
    it('join registers an active participant and shows up as an event', async () => {
      const party = await makeParty()
      const c = await party.connect()
      const joined = await c.join('a', { desc: 'tester' })
      expect(joined).toMatchObject({ name: 'a', desc: 'tester' })
      expect(await c.participants()).toMatchObject([{ name: 'a', desc: 'tester' }])
      expect((await c.read()).map((m) => m.kind)).toEqual(['join'])
      await c.close()
    })

    it('rejects reserved and malformed names (host is the owner name, admin stays reserved)', async () => {
      const party = await makeParty()
      const c = await party.connect()
      // 'hоst'/'аgent' carry a Cyrillic letter: mixed-alphabet names render identically to Latin ones, so a guest
      // could visually impersonate the owner (or another participant) — rejected outright.
      for (const bad of ['all', 'admin', '*', 'a b', 'x,y', '@x', '', 'a'.repeat(33), 'hоst', 'аgent']) {
        const error = await expectRejection(c.join(bad))
        expect(error.message).toMatch(/reserved|Invalid participant name/)
      }
      await c.close()
    })

    it('assigns stable colors: palette in join order, black only for the host, rejoin keeps the color', async () => {
      const party = await makeParty()
      const c = await party.connect()
      const a = await c.join('a')
      const b = await c.join('b')
      expect(a.color).not.toBe('black')
      expect(b.color).not.toBe('black')
      expect(a.color).not.toBe(b.color)
      await c.leave('a')
      const again = await c.join('a')
      expect(again.color).toBe(a.color)
      const listed = await c.participants()
      expect(listed.find((p) => p.name === 'b')?.color).toBe(b.color)
      await c.close()
    })

    it('rejects an active duplicate name, allows rejoin after leave', async () => {
      const party = await makeParty()
      const first = await party.connect()
      await first.join('a')
      const second = await party.connect()
      const error = await expectRejection(second.join('a'))
      expect(error.message).toContain('already taken')
      await first.leave('a')
      await second.join('a')
      await first.close()
      await second.close()
    })

    it('round-trips broadcast text (encrypted in flight, decrypted on read)', async () => {
      const party = await makeParty()
      const c = await party.connect()
      await c.join('a')
      const sent = await c.send('a', 'привет, вечеринка')
      expect(sent.text).toBe('привет, вечеринка')
      const read = (await c.read({ for: 'a' })).filter((m) => m.kind === 'message')
      expect(read).toMatchObject([{ from: 'a', to: '*', text: 'привет, вечеринка' }])
      await c.close()
    })

    it('addressed messages: recipients and the sender see them, others do not', async () => {
      const party = await makeParty()
      const c = await party.connect()
      await c.join('a')
      await c.join('b')
      await c.join('c')
      await c.send('a', 'public')
      const dm = await c.send('a', 'for b only', { to: ['b'] })
      await c.send('b', 'reply', { to: ['a'], replyTo: dm.id })

      const texts = async (viewer: string) =>
        (await c.read({ for: viewer })).filter((m) => m.kind === 'message').map((m) => m.text)
      expect(await texts('c')).toEqual(['public'])
      expect(await texts('b')).toEqual(['public', 'for b only', 'reply'])
      expect(await texts('a')).toEqual(['public', 'for b only', 'reply'])
      await c.close()
    })

    it('cursoring: since returns only newer, cursors are stable across connections', async () => {
      const party = await makeParty()
      const c1 = await party.connect()
      await c1.join('a')
      await c1.send('a', 'one')
      const two = await c1.send('a', 'two')
      const c2 = await party.connect()
      const all = await c2.read({ for: 'a' })
      const sinceFirst = await c2.read({ for: 'a', since: all.at(-2)?.cursor })
      expect(sinceFirst.map((m) => m.text)).toEqual(['two'])
      expect(sinceFirst[0]?.id).toBe(two.id)
      await c1.close()
      await c2.close()
    })

    it('sending without joining is rejected', async () => {
      const party = await makeParty()
      const c = await party.connect()
      const error = await expectRejection(c.send('ghost', 'boo'))
      expect(error.message).toContain('join first')
      await c.close()
    })

    it('a multiline patch survives the round-trip byte-exact', async () => {
      const party = await makeParty()
      const c = await party.connect()
      await c.join('a')
      const patch = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n'
      await c.send('a', patch)
      const read = (await c.read({ for: 'a' })).filter((m) => m.kind === 'message')
      expect(read[0]?.text).toBe(patch)
      await c.close()
    })

    it('listen wakes on a foreign message and returns it decrypted', async () => {
      const party = await makeParty()
      const listener = await party.connect()
      const speaker = await party.connect()
      await listener.join('ear')
      await speaker.join('mouth')
      const cursor = (await listener.read({ for: 'ear' })).at(-1)?.cursor
      const wait = listener.listen('ear', { since: cursor, timeoutMs: 10_000 })
      await new Promise((resolve) => setTimeout(resolve, 150))
      await speaker.send('mouth', 'wake up')
      const messages = await wait
      expect(messages.filter((m) => m.kind === 'message').map((m) => m.text)).toEqual(['wake up'])
      await listener.close()
      await speaker.close()
    })

    it('without a cursor listen waits for what comes NEXT, it does not replay the backlog', async () => {
      const party = await makeParty()
      const listener = await party.connect()
      const speaker = await party.connect()
      await listener.join('ear')
      await speaker.join('mouth')
      await speaker.send('mouth', 'old news')
      // No `since`: the backlog above must NOT end this wait — `read` is what serves history.
      const wait = listener.listen('ear', { timeoutMs: 10_000 })
      await new Promise((resolve) => setTimeout(resolve, 400))
      await speaker.send('mouth', 'the new thing')
      const messages = await wait
      expect(messages.filter((m) => m.kind === 'message').map((m) => m.text)).toEqual(['the new thing'])
      await listener.close()
      await speaker.close()
    })

    it('listen times out quietly when nothing arrives', async () => {
      const party = await makeParty()
      const c = await party.connect()
      await c.join('a')
      const cursor = (await c.read({ for: 'a' })).at(-1)?.cursor
      expect(await c.listen('a', { since: cursor, timeoutMs: 1200 })).toEqual([])
      await c.close()
    })
  })
}
