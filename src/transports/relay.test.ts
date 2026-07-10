import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKey } from '../crypto.js'
import { formatPartyRef, parseRef } from '../refs.js'
import { describeTransportContract } from '../testing/contract.js'
import { createRelayTransport } from './relay.js'

/**
 * Relay transport tests run against a live relay (the agents-party site) — point AGENTS_PARTY_RELAY_TEST_URL at one
 * (e.g. http://localhost:8000) that exposes the dev-only create endpoint. Without the env var the whole file is a
 * no-op, so CI stays green without a site checkout.
 */
const RELAY_URL = process.env.AGENTS_PARTY_RELAY_TEST_URL

// Isolate the participant-token cache from the developer's real ~/.agents-party.
process.env.AGENTS_PARTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-relay-test-'))

const createDevParty = async (relayUrl: string): Promise<{ partyId: string; inviteToken: string }> => {
  const response = await fetch(`${relayUrl}/api/relay/dev/parties`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'contract-suite' }),
  })
  if (!response.ok) {
    throw new Error(`dev party create failed: HTTP ${response.status} — is the site dev server running?`)
  }
  return (await response.json()) as { partyId: string; inviteToken: string }
}

if (RELAY_URL) {
  const host = new URL(RELAY_URL).host

  const makeParty = async () => {
    const { partyId, inviteToken } = await createDevParty(RELAY_URL)
    const ref = formatPartyRef({ host, partyId, key: generateKey(), invite: inviteToken })
    const parsed = parseRef(ref)
    if (parsed.scheme !== 'party') throw new Error('unreachable')
    return {
      connectAs: (_name: string) => Promise.resolve(createRelayTransport(parsed)),
      parsed,
    }
  }

  describeTransportContract('relay', makeParty)

  describe('relay transport specifics', () => {
    it('stores only ciphertext on the relay for e2e parties', async () => {
      const party = await makeParty()
      const t = await party.connectAs('a')
      await t.join('a')
      await t.send({ from: 'a', to: '*', kind: 'message', text: 'secret plans' })

      // Fetch the raw wire without decrypting: same endpoint, raw fetch.
      const tokens = JSON.parse(
        fs.readFileSync(path.join(process.env.AGENTS_PARTY_DIR ?? '', 'relay-tokens.json'), 'utf8'),
      ) as Record<string, string>
      const token = tokens[`${party.parsed.host}/${party.parsed.partyId}#a`]
      const response = await fetch(`${RELAY_URL}/api/relay/parties/${party.parsed.partyId}/messages`, {
        headers: { 'x-participant-token': token },
      })
      const { messages } = (await response.json()) as { messages: { kind: string; text: string }[] }
      const chat = messages.find((m) => m.kind === 'message')
      expect(chat).toBeDefined()
      expect(chat?.text).not.toContain('secret plans')

      // …while the transport read decrypts it back.
      const readBack = await t.read({ for: 'a' })
      expect(readBack.find((m) => m.kind === 'message')?.text).toBe('secret plans')
      await t.close()
    })

    it('who works before joining, via the invite token', async () => {
      const party = await makeParty()
      const host = await party.connectAs('host')
      await host.join('host')
      const observer = await party.connectAs('never-joined')
      const participants = await observer.participants()
      expect(participants.map((p) => p.name)).toContain('host')
      await host.close()
      await observer.close()
    })

    it('join without an invite token fails with a clear message', async () => {
      const party = await makeParty()
      const bare = createRelayTransport({ ...party.parsed, invite: undefined })
      await expect(bare.join('x')).rejects.toThrow('invite token')
    })
  })
}

describe('party refs', () => {
  it('round-trips host, id, key and invite through the fragment', () => {
    const ref = formatPartyRef({ host: 'agents-party.com', partyId: 'abc123', key: 'KEY', invite: 'INV' })
    expect(ref).toBe('party:agents-party.com/abc123#k=KEY&i=INV')
    const parsed = parseRef(ref)
    expect(parsed).toEqual({
      scheme: 'party',
      baseUrl: 'https://agents-party.com',
      host: 'agents-party.com',
      partyId: 'abc123',
      key: 'KEY',
      invite: 'INV',
    })
  })

  it('speaks http to localhost and https to everything else', () => {
    const local = parseRef('party:localhost:8000/id1')
    expect(local.scheme === 'party' && local.baseUrl).toBe('http://localhost:8000')
    const prod = parseRef('party:agents-party.com/id1')
    expect(prod.scheme === 'party' && prod.baseUrl).toBe('https://agents-party.com')
  })

  it('key and invite are optional (no-e2e parties, already-joined refs)', () => {
    const parsed = parseRef('party:agents-party.com/id1')
    expect(parsed.scheme === 'party' && parsed.key).toBeUndefined()
    expect(parsed.scheme === 'party' && parsed.invite).toBeUndefined()
  })

  it('rejects malformed party refs', () => {
    expect(() => parseRef('party:no-slash')).toThrow('Invalid party ref')
    expect(() => parseRef('party:host/')).toThrow('Invalid party ref')
  })
})
