import { describe, expect, it } from 'bun:test'
import { validateParticipantName } from './names.js'

describe('validateParticipantName', () => {
  it('accepts normal names', () => {
    for (const name of ['host', 'win-cursor', 'mac_2', 'agent.b', 'сергей', 'a', 'x'.repeat(32)]) {
      expect(() => validateParticipantName(name)).not.toThrow()
    }
  })

  it('rejects the broadcast sentinel in any case', () => {
    expect(() => validateParticipantName('all')).toThrow('reserved')
    expect(() => validateParticipantName('All')).toThrow('reserved')
  })

  it('rejects addressing metacharacters and malformed names', () => {
    for (const bad of ['*', 'a*b', 'a b', 'a,b', '@host', 'host@x', '', ' ', '-lead', '.lead', 'x'.repeat(33)]) {
      expect(() => validateParticipantName(bad)).toThrow('Invalid participant name')
    }
  })
})
