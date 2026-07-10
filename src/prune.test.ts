import { describe, expect, it } from 'bun:test'
import { parseDuration } from './prune.js'

describe('parseDuration', () => {
  it('reads a bare number as days', () => {
    expect(parseDuration('30')).toBe(30 * 86_400_000)
    expect(parseDuration('1.5')).toBe(1.5 * 86_400_000)
  })

  it('reads suffixed durations', () => {
    expect(parseDuration('7d')).toBe(7 * 86_400_000)
    expect(parseDuration('24h')).toBe(24 * 3_600_000)
    expect(parseDuration('30m')).toBe(30 * 60_000)
    expect(parseDuration('45s')).toBe(45 * 1_000)
    expect(parseDuration('2w')).toBe(2 * 7 * 86_400_000)
  })

  it('is case- and space-insensitive', () => {
    expect(parseDuration(' 12H ')).toBe(12 * 3_600_000)
  })

  it('throws on garbage', () => {
    expect(() => parseDuration('soon')).toThrow('Invalid duration')
    expect(() => parseDuration('7x')).toThrow('Invalid duration')
    expect(() => parseDuration('')).toThrow('Invalid duration')
  })
})
