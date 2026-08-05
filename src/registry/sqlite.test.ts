import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generatePartyKey } from '../core/crypto.js'
import { defaultSettings } from '../core/types.js'
import type { PartyMeta } from '../core/types.js'
import { createSqliteRegistry } from './sqlite.js'

const tempRegistry = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-registry-'))
  return createSqliteRegistry(path.join(dir, 'registry.sqlite'))
}

const meta = (id: string, overrides: Partial<PartyMeta> = {}): PartyMeta => ({
  id,
  title: id,
  createdAt: Date.now(),
  lastMessageAt: null,
  messagesCount: 0,
  sizeBytes: 0,
  key: generatePartyKey(),
  keyWrapped: null,
  settings: defaultSettings(),
  ...overrides,
})

describe('sqlite registry', () => {
  it('creates and gets a party with its key and settings', async () => {
    const registry = await tempRegistry()
    const m = meta('p1')
    await registry.create(m)
    const got = await registry.get('p1')
    expect(got).toMatchObject({ id: 'p1', title: 'p1', key: m.key, keyWrapped: null, ownerId: null })
    expect(got?.settings).toEqual({ joinPolicy: 'open' })
    expect(await registry.get('missing')).toBeNull()
    await registry.close()
  })

  it('lists newest-activity-first and filters by owner', async () => {
    const registry = await tempRegistry()
    await registry.create(meta('old', { createdAt: 1000 }))
    await registry.create(meta('fresh', { createdAt: 2000 }))
    await registry.create(meta('busy', { createdAt: 500 }), 'user-a')
    await registry.touch('busy', { lastMessageAt: 9000, messagesCount: 3, sizeBytes: 42 })

    const all = await registry.list()
    expect(all.map((p) => p.id)).toEqual(['busy', 'fresh', 'old'])

    const userA = await registry.list('user-a')
    expect(userA.map((p) => p.id)).toEqual(['busy'])
    expect(userA[0]).toMatchObject({ messagesCount: 3, sizeBytes: 42, lastMessageAt: 9000, ownerId: 'user-a' })
    await registry.close()
  })

  it('renames, updates settings, removes', async () => {
    const registry = await tempRegistry()
    await registry.create(meta('p1'))
    await registry.rename('p1', 'better title')
    await registry.updateSettings('p1', { joinPolicy: 'open' })
    expect((await registry.get('p1'))?.title).toBe('better title')
    await registry.remove('p1')
    expect(await registry.get('p1')).toBeNull()
    await registry.close()
  })
})
