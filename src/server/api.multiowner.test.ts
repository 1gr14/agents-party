import { afterAll, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encryptText, generatePartyKey, seal, deriveMasterKeyPair, generateMasterSalt } from '../core/crypto.js'
import { registryPath } from '../core/dirs.js'
import { createSqliteRegistry } from '../registry/sqlite.js'
import { createStorePool } from '../store/pool.js'
import { createPartyApi } from './api.js'

/**
 * Multi-owner semantics — the site's deployment shape: authOwner maps tokens to userIds, zeroKnowledge is on. The
 * critical property: `host` is trustworthy — being SOME owner is not enough, you must own THIS party.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-multiowner-'))
const registryPromise = createSqliteRegistry(registryPath(dir))
const pool = createStorePool(dir)
afterAll(async () => {
  await pool.closeAll()
  await (await registryPromise).close()
})

const USERS: Record<string, string | undefined> = { 'token-alice': 'alice', 'token-bob': 'bob' }

const makeApi = async () => {
  const registry = await registryPromise
  return createPartyApi({
    registry,
    store: (id) => pool.get(id),
    removeStore: (id) => pool.remove(id),
    authOwner: (request) => {
      const token = (request.headers.get('authorization') ?? '').replace('Bearer ', '')
      const ownerId = USERS[token]
      return Promise.resolve(ownerId === undefined ? null : { ownerId })
    },
    zeroKnowledge: true,
  })
}

const call = async (
  api: Awaited<ReturnType<typeof makeApi>>,
  method: string,
  path_: string,
  opts: { token?: string; body?: unknown } = {},
) => {
  const response = await api(
    new Request(`http://site${path_}`, {
      method,
      headers: {
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    }),
  )
  if (response === null) throw new Error(`unhandled: ${method} ${path_}`)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

// The API refuses bodies that aren't shaped like an envelope, so even a "does this endpoint answer" post carries one.
const CIPHERTEXT = await encryptText(generatePartyKey(), 'ct')

const wrappedKey = async (): Promise<string> => {
  const pair = await deriveMasterKeyPair('alice-master', generateMasterSalt())
  return seal(pair.publicKey, generatePartyKey())
}

describe('multi-owner (site-shaped) api', () => {
  it('zero-knowledge: create drops plaintext keys, requires keyWrapped, never returns key', async () => {
    const api = await makeApi()
    const noWrapped = await call(api, 'POST', '/api/parties', { token: 'token-alice', body: { key: 'plain' } })
    expect(noWrapped.status).toBe(400)

    const created = await call(api, 'POST', '/api/parties', {
      token: 'token-alice',
      body: { title: 'a-party', key: 'plaintext-should-be-dropped', keyWrapped: await wrappedKey() },
    })
    expect(created.status).toBe(200)
    expect(created.body.key).toBeNull()
    expect(typeof created.body.keyWrapped).toBe('string')
  })

  it('listing is scoped to the owner', async () => {
    const api = await makeApi()
    await call(api, 'POST', '/api/parties', {
      token: 'token-bob',
      body: { title: 'bobs', keyWrapped: await wrappedKey() },
    })
    const alice = await call(api, 'GET', '/api/parties', { token: 'token-alice' })
    const titles = (alice.body.parties as { title: string }[]).map((p) => p.title)
    expect(titles).toContain('a-party')
    expect(titles).not.toContain('bobs')
  })

  it("host is per-party: another authenticated user cannot join, speak or leave as host in someone else's party", async () => {
    const api = await makeApi()
    const created = await call(api, 'POST', '/api/parties', {
      token: 'token-alice',
      body: { title: 'alice-party', keyWrapped: await wrappedKey() },
    })
    const id = created.body.id as string

    // Bob is a valid site user — but not the owner of this party.
    const bobJoin = await call(api, 'POST', `/api/parties/${id}/join`, { token: 'token-bob', body: { name: 'host' } })
    expect(bobJoin.status).toBe(401)

    const aliceJoin = await call(api, 'POST', `/api/parties/${id}/join`, {
      token: 'token-alice',
      body: { name: 'host' },
    })
    expect(aliceJoin.status).toBe(200)

    const bobSpeak = await call(api, 'POST', `/api/parties/${id}/messages`, {
      token: 'token-bob',
      body: { from: 'host', to: '*', text: CIPHERTEXT },
    })
    expect(bobSpeak.status).toBe(401)

    const aliceSpeak = await call(api, 'POST', `/api/parties/${id}/messages`, {
      token: 'token-alice',
      body: { from: 'host', to: '*', text: CIPHERTEXT },
    })
    expect(aliceSpeak.status).toBe(200)

    // Being SOME owner doesn't let you mark this party's host as gone either.
    const bobKick = await call(api, 'POST', `/api/parties/${id}/leave`, { token: 'token-bob', body: { name: 'host' } })
    expect(bobKick.status).toBe(401)
    const anonKick = await call(api, 'POST', `/api/parties/${id}/leave`, { body: { name: 'host' } })
    expect(anonKick.status).toBe(401)
  })

  it("management is per-party too: no deleting or reading keys of someone else's party", async () => {
    const api = await makeApi()
    const created = await call(api, 'POST', '/api/parties', {
      token: 'token-alice',
      body: { title: 'alice-keeps', keyWrapped: await wrappedKey() },
    })
    const id = created.body.id as string

    expect((await call(api, 'DELETE', `/api/parties/${id}`, { token: 'token-bob' })).status).toBe(401)
    const bobView = await call(api, 'GET', `/api/parties/${id}`, { token: 'token-bob' })
    expect(bobView.status).toBe(200) // meta is open by id knowledge…
    expect(bobView.body.keyWrapped).toBeUndefined() // …but keys are only for the owner
    const aliceView = await call(api, 'GET', `/api/parties/${id}`, { token: 'token-alice' })
    expect(typeof aliceView.body.keyWrapped).toBe('string')
    expect((await call(api, 'DELETE', `/api/parties/${id}`, { token: 'token-alice' })).status).toBe(200)
  })

  it('participating needs no account at all — just the party id', async () => {
    const api = await makeApi()
    const created = await call(api, 'POST', '/api/parties', {
      token: 'token-alice',
      body: { title: 'open', keyWrapped: await wrappedKey() },
    })
    const id = created.body.id as string
    expect((await call(api, 'POST', `/api/parties/${id}/join`, { body: { name: 'guest' } })).status).toBe(200)
    expect(
      (await call(api, 'POST', `/api/parties/${id}/messages`, { body: { from: 'guest', to: '*', text: CIPHERTEXT } }))
        .status,
    ).toBe(200)
    expect((await call(api, 'GET', `/api/parties/${id}/messages`)).status).toBe(200)
  })
})
