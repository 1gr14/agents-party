import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createParty } from './client/connection.js'
import { partiesDir, partyFilePath, registryPath } from './core/dirs.js'
import { prune, pruneRemote, parseDuration } from './prune.js'
import { createSqliteRegistry } from './registry/sqlite.js'
import { startServer } from './server/http.js'

const DAY_MS = 86_400_000

let dir = ''
let prevDir: string | undefined

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-prune-'))
  prevDir = process.env.AGENTS_PARTY_DIR
  process.env.AGENTS_PARTY_DIR = dir
})

afterEach(() => {
  if (prevDir === undefined) delete process.env.AGENTS_PARTY_DIR
  else process.env.AGENTS_PARTY_DIR = prevDir
})

/** Create a local party in the isolated dir and return its id (the connection is closed right away). */
const makeParty = async (title = 'demo'): Promise<string> => {
  const created = await createParty({ title })
  await created.connection.close()
  return created.partyId
}

/** Backdate a party's activity by writing an old lastMessageAt (plus some size/count for the display columns). */
const age = async (id: string, ms: number): Promise<void> => {
  const registry = await createSqliteRegistry(registryPath(dir))
  await registry.touch(id, { lastMessageAt: Date.now() - ms, messagesCount: 3, sizeBytes: 4096 })
  await registry.close()
}

describe('parseDuration', () => {
  it('parses units and bare days', () => {
    expect(parseDuration('7d')).toBe(7 * DAY_MS)
    expect(parseDuration('24h')).toBe(24 * 3_600_000)
    expect(parseDuration('30m')).toBe(30 * 60_000)
    expect(parseDuration('45s')).toBe(45 * 1_000)
    expect(parseDuration('2w')).toBe(2 * 7 * DAY_MS)
    expect(parseDuration('10')).toBe(10 * DAY_MS)
    expect(parseDuration(' 1d ')).toBe(DAY_MS)
  })

  it('rejects garbage', () => {
    expect(() => parseDuration('soon')).toThrow('Invalid duration')
    expect(() => parseDuration('')).toThrow('Invalid duration')
    expect(() => parseDuration('5y')).toThrow('Invalid duration')
  })
})

describe('prune', () => {
  it('reports nothing to prune on an empty dir', async () => {
    expect(await prune({})).toContain('Nothing to prune.')
  })

  it('dry-run lists old parties and skips fresh ones, touching nothing', async () => {
    const oldId = await makeParty('old-one')
    await makeParty('fresh-one') // stays inside the 30-day default window
    await age(oldId, 45 * DAY_MS)

    const out = await prune({})
    expect(out).toContain(oldId)
    expect(out).toContain('old-one')
    expect(out).toContain('45d ago')
    expect(out).toContain('4.0 KB')
    expect(out).toContain('1 party')
    expect(out).toContain('run again with --yes')
    // The fresh party is not listed.
    expect(out).not.toContain('fresh-one')
    // A dry run deletes nothing.
    expect(fs.existsSync(partyFilePath(oldId, dir))).toBe(true)
  })

  it('--all selects fresh parties too', async () => {
    await makeParty()
    await makeParty()
    expect(await prune({})).toContain('Nothing to prune.')
    expect(await prune({ all: true })).toContain('2 parties')
  })

  it('--older-than overrides the default cutoff', async () => {
    const id = await makeParty()
    await age(id, 10 * DAY_MS) // 10 days old — inside 30d, outside 7d
    expect(await prune({})).toContain('Nothing to prune.')
    expect(await prune({ olderThan: '7d' })).toContain(id)
  })

  it('--yes deletes the selected party and its registry row', async () => {
    const id = await makeParty()
    await age(id, 45 * DAY_MS)
    const file = partyFilePath(id, dir)
    expect(fs.existsSync(file)).toBe(true)

    const out = await prune({ yes: true })
    expect(out).toContain('Deleted 1 party')
    expect(fs.existsSync(file)).toBe(false)

    const registry = await createSqliteRegistry(registryPath(dir))
    expect(await registry.get(id)).toBeNull()
    await registry.close()
  })

  it('prunes on a remote server: dry run lists, --yes bulk-deletes by last activity', async () => {
    const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-prune-remote-'))
    const server = await startServer({ dir: serverDir, token: 'prune-token' })
    const host = `127.0.0.1:${server.port}`
    const stale = await createParty({ title: 'stale-one', server: host, token: 'prune-token' })
    await stale.connection.close()
    // Age it on the server's registry directly (lastMessageAt is null, so createdAt drives the age).
    const registry = await createSqliteRegistry(registryPath(serverDir))
    const entry = await registry.get(stale.partyId)
    await registry.remove(stale.partyId)
    await registry.create({ ...entry!, createdAt: Date.now() - 45 * DAY_MS })
    await registry.close()

    const dryRun = await pruneRemote({ server: host, token: 'prune-token', olderThan: '30d' })
    expect(dryRun).toContain('stale-one')
    expect(dryRun).toContain('Dry run')

    const deleted = await pruneRemote({ server: host, token: 'prune-token', olderThan: '30d', yes: true })
    expect(deleted).toContain('Deleted 1 party')
    expect(fs.existsSync(path.join(serverDir, 'parties', `${stale.partyId}.sqlite`))).toBe(false)
    expect(await pruneRemote({ server: host, token: 'prune-token', olderThan: '30d', yes: true })).toBe(
      'Nothing to prune.',
    )
    await server.stop()
  })

  it('lists orphan files with no registry row and deletes them with --yes', async () => {
    const orphanId = randomUUID()
    const orphanFile = partyFilePath(orphanId, dir)
    fs.mkdirSync(partiesDir(dir), { recursive: true })
    fs.writeFileSync(orphanFile, 'not-a-real-db')

    const dryRun = await prune({})
    expect(dryRun).toContain(orphanId)
    expect(dryRun).toContain('(orphaned)')
    expect(dryRun).toContain('orphaned')
    expect(fs.existsSync(orphanFile)).toBe(true)

    const deleted = await prune({ yes: true })
    expect(deleted).toContain('Deleted 1 party')
    expect(fs.existsSync(orphanFile)).toBe(false)
  })
})
