import { afterAll, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectParty, createParty } from '../client/connection.js'
import { openPartyStore } from '../store/store.js'
import { startServer } from './http.js'
import { createWakeHub } from './wake.js'

describe('wake hub', () => {
  it('wake resolves every pending wait for the party, and only that party', async () => {
    const hub = createWakeHub()
    const order: string[] = []
    const a1 = hub.wait('a', 5000).then(() => order.push('a1'))
    const a2 = hub.wait('a', 5000).then(() => order.push('a2'))
    const b = hub.wait('b', 200).then(() => order.push('b'))
    hub.wake('a')
    await Promise.all([a1, a2])
    expect(order.sort()).toEqual(['a1', 'a2'])
    await b // resolves by its own timeout, not by the foreign wake
    expect(order).toContain('b')
  })

  it('wait resolves on timeout when nobody wakes', async () => {
    const hub = createWakeHub()
    const started = Date.now()
    await hub.wait('quiet', 100)
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
  })

  it('wakeAll releases every party', async () => {
    const hub = createWakeHub()
    const waits = Promise.all([hub.wait('a', 5000), hub.wait('b', 5000)])
    hub.wakeAll()
    await waits
  })
})

describe('listen wakes without polling', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-wake-'))
  const serverPromise = startServer({ dir })
  afterAll(async () => {
    await (await serverPromise).stop()
  })

  it('a hanging /listen returns right after a write — far sooner than the fallback re-read', async () => {
    const server = await serverPromise
    const { ref, partyId, connection } = await createParty({ title: 'wake', server: `127.0.0.1:${server.port}` })
    await connection.join('speaker')
    const listener = await connectParty(ref)
    await listener.join('ear')
    const cursor = (await listener.read({ for: 'ear' })).at(-1)?.cursor

    const sentAt = Date.now() + 300
    setTimeout(() => void connection.send('speaker', 'ping'), 300)
    const messages = await fetch(
      `${server.url}/api/parties/${partyId}/listen?for=ear&since=${cursor}&timeoutSec=30`,
    ).then(async (r) => ((await r.json()) as { messages: unknown[] }).messages)
    const elapsedAfterSend = Date.now() - sentAt

    expect(messages).toHaveLength(1)
    expect(elapsedAfterSend).toBeLessThan(1000) // woken by the hub; the fallback never had to fire
    await connection.close()
    await listener.close()
  })

  it('a write landing outside the server process is picked up by the fallback re-read', async () => {
    const server = await serverPromise
    const { ref, partyId, connection } = await createParty({ title: 'direct', server: `127.0.0.1:${server.port}` })
    await connection.join('writer')
    const listener = await connectParty(ref)
    await listener.join('ear')
    const cursor = (await listener.read({ for: 'ear' })).at(-1)?.cursor

    // A local-protocol client writes the party file directly — the server's hub never hears about it.
    const direct = await openPartyStore(path.join(dir, 'parties', `${partyId}.sqlite`))
    setTimeout(() => void direct.append({ from: 'writer', to: '*', kind: 'message', text: 'raw' }), 200)
    const started = Date.now()
    const messages = await fetch(
      `${server.url}/api/parties/${partyId}/listen?for=ear&since=${cursor}&timeoutSec=30`,
    ).then(async (r) => ((await r.json()) as { messages: unknown[] }).messages)

    expect(messages).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(2500) // the standalone server's 1s fallback caught it
    await direct.close()
    await connection.close()
    await listener.close()
  })

  it('a client listen survives a server restart: the socket drops, the retry reconnects and delivers', async () => {
    const restartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-restart-'))
    const first = await startServer({ dir: restartDir })
    const { ref, connection } = await createParty({ title: 'restart', server: `127.0.0.1:${first.port}` })
    await connection.join('speaker')
    const listener = await connectParty(ref)
    await listener.join('ear')
    const cursor = (await listener.read({ for: 'ear' })).at(-1)?.cursor

    const wait = listener.listen('ear', { since: cursor, timeoutMs: 20_000 })
    await new Promise((resolve) => setTimeout(resolve, 300)) // let the long-poll park on the first server
    await first.stop() // kills the socket under the parked listen
    const second = await startServer({ dir: restartDir, port: first.port })
    const speaker = await connectParty(ref)
    // The process's fetch pool may hold a stale keep-alive socket to the dead server — one resend covers it,
    // exactly like a CLI/agent re-running the errored command.
    await speaker.send('speaker', 'back online').catch(async () => await speaker.send('speaker', 'back online'))

    const messages = await wait
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toBe('back online')
    await speaker.close()
    await listener.close()
    await connection.close()
    await second.stop()
  })

  it('deleting a party fails parked listens fast with PARTY_NOT_FOUND', async () => {
    const server = await serverPromise
    const { ref, partyId, connection } = await createParty({ title: 'doomed', server: `127.0.0.1:${server.port}` })
    await connection.join('a')
    const listener = await connectParty(ref)
    await listener.join('ear')
    const cursor = (await listener.read({ for: 'ear' })).at(-1)?.cursor

    const parked = fetch(`${server.url}/api/parties/${partyId}/listen?for=ear&since=${cursor}&timeoutSec=30`)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const started = Date.now()
    await fetch(`${server.url}/api/parties/${partyId}`, { method: 'DELETE' })
    const response = await parked
    expect(Date.now() - started).toBeLessThan(1500)
    expect(response.status).toBe(404)
    expect(((await response.json()) as { code: string }).code).toBe('PARTY_NOT_FOUND')
    await connection.close()
  }, 20_000)
})
