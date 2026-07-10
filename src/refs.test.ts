import { describe, expect, it } from 'bun:test'
import os from 'node:os'
import path from 'node:path'
import { formatLocalRef, formatNtfyRef, parseRef } from './refs.js'

describe('parseRef', () => {
  it('parses a local ref into an absolute path', () => {
    const parsed = parseRef('local:/tmp/party.sqlite')
    expect(parsed).toEqual({ scheme: 'local', path: '/tmp/party.sqlite' })
  })

  it('resolves relative local paths', () => {
    const parsed = parseRef('local:parties/demo.sqlite')
    if (parsed.scheme !== 'local') throw new Error('expected local')
    expect(path.isAbsolute(parsed.path)).toBe(true)
    expect(parsed.path.endsWith('/parties/demo.sqlite')).toBe(true)
  })

  it('expands ~ in local paths', () => {
    const parsed = parseRef('local:~/.agents-party/demo.sqlite')
    if (parsed.scheme !== 'local') throw new Error('expected local')
    expect(parsed.path).toBe(path.join(os.homedir(), '.agents-party/demo.sqlite'))
  })

  it('parses an ntfy ref', () => {
    const parsed = parseRef('ntfy:https://ntfy.sh/ap-abc123#k=SECRETKEY')
    expect(parsed).toEqual({
      scheme: 'ntfy',
      server: 'https://ntfy.sh',
      topic: 'ap-abc123',
      key: 'SECRETKEY',
    })
  })

  it('keeps a server base path when the ntfy server is not at the origin root', () => {
    const parsed = parseRef('ntfy:https://example.com/ntfy/ap-abc#k=K')
    expect(parsed).toEqual({
      scheme: 'ntfy',
      server: 'https://example.com/ntfy',
      topic: 'ap-abc',
      key: 'K',
    })
  })

  it('rejects unknown schemes, empty paths, and keyless ntfy refs', () => {
    expect(() => parseRef('carrier-pigeon:coop-7')).toThrow('Unknown party ref')
    expect(() => parseRef('no-scheme-at-all')).toThrow('Unknown party ref')
    expect(() => parseRef('local:')).toThrow('empty path')
    expect(() => parseRef('ntfy:https://ntfy.sh/ap-abc')).toThrow('missing #k=')
    expect(() => parseRef('ntfy:not a url')).toThrow('not a URL')
    expect(() => parseRef('ntfy:https://ntfy.sh/#k=K')).toThrow('no topic')
  })
})

describe('format ↔ parse round-trips', () => {
  it('local', () => {
    const ref = formatLocalRef('/tmp/x.sqlite')
    expect(parseRef(ref)).toEqual({ scheme: 'local', path: '/tmp/x.sqlite' })
  })

  it('ntfy (including trailing-slash servers)', () => {
    const ref = formatNtfyRef({ server: 'https://ntfy.sh/', topic: 'ap-1', key: 'K' })
    expect(ref).toBe('ntfy:https://ntfy.sh/ap-1#k=K')
    expect(parseRef(ref)).toEqual({ scheme: 'ntfy', server: 'https://ntfy.sh', topic: 'ap-1', key: 'K' })
  })
})
