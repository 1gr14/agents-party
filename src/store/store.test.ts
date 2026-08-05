import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openPartyStore } from './store.js'

const tempStore = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-store-'))
  return openPartyStore(path.join(dir, 'party.sqlite'))
}

const expectRejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the promise to reject')
}

describe('party store', () => {
  it('join registers an active participant and emits a join event', async () => {
    const store = await tempStore()
    const joined = await store.join('a', { desc: 'tester' })
    expect(joined).toMatchObject({ name: 'a', desc: 'tester' })
    expect(await store.participants()).toMatchObject([{ name: 'a', desc: 'tester' }])
    const messages = await store.read()
    expect(messages).toMatchObject([{ kind: 'join', from: 'a', to: '*' }])
    await store.close()
  })

  it('rejects reserved and malformed names; host only with owner flag', async () => {
    const store = await tempStore()
    for (const bad of ['all', 'ALL', 'admin', 'Admin', '*', 'a b', 'x,y', '@x', '', 'a'.repeat(33)]) {
      const error = await expectRejection(store.join(bad))
      expect(error.message).toMatch(/reserved|Invalid participant name/)
    }
    await expectRejection(store.join('host'))
    await expectRejection(store.join('Host'))
    const host = await store.join('host', { owner: true })
    expect(host.name).toBe('host')
    await store.close()
  })

  it('owner rejoin under the owner name is idempotent: same row back, no duplicate join event, no NAME_TAKEN', async () => {
    const store = await tempStore()
    const first = await store.join('host', { owner: true, desc: 'the human' })
    const again = await store.join('host', { owner: true })
    expect(again).toMatchObject({ name: 'host', color: first.color, desc: 'the human' })
    expect((await store.read()).filter((m) => m.kind === 'join')).toHaveLength(1)
    // Only the owner name is idempotent — an agent rejoining an active foreign name still collides.
    await store.join('a', { owner: true })
    const error = await expectRejection(store.join('a', { owner: true }))
    expect(error.message).toContain('already taken')
    await store.close()
  })

  it('rejects an active duplicate name, allows rejoin after leave', async () => {
    const store = await tempStore()
    await store.join('a')
    const error = await expectRejection(store.join('a'))
    expect(error.message).toContain('already taken')
    await store.leave('a')
    await store.leave('a') // leaving twice is a no-op
    await store.join('a')
    expect((await store.participants()).filter((p) => p.leftAt === undefined)).toHaveLength(1)
    await store.close()
  })

  it('append requires an active participant and only kind message', async () => {
    const store = await tempStore()
    await expectRejection(store.append({ from: 'ghost', to: '*', kind: 'message', text: 'x' }))
    await store.join('a')
    await expectRejection(store.append({ from: 'a', to: '*', kind: 'join', text: '' }))
    const msg = await store.append({ from: 'a', to: '*', kind: 'message', text: 'ct' })
    expect(msg).toMatchObject({ from: 'a', to: '*', kind: 'message', text: 'ct' })
    expect(Number(msg.cursor)).toBeGreaterThan(0)
    await store.close()
  })

  it('read: since-cursor, visibility for a viewer, everything for the owner view', async () => {
    const store = await tempStore()
    await store.join('a')
    await store.join('b')
    await store.join('c')
    await store.append({ from: 'a', to: '*', kind: 'message', text: 'broadcast' })
    const dm = await store.append({ from: 'a', to: ['b'], kind: 'message', text: 'dm-for-b' })
    await store.append({ from: 'b', to: ['a'], kind: 'message', text: 'reply', replyTo: dm.id })

    const forC = await store.read({ for: 'c' })
    expect(forC.filter((m) => m.kind === 'message').map((m) => m.text)).toEqual(['broadcast'])

    const forB = await store.read({ for: 'b' })
    expect(forB.filter((m) => m.kind === 'message').map((m) => m.text)).toEqual(['broadcast', 'dm-for-b', 'reply'])

    const ownerView = await store.read()
    expect(ownerView.filter((m) => m.kind === 'message')).toHaveLength(3)

    const sinceCursor = forB.at(-2)?.cursor
    const newer = await store.read({ for: 'b', since: sinceCursor })
    expect(newer.map((m) => m.text)).toEqual(['reply'])
    await store.close()
  })

  it('pagination: limit takes the latest N (ascending), before scrolls older, visibility cannot starve a page', async () => {
    const store = await tempStore()
    await store.join('a')
    await store.join('b')
    for (let i = 1; i <= 5; i++) await store.append({ from: 'a', to: '*', kind: 'message', text: `pub-${i}` })
    await store.append({ from: 'a', to: ['a'], kind: 'message', text: 'self-dm' })

    const latest = await store.read({ limit: 3 })
    expect(latest.map((m) => m.text)).toEqual(['pub-4', 'pub-5', 'self-dm'])

    const older = await store.read({ limit: 3, before: latest[0]?.cursor })
    expect(older.map((m) => m.text)).toEqual(['pub-1', 'pub-2', 'pub-3'])

    // b cannot see the dm — the page still fills up with the latest messages b MAY see.
    const forB = await store.read({ for: 'b', limit: 2 })
    expect(forB.map((m) => m.text)).toEqual(['pub-4', 'pub-5'])
    await store.close()
  })

  it('stats report count, size and last activity', async () => {
    const store = await tempStore()
    expect(await store.stats()).toMatchObject({ messagesCount: 0, lastMessageAt: null })
    await store.join('a')
    const msg = await store.append({ from: 'a', to: '*', kind: 'message', text: 'x' })
    const stats = await store.stats()
    expect(stats.messagesCount).toBe(2) // join event + message
    expect(stats.lastMessageAt).toBe(msg.ts)
    expect(stats.sizeBytes).toBeGreaterThan(0)
    await store.close()
  })
})
