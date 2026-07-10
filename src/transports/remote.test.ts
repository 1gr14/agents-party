import { afterAll, describe, expect, it } from 'bun:test'
import http from 'node:http'
import { parseRef } from '../refs.js'
import { createRemoteParty } from './remote.js'

/** A stub relay: just the create endpoint, scripted per test via the Bearer token it receives. */
const stub = http.createServer((req, res) => {
  const reply = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST' || req.url !== '/api/relay/parties') return reply(404, {})
  const auth = req.headers.authorization ?? ''
  if (auth === 'Bearer apt_good') return reply(200, { partyId: 'p1', inviteToken: 'inv1' })
  if (auth === 'Bearer apt_expired') return reply(403, { code: 'NO_ACCESS', message: 'no subscription', status: 403 })
  return reply(401, { code: 'INVALID_TOKEN', message: 'bad token', status: 401 })
})
await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
const address = stub.address()
const host = `127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
afterAll(() => stub.close())

describe('create --remote', () => {
  it('mints a hosted party and puts the client-side key and invite in the fragment', async () => {
    const { ref, partyId } = await createRemoteParty({ name: 'x', token: 'apt_good', host })
    expect(partyId).toBe('p1')
    const parsed = parseRef(ref)
    expect(parsed.scheme).toBe('party')
    if (parsed.scheme !== 'party') throw new Error('unreachable')
    expect(parsed.partyId).toBe('p1')
    expect(parsed.invite).toBe('inv1')
    expect(parsed.key).toBeTruthy() // generated client-side — the stub never saw it
    expect(parsed.baseUrl).toBe(`http://${host}`)
  })

  it('maps INVALID_TOKEN and NO_ACCESS onto actionable messages', async () => {
    await expect(createRemoteParty({ token: 'apt_bad', host })).rejects.toThrow('agents-party.com/settings')
    await expect(createRemoteParty({ token: 'apt_expired', host })).rejects.toThrow('subscription')
  })

  it('demands a token when neither the flag nor AGENTS_PARTY_TOKEN is set', async () => {
    const saved = process.env.AGENTS_PARTY_TOKEN
    delete process.env.AGENTS_PARTY_TOKEN
    try {
      await expect(createRemoteParty({ host })).rejects.toThrow('AGENTS_PARTY_TOKEN')
    } finally {
      if (saved !== undefined) process.env.AGENTS_PARTY_TOKEN = saved
    }
  })
})
