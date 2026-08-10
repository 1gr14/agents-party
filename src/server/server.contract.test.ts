import { afterAll, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encryptText, generatePartyKey } from '../core/crypto.js'
import { connectParty, createParty } from '../client/connection.js'
import { describePartyContract } from '../testing/party-contract.js'
import { isLoopbackAddress, startServer } from './http.js'

/**
 * The remote protocol runs the same contract through a real package server over HTTP — exactly the wiring of
 * self-hosted deployments (and, api-wise, of the site).
 */

const TOKEN = 'test-server-token'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-server-'))
const serverPromise = startServer({ dir, token: TOKEN })
afterAll(async () => {
  await (await serverPromise).stop()
})

const makeParty = async () => {
  const server = `127.0.0.1:${(await serverPromise).port}`
  const { ref } = await createParty({ title: 'contract', server, token: TOKEN })
  return { connect: () => connectParty(ref) }
}

describePartyContract('package server', makeParty)

describe('package server specifics', () => {
  it('owner endpoints demand the token; party endpoints work by ref alone', async () => {
    const server = await serverPromise
    const { partyId } = await createParty({ title: 'auth-check', server: `127.0.0.1:${server.port}`, token: TOKEN })

    const noToken = await fetch(`${server.url}/api/parties`)
    expect(noToken.status).toBe(401)
    const badToken = await fetch(`${server.url}/api/parties`, { headers: { authorization: 'Bearer wrong' } })
    expect(badToken.status).toBe(401)
    const listed = await fetch(`${server.url}/api/parties`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(listed.status).toBe(200)

    const participants = await fetch(`${server.url}/api/parties/${partyId}/participants`)
    expect(participants.status).toBe(200)
  })

  it('stores ciphertext, never plaintext (the wire and the file)', async () => {
    const server = await serverPromise
    const host = `127.0.0.1:${server.port}`
    const { ref, partyId, connection } = await createParty({ title: 'e2e-check', server: host, token: TOKEN })
    await connection.join('a')
    await connection.send('a', 'SENTINEL-SECRET')

    // Raw wire: ciphertext only.
    const raw = await fetch(`${server.url}/api/parties/${partyId}/messages`)
    expect(await raw.text()).not.toContain('SENTINEL-SECRET')

    // The file on the server's disk: ciphertext only.
    const file = fs.readFileSync(path.join(dir, 'parties', `${partyId}.sqlite`))
    expect(file.includes(Buffer.from('SENTINEL-SECRET'))).toBe(false)

    // …while the ref-holder reads plaintext.
    const reader = await connectParty(ref)
    const read = (await reader.read({ for: 'a' })).filter((m) => m.kind === 'message')
    expect(read[0]?.text).toBe('SENTINEL-SECRET')
    await connection.close()
    await reader.close()
  })

  it('a ref without the key yields undecrypted markers, not silence', async () => {
    const server = await serverPromise
    const host = `127.0.0.1:${server.port}`
    const { ref, connection } = await createParty({ title: 'nokey', server: host, token: TOKEN })
    await connection.join('a')
    await connection.send('a', 'hidden')
    const bareRef = ref.split('#')[0] ?? ref
    const blind = await connectParty(bareRef)
    const messages = (await blind.read({ for: 'a' })).filter((m) => m.kind === 'message')
    expect(messages[0]).toMatchObject({ text: '', undecrypted: true })
    await expect(blind.send('a', 'x')).rejects.toThrow('No encryption key')
    await connection.close()
    await blind.close()
  })

  it('host is reserved: joining, speaking or leaving as host needs the owner token', async () => {
    const server = await serverPromise
    const serverHost = `127.0.0.1:${server.port}`
    const { partyId, connection } = await createParty({ title: 'host-check', server: serverHost, token: TOKEN })

    const joinBare = await fetch(`${server.url}/api/parties/${partyId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'host' }),
    })
    expect(joinBare.status).toBe(401)

    await connection.join('host') // the owner-authed connection may
    const speakBare = await fetch(`${server.url}/api/parties/${partyId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'host', to: '*', text: 'x' }),
    })
    expect(speakBare.status).toBe(401)

    // A forged "host left" would be a lie about the one name the model guarantees — so kicking the host is owner-only.
    const leaveBare = await fetch(`${server.url}/api/parties/${partyId}/leave`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'host' }),
    })
    expect(leaveBare.status).toBe(401)
    expect((await connection.participants()).find((p) => p.name === 'host')?.leftAt).toBeUndefined()

    await connection.leave('host') // the owner may
    expect((await connection.participants()).find((p) => p.name === 'host')?.leftAt).toBeGreaterThan(0)
    await connection.close()
  })

  it('deletion removes the registry row and the files', async () => {
    const server = await serverPromise
    const host = `127.0.0.1:${server.port}`
    const { partyId, connection } = await createParty({ title: 'doomed', server: host, token: TOKEN })
    await connection.join('a')
    await connection.send('a', 'bye')
    const file = path.join(dir, 'parties', `${partyId}.sqlite`)
    expect(fs.existsSync(file)).toBe(true)

    const deleted = await fetch(`${server.url}/api/parties/${partyId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(deleted.status).toBe(200)
    expect(fs.existsSync(file)).toBe(false)
    const gone = await fetch(`${server.url}/api/parties/${partyId}/participants`)
    expect(gone.status).toBe(404)
    await connection.close()
  })

  it('economics: the registry tracks counts, size and last activity', async () => {
    const server = await serverPromise
    const host = `127.0.0.1:${server.port}`
    const { partyId, connection } = await createParty({ title: 'counted', server: host, token: TOKEN })
    await connection.join('a')
    const sent = await connection.send('a', 'x')
    const meta = (await (
      await fetch(`${server.url}/api/parties/${partyId}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json()) as { messagesCount: number; sizeBytes: number; lastMessageAt: number }
    expect(meta.messagesCount).toBe(2) // join event + message
    expect(meta.sizeBytes).toBeGreaterThan(0)
    expect(meta.lastMessageAt).toBe(sent.ts)
    await connection.close()
  })

  it('refuses to listen beyond loopback without a token', async () => {
    await expect(startServer({ dir, host: '0.0.0.0', token: undefined })).rejects.toThrow('without a token')
  })

  it('listen with all=1 wakes the owner on a message addressed to somebody else', async () => {
    const server = await serverPromise
    const host = `127.0.0.1:${server.port}`
    const { partyId, connection } = await createParty({ title: 'owner-view', server: host, token: TOKEN })
    await connection.join('a')
    await connection.join('b')
    const seen = (await connection.read()).at(-1)?.cursor
    const listenUrl = (extra: string): string =>
      `${server.url}/api/parties/${partyId}/listen?for=host&timeoutSec=3&since=${seen ?? ''}${extra}`

    // The owner's stream and a participant's stream, both parked before the write lands.
    const ownerView = fetch(listenUrl('&all=1')).then(async (res) => (await res.json()) as { messages: unknown[] })
    const filteredView = fetch(listenUrl('')).then(async (res) => (await res.json()) as { messages: unknown[] })
    await connection.send('a', 'for b alone', { to: ['b'] })

    // Unfiltered: the owner watching the party sees the side conversation as it happens, which is the whole point of
    // the flag — before it, this message reached the viewer only when the page was reloaded into the history.
    expect((await ownerView).messages).toHaveLength(1)
    // Filtered (what an agent asks for): still none of its business, so the poll runs out instead.
    expect((await filteredView).messages).toHaveLength(0)
    await connection.close()
  })

  it('the registry list pages with limit/offset, newest activity first', async () => {
    const server = await serverPromise
    const host = `127.0.0.1:${server.port}`
    const auth = { authorization: `Bearer ${TOKEN}` }
    const titles = ['page-a', 'page-b', 'page-c']
    for (const title of titles) {
      const { connection } = await createParty({ title, server: host, token: TOKEN })
      await connection.join('a')
      await connection.send('a', `hello from ${title}`)
      await connection.close()
    }
    type Meta = { title: string }
    const page1 = (await (await fetch(`${server.url}/api/parties?limit=2`, { headers: auth })).json()) as {
      parties: Meta[]
    }
    const page2 = (await (await fetch(`${server.url}/api/parties?limit=2&offset=2`, { headers: auth })).json()) as {
      parties: Meta[]
    }
    expect(page1.parties).toHaveLength(2)
    expect(page1.parties[0]?.title).toBe('page-c') // newest activity first
    expect(page1.parties[1]?.title).toBe('page-b')
    expect(page2.parties.map((p) => p.title)).toContain('page-a')
    const bad = await fetch(`${server.url}/api/parties?limit=-1`, { headers: auth })
    expect(bad.status).toBe(400)
  })

  it('bulk delete removes parties by last activity and frees their files', async () => {
    const bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-bulk-'))
    const server = await startServer({ dir: bulkDir, token: TOKEN })
    const host = `127.0.0.1:${server.port}`
    const auth = { authorization: `Bearer ${TOKEN}` }
    const old = await createParty({ title: 'old', server: host, token: TOKEN })
    await old.connection.join('a')
    await old.connection.send('a', 'ancient')
    await old.connection.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const cutoff = Date.now()
    const fresh = await createParty({ title: 'fresh', server: host, token: TOKEN })
    await fresh.connection.join('a')
    await fresh.connection.send('a', 'new one')
    await fresh.connection.close()

    const result = (await (
      await fetch(`${server.url}/api/parties?lastMessageBefore=${cutoff}`, { method: 'DELETE', headers: auth })
    ).json()) as { deleted: number; freedBytes: number }
    expect(result.deleted).toBe(1)
    expect(result.freedBytes).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(bulkDir, 'parties', `${old.partyId}.sqlite`))).toBe(false)
    expect(fs.existsSync(path.join(bulkDir, 'parties', `${fresh.partyId}.sqlite`))).toBe(true)

    const unauthorized = await fetch(`${server.url}/api/parties?all=true`, { method: 'DELETE' })
    expect(unauthorized.status).toBe(401)
    await server.stop()
  })

  it('rejects a message over 1 MB', async () => {
    const server = await serverPromise
    const host = `127.0.0.1:${server.port}`
    const { partyId, connection } = await createParty({ title: 'big', server: host, token: TOKEN })
    await connection.join('a')
    // Straight to the wire — the encrypt step would make a real >1MB plaintext slow for nothing.
    const response = await fetch(`${server.url}/api/parties/${partyId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'a', to: '*', text: 'x'.repeat(1_000_001) }),
    })
    // The standalone server's own body cap answers first (413); the API-level cap would say 400.
    expect([400, 413]).toContain(response.status)
    await connection.close()
  })

  it('caps the metadata too: recipients, recipient names, replyTo, desc', async () => {
    const server = await serverPromise
    const host = `127.0.0.1:${server.port}`
    const { partyId, connection } = await createParty({ title: 'caps', server: host, token: TOKEN })
    await connection.join('a')
    const ciphertext = await encryptText(generatePartyKey(), 'hi')
    const post = async (body: Record<string, unknown>): Promise<number> =>
      (
        await fetch(`${server.url}/api/parties/${partyId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: 'a', text: ciphertext, ...body }),
        })
      ).status

    expect(await post({ to: Array.from({ length: 64 }, (_, i) => `n${i}`) })).toBe(200)
    expect(await post({ to: Array.from({ length: 65 }, (_, i) => `n${i}`) })).toBe(400) // a party is not a mailing list
    expect(await post({ to: ['x'.repeat(2000)] })).toBe(400) // a recipient is a name, not a payload
    expect(await post({ to: ['host'] })).toBe(200) // …but `host` is a legitimate addressee
    expect(await post({ replyTo: 'r'.repeat(129) })).toBe(400)

    const join = await fetch(`${server.url}/api/parties/${partyId}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'wordy', desc: 'd'.repeat(201) }),
    })
    expect(join.status).toBe(400)
    await connection.close()
  })

  it('refuses a body that is not even shaped like ciphertext', async () => {
    const server = await serverPromise
    const host = `127.0.0.1:${server.port}`
    const { partyId, connection } = await createParty({ title: 'envelope', server: host, token: TOKEN })
    await connection.join('a')
    const post = async (text: string): Promise<number> =>
      (
        await fetch(`${server.url}/api/parties/${partyId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: 'a', to: '*', text }),
        })
      ).status

    expect(await post('hello, everyone!')).toBe(400) // a client that forgot to encrypt
    expect(await post('')).toBe(400)
    expect(await post('c2hvcnQ')).toBe(400) // base64url, but shorter than iv+tag
    expect(await post(await encryptText(generatePartyKey(), 'hello'))).toBe(200)
    await connection.close()
  })
})

/**
 * Owner rights on a tokenless server. They come from the socket's peer being loopback and from nothing else — the hole
 * this closes is a tokenless server reachable from outside (a forwarded port, `localhost` mapped to a LAN address),
 * where every stranger used to be the owner: party list with plaintext keys, writing as `host`, bulk delete.
 */
describe('owner rights without a token', () => {
  it('classifies peers by address, never by a header a client can write', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.11.22.33')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.7')).toBe(false)
    expect(isLoopbackAddress('::ffff:203.0.113.9')).toBe(false)
    expect(isLoopbackAddress('2a00:1450::1')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false) // no socket address ⇒ no owner rights
    expect(isLoopbackAddress('')).toBe(false)
  })

  it('a loopback request is the owner; a forged forwarding header changes nothing either way', async () => {
    const openDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-notoken-'))
    const open = await startServer({ dir: openDir })
    const spoofed = { 'x-forwarded-for': '203.0.113.9', forwarded: 'for=203.0.113.9' }

    expect((await fetch(`${open.url}/api/parties`)).status).toBe(200) // it's your machine
    expect((await fetch(`${open.url}/api/parties`, { headers: spoofed })).status).toBe(200)

    // …and on a tokenless server the header cannot grant anything either: a tokened one still wants the token.
    const guarded = await serverPromise
    expect((await fetch(`${guarded.url}/api/parties`, { headers: { 'x-forwarded-for': '127.0.0.1' } })).status).toBe(
      401,
    )
    await open.stop()
  })
})
