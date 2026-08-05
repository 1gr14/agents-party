import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createPartyMcpServer } from './mcp.js'
import type { McpDefaults } from './mcp.js'

/**
 * The MCP surface is tested end-to-end over the SDK's in-memory client/server pair — exactly how a real client talks to
 * it, no shortcuts into the tools. Local parties land in a throwaway AGENTS_PARTY_DIR so nothing touches the real
 * ~/.agents-party.
 */

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-mcp-'))
  process.env.AGENTS_PARTY_DIR = dir
})
afterAll(() => {
  delete process.env.AGENTS_PARTY_DIR
  fs.rmSync(dir, { recursive: true, force: true })
})

const startClient = async (defaults: McpDefaults = {}): Promise<Client> => {
  const server = createPartyMcpServer(defaults, '0.0.0-test')
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

const callText = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> => {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as { type: string; text: string }[]
  return { text: content[0]?.text ?? '', isError: result.isError === true }
}

const createLocalParty = async (client: Client): Promise<string> => {
  const created = await callText(client, 'party_create', {})
  expect(created.isError).toBe(false)
  const ref = /ref: (\S+)/.exec(created.text)?.[1]
  if (!ref) throw new Error(`no ref in: ${created.text}`)
  return ref
}

describe('mcp server', () => {
  it('exposes the v2 party toolset', async () => {
    const client = await startClient()
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'party_create',
      'party_invite',
      'party_join',
      'party_leave',
      'party_listen',
      'party_read',
      'party_send',
      'party_who',
    ])
    await client.close()
  })

  it('party_create returns a parseable local ref that carries the key', async () => {
    const client = await startClient()
    const created = await callText(client, 'party_create', { title: 'demo' })
    expect(created.isError).toBe(false)
    const ref = /ref: (\S+)/.exec(created.text)?.[1]
    expect(ref).toMatch(/^local:/)
    // The note must warn that the ref is the access — agents read this.
    expect(created.text).toContain('#k=')
    await client.close()
  })

  it('join → send → read round-trips the decrypted text', async () => {
    const client = await startClient()
    const ref = await createLocalParty(client)

    expect((await callText(client, 'party_join', { ref, as: 'host', desc: 'runs it' })).text).toBe('joined: host')
    expect((await callText(client, 'party_join', { ref, as: 'guest', desc: 'helps out' })).text).toBe('joined: guest')

    const sent = await callText(client, 'party_send', { ref, as: 'host', text: 'hello @guest', to: ['guest'] })
    expect(sent.isError).toBe(false)
    expect(JSON.parse(sent.text)).toMatchObject({ from: 'host', to: ['guest'], text: 'hello @guest' })

    // The stored body is ciphertext, but read() decrypts it back for a participant it is visible to.
    const read = await callText(client, 'party_read', { ref, as: 'guest' })
    expect(read.text).toContain('hello @guest')

    const who = await callText(client, 'party_who', { ref })
    expect(who.text).toContain('runs it')
    expect(who.text).toContain('helps out')
    await client.close()
  })

  it('party_send delivers to "*" and preserves a multiline patch verbatim', async () => {
    const client = await startClient()
    const ref = await createLocalParty(client)
    await callText(client, 'party_join', { ref, as: 'host' })
    const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n'
    const sent = await callText(client, 'party_send', { ref, as: 'host', text: patch, to: '*' })
    expect(sent.isError).toBe(false)
    expect(JSON.parse(sent.text)).toMatchObject({ to: '*', text: patch })
    await client.close()
  })

  it('party_listen returns TIMEOUT when nothing arrives', async () => {
    const client = await startClient()
    const ref = await createLocalParty(client)
    await callText(client, 'party_join', { ref, as: 'host' })
    const listened = await callText(client, 'party_listen', { ref, as: 'host', timeoutSec: 0.2 })
    expect(listened.text).toBe('TIMEOUT')
    await client.close()
  })

  it('party_invite returns a self-contained prompt containing the ref', async () => {
    const client = await startClient()
    const ref = await createLocalParty(client)
    const invite = await callText(client, 'party_invite', { ref, for: 'desktop-claude' })
    expect(invite.isError).toBe(false)
    expect(invite.text).toContain(ref)
    expect(invite.text).toContain('--as desktop-claude')
    await client.close()
  })

  it('party_invite --skill returns the one-line /party command', async () => {
    const client = await startClient()
    const ref = await createLocalParty(client)
    const invite = await callText(client, 'party_invite', { ref, for: 'desktop-claude', skill: true })
    expect(invite.text).toContain(`/party join '${ref}'`)
    expect(invite.text).toContain('--as desktop-claude')
    await client.close()
  })

  it('uses --ref/--as defaults from server start', async () => {
    const bootstrap = await startClient()
    const ref = await createLocalParty(bootstrap)
    await bootstrap.close()

    const client = await startClient({ ref, as: 'host' })
    expect((await callText(client, 'party_join', {})).text).toBe('joined: host')
    const sent = await callText(client, 'party_send', { text: 'no ref or name needed' })
    expect(sent.isError).toBe(false)
    const read = await callText(client, 'party_read', {})
    expect(read.text).toContain('no ref or name needed')
    await client.close()
  })

  it('missing ref yields a helpful tool error, not a crash', async () => {
    const client = await startClient()
    const result = await callText(client, 'party_send', { as: 'host', text: 'lost' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('missing "ref"')
    await client.close()
  })
})

describe('pinned deployments (hosted remote MCP)', () => {
  it('does not touch a foreign server at all — no request, no token', async () => {
    // A prompt-injected `server`/`ref` is attacker input to a process that serves strangers: it must not exfiltrate
    // the pinned account token, and must not make the HOST reach an address of the attacker's choosing.
    const seen: (string | null)[] = []
    const http = await import('node:http')
    const evil = http.createServer((req, res) => {
      seen.push(req.headers.authorization ?? null)
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 'BAD_REQUEST', message: 'nope', status: 400 }))
    })
    await new Promise<void>((resolve) => evil.listen(0, '127.0.0.1', resolve))
    const port = (evil.address() as { port: number }).port

    const client = await startClient({ server: 'pinned.example.com', token: 'apt_pinned_secret' })
    const created = await callText(client, 'party_create', { server: `127.0.0.1:${port}`, title: 'exfil' })
    expect(created.isError).toBe(true)
    expect(created.text).toContain('pinned to pinned.example.com')

    // The same fence on every tool that opens a connection — this is the SSRF one (an internal address as a ref).
    const read = await callText(client, 'party_read', { ref: `party:127.0.0.1:${port}/x#k=k`, as: 'a' })
    expect(read.isError).toBe(true)
    expect(read.text).toContain('pinned to pinned.example.com')

    expect(seen).toEqual([]) // nothing ever reached the foreign server
    expect(seen.every((auth) => auth === null || !auth.includes('apt_pinned_secret'))).toBe(true)
    await client.close()
    await new Promise<void>((resolve) => evil.close(() => resolve()))
  })

  it('refuses local: refs — a hosted MCP has no business opening files in its container', async () => {
    const client = await startClient({ server: 'pinned.example.com', token: 'apt_pinned_secret' })
    for (const tool of ['party_join', 'party_send', 'party_read', 'party_who', 'party_leave']) {
      const result = await callText(client, tool, {
        ref: 'local:11111111-2222-3333-4444-555555555555',
        as: 'a',
        text: 'x',
      })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('local: refs are not available here')
    }
    await client.close()
  })

  it('the pinned server itself stays reachable (the fence is not a wall)', async () => {
    // Unpinned, the same refs are the user's own machine and business — nothing is refused there.
    const client = await startClient()
    const ref = await createLocalParty(client)
    expect((await callText(client, 'party_join', { ref, as: 'a' })).isError).toBe(false)
    await client.close()
  })
})
