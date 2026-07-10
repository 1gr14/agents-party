import { afterAll, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServe } from './serve.js'
import type { ServeHandle } from './serve.js'
import { describeTransportContract } from './testing/contract.js'
import { createLocalParty } from './transports/local.js'
import { createRelayTransport } from './transports/relay.js'

/**
 * `serve` is tested as a pair with RelayTransport: the same client the web UI and `party:` refs use runs the full
 * transport contract against a serve instance bridging a local file — exactly the wiring of the universal web client.
 */

// Isolate token caches (relay-tokens.json, serve-tokens.json) and party files from the developer's ~/.agents-party.
process.env.AGENTS_PARTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-serve-test-'))

const handles: ServeHandle[] = []
afterAll(async () => {
  await Promise.all(handles.map((handle) => handle.stop()))
})

const makeParty = async () => {
  const { path: filePath } = await createLocalParty({ name: 'serve-suite' })
  const handle = await startServe({ path: filePath })
  handles.push(handle)
  const host = `127.0.0.1:${handle.port}`
  return {
    handle,
    host,
    connectAs: (_name: string) =>
      Promise.resolve(
        createRelayTransport({
          baseUrl: `http://${host}`,
          host,
          partyId: handle.partyId,
          invite: handle.inviteToken,
        }),
      ),
  }
}

describeTransportContract('serve (via RelayTransport)', makeParty)

describe('serve specifics', () => {
  it('answers the CORS preflight with private-network approval', async () => {
    const party = await makeParty()
    const response = await fetch(`http://${party.host}/api/relay/parties/${party.handle.partyId}/messages`, {
      method: 'OPTIONS',
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-private-network')).toBe('true')
    expect(response.headers.get('access-control-allow-headers')).toContain('x-participant-token')
  })

  it('spells "everyone" as all on the wire and maps error codes to statuses', async () => {
    const party = await makeParty()
    const t = await party.connectAs('a')
    await t.join('a')
    await t.send({ from: 'a', to: '*', kind: 'message', text: 'hi' })

    const tokens = JSON.parse(
      fs.readFileSync(path.join(process.env.AGENTS_PARTY_DIR ?? '', 'serve-tokens.json'), 'utf8'),
    ) as Record<string, string>
    const token =
      Object.entries(tokens).find(([key]) => key.includes(party.handle.partyId) && key.endsWith('#a'))?.[1] ?? ''
    const base = `http://${party.host}/api/relay/parties/${party.handle.partyId}`

    const raw = await fetch(`${base}/messages`, { headers: { 'x-participant-token': token } })
    const { messages } = (await raw.json()) as { messages: { kind: string; to: unknown }[] }
    expect(messages.find((m) => m.kind === 'message')?.to).toBe('all')

    const bad = await fetch(`${base}/messages`, { headers: { 'x-participant-token': 'nope' } })
    expect(bad.status).toBe(403)
    expect(((await bad.json()) as { code: string }).code).toBe('NOT_A_PARTICIPANT')
    await t.close()
  })

  it('serves broadcasts to an invite-token viewer, and 410s after close', async () => {
    const party = await makeParty()
    const t = await party.connectAs('a')
    await t.join('a')
    await t.send({ from: 'a', to: '*', kind: 'message', text: 'public' })
    await t.send({ from: 'a', to: ['a'], kind: 'message', text: 'to self' })

    const base = `http://${party.host}/api/relay/parties/${party.handle.partyId}`
    const view = await fetch(`${base}/messages`, { headers: { 'x-invite-token': party.handle.inviteToken } })
    const { messages } = (await view.json()) as { messages: { text: string }[] }
    expect(messages.map((m) => m.text)).toContain('public')
    expect(messages.map((m) => m.text)).not.toContain('to self')

    await t.send({ from: 'a', to: '*', kind: 'close', text: 'a closed the party' })
    const late = await party.connectAs('b')
    await expect(late.join('b')).rejects.toThrow('closed')
    await t.close()
    await late.close()
  })

  it('keeps identities across a serve restart (persisted tokens)', async () => {
    const { path: filePath } = await createLocalParty({ name: 'serve-restart' })
    const first = await startServe({ path: filePath })
    const host1 = `127.0.0.1:${first.port}`
    const t1 = createRelayTransport({
      baseUrl: `http://${host1}`,
      host: host1,
      partyId: first.partyId,
      invite: first.inviteToken,
    })
    await t1.join('sergei')
    await first.stop()

    const second = await startServe({ path: filePath, port: first.port })
    handles.push(second)
    const t2 = createRelayTransport({
      baseUrl: `http://${host1}`,
      host: host1,
      partyId: second.partyId,
      invite: second.inviteToken,
    })
    // The cached participant token from the first run still speaks as the same name.
    const msg = await t2.send({ from: 'sergei', to: '*', kind: 'message', text: 'still me' })
    expect(msg.from).toBe('sergei')
    await t1.close()
    await t2.close()
  })
})
