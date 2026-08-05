import { describe, expect, it } from 'bun:test'
import { concernsParticipant, extractMentions } from './mentions.js'

describe('extractMentions', () => {
  it('collects each mentioned name once, in order', () => {
    expect(extractMentions('@auth ping @win-tests and @auth again')).toEqual(['auth', 'win-tests'])
  })

  it('finds nothing where there is nothing', () => {
    expect(extractMentions('an email@example.com is not a mention of nobody')).toEqual(['example.com'])
    expect(extractMentions('plain text')).toEqual([])
  })
})

describe('concernsParticipant', () => {
  const broadcast = (from: string, text = 'anyone there') => ({ from, to: '*' as const, text })

  it('ignores your own messages', () => {
    expect(concernsParticipant(broadcast('me'), 'me')).toBe(false)
  })

  it('takes an addressed message and a mention', () => {
    expect(concernsParticipant({ from: 'other', to: ['me'], text: 'this one' }, 'me')).toBe(true)
    expect(concernsParticipant(broadcast('other', 'hey @me'), 'me')).toBe(true)
  })

  it('leaves an ordinary broadcast alone', () => {
    expect(concernsParticipant(broadcast('other'), 'me')).toBe(false)
  })

  // The skill puts the host's word on a par with the agent's own human. A filter meaning "what concerns me" that
  // sleeps through the owner talking to the room contradicts that, and it is how a real party lost a real message.
  it('always takes the host, mention or no mention', () => {
    expect(concernsParticipant(broadcast('host', 'everyone, status?'), 'me')).toBe(true)
  })
})
