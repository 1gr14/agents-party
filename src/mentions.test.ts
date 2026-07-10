import { describe, expect, it } from 'bun:test'
import { concernsParticipant, extractMentions } from './mentions.js'

describe('extractMentions', () => {
  it('finds unique mentions in order', () => {
    expect(extractMentions('hey @host and @win-cursor, @host again')).toEqual(['host', 'win-cursor'])
  })

  it('handles unicode names and punctuation borders', () => {
    expect(extractMentions('привет, @сергей! и @agent.b:')).toEqual(['сергей', 'agent.b'])
  })

  it('returns [] when nothing is mentioned', () => {
    expect(extractMentions('plain text, email@example.com is not a mention start')).toEqual(['example.com'])
    expect(extractMentions('no ats here')).toEqual([])
  })
})

describe('concernsParticipant', () => {
  it('matches direct addressing', () => {
    expect(concernsParticipant({ from: 'a', to: ['b'], text: 'hi' }, 'b')).toBe(true)
    expect(concernsParticipant({ from: 'a', to: ['b'], text: 'hi' }, 'c')).toBe(false)
  })

  it('matches @-mentions in broadcasts', () => {
    expect(concernsParticipant({ from: 'a', to: '*', text: 'ping @b' }, 'b')).toBe(true)
    expect(concernsParticipant({ from: 'a', to: '*', text: 'general chatter' }, 'b')).toBe(false)
  })

  it('never matches own messages', () => {
    expect(concernsParticipant({ from: 'b', to: '*', text: 'note to self @b' }, 'b')).toBe(false)
  })
})
