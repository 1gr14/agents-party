import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeTransportContract } from '../testing/contract.js'
import { createLocalParty, createLocalTransport } from './local.js'

const makeTmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-test-'))

describeTransportContract('local', async () => {
  const { path: filePath } = await createLocalParty({ dir: makeTmpDir() })
  return {
    connectAs: () => createLocalTransport(filePath),
  }
})

describe('createLocalParty', () => {
  it('creates a sqlite file and a local ref pointing at it', async () => {
    const dir = makeTmpDir()
    const { ref, path: filePath } = await createLocalParty({ dir, name: 'Fix Flaky Tests' })
    expect(ref).toBe(`local:${filePath}`)
    expect(filePath.startsWith(dir)).toBe(true)
    expect(path.basename(filePath)).toMatch(/^fix-flaky-tests-[0-9a-f]{6}\.sqlite$/)
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('slugs go lowercase and keep only [a-z0-9-]', async () => {
    const { path: filePath } = await createLocalParty({ dir: makeTmpDir(), name: 'Ой! v2.0' })
    expect(path.basename(filePath)).toMatch(/^[a-z0-9-]+-[0-9a-f]{6}\.sqlite$/)
  })
})

describe('local transport specifics', () => {
  it('rejects a malformed cursor', async () => {
    const { path: filePath } = await createLocalParty({ dir: makeTmpDir() })
    const t = await createLocalTransport(filePath)
    await t.join('a')
    await expect(t.read({ for: 'a', since: 'not-a-number' })).rejects.toThrow('Invalid cursor')
    await t.close()
  })
})
