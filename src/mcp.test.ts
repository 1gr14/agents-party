import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createPartyMcpServer } from './mcp.js'
import type { McpDefaults } from './mcp.js'

const makeTmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-mcp-'))

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

describe('mcp server', () => {
  it('exposes the full party toolset', async () => {
    const client = await startClient()
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'party_close',
      'party_create',
      'party_export',
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

  it('create → join → send → read → who round-trip', async () => {
    const client = await startClient()
    const created = await callText(client, 'party_create', {
      name: 'mcp-demo',
      dir: makeTmpDir(),
      desc: 'runs the party',
    })
    expect(created.isError).toBe(false)
    const ref = /ref: (\S+)/.exec(created.text)?.[1]
    if (!ref) throw new Error(`no ref in: ${created.text}`)

    expect((await callText(client, 'party_join', { ref, as: 'guest', desc: 'helps out' })).text).toBe('joined: guest')

    const sent = await callText(client, 'party_send', { ref, as: 'host', text: 'hello @guest', to: ['guest'] })
    expect(sent.isError).toBe(false)
    expect(JSON.parse(sent.text)).toMatchObject({ from: 'host', to: ['guest'], text: 'hello @guest' })

    const read = await callText(client, 'party_read', { ref, as: 'guest' })
    expect(read.text).toContain('hello @guest')

    const who = await callText(client, 'party_who', { ref })
    expect(who.text).toContain('runs the party')
    expect(who.text).toContain('helps out')
    await client.close()
  })

  it('listen returns TIMEOUT when nothing arrives', async () => {
    const client = await startClient()
    const created = await callText(client, 'party_create', { dir: makeTmpDir() })
    const ref = /ref: (\S+)/.exec(created.text)?.[1]
    const listened = await callText(client, 'party_listen', { ref, as: 'host', timeoutSec: 0.2 })
    expect(listened.text).toBe('TIMEOUT')
    await client.close()
  })

  it('uses --ref/--as defaults from server start', async () => {
    const dir = makeTmpDir()
    const bootstrap = await startClient()
    const created = await callText(bootstrap, 'party_create', { dir })
    const ref = /ref: (\S+)/.exec(created.text)?.[1]
    await bootstrap.close()

    const client = await startClient({ ref, as: 'host' })
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

  it('invite tool returns the self-contained prompt', async () => {
    const client = await startClient()
    const created = await callText(client, 'party_create', { dir: makeTmpDir() })
    const ref = /ref: (\S+)/.exec(created.text)?.[1]
    const invite = await callText(client, 'party_invite', { ref, guestName: 'desktop-claude' })
    expect(invite.text).toContain(`'${ref}'`)
    expect(invite.text).toContain('--as desktop-claude')
    await client.close()
  })
})
