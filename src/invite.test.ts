import { describe, expect, it } from 'bun:test'
import { generateInvitePrompt } from './invite.js'

const NTFY_REF = 'ntfy:https://ntfy.sh/ap-abc123#k=SECRET'
const LOCAL_REF = 'local:/tmp/party-x.sqlite'

describe('generateInvitePrompt', () => {
  it('is self-contained: ref, name, and every command inline', () => {
    const prompt = generateInvitePrompt({ ref: NTFY_REF, guestName: 'win-cursor', from: 'host' })
    expect(prompt).toContain(NTFY_REF)
    expect(prompt).toContain('win-cursor')
    expect(prompt).toContain(`join '${NTFY_REF}' --as win-cursor`)
    expect(prompt).toContain(`listen '${NTFY_REF}' --as win-cursor`)
    expect(prompt).toContain(`leave '${NTFY_REF}' --as win-cursor`)
    expect(prompt).toContain('--to host')
  })

  it('quotes the ref for the shell', () => {
    const prompt = generateInvitePrompt({ ref: NTFY_REF, guestName: 'g' })
    expect(prompt).toContain(`'${NTFY_REF}'`)
  })

  it('warns about the E2E key for remote parties', () => {
    const prompt = generateInvitePrompt({ ref: NTFY_REF, guestName: 'g' })
    expect(prompt).toContain('encryption key')
    expect(prompt).toContain('any machine')
  })

  it('says same-machine for local parties', () => {
    const prompt = generateInvitePrompt({ ref: LOCAL_REF, guestName: 'g' })
    expect(prompt).toContain('same machine')
    expect(prompt).not.toContain('encryption key')
  })

  it('carries the listener behaviour contract', () => {
    const prompt = generateInvitePrompt({ ref: LOCAL_REF, guestName: 'g' })
    expect(prompt).toContain('run_in_background')
    expect(prompt).toContain('short summary')
    expect(prompt).toContain('Exit code 2')
  })

  it('rejects invalid refs early', () => {
    expect(() => generateInvitePrompt({ ref: 'nope', guestName: 'g' })).toThrow('Unknown party ref')
  })
})
