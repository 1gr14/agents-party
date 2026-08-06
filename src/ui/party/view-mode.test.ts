import { describe, expect, it } from 'bun:test'
import { isVisibleInView } from './view-mode.js'

const msg = (from: string, to: '*' | string[], text = 'hi', kind = 'message') => ({ from, to, text, kind })

describe('isVisibleInView', () => {
  it('all shows everything, mine included', () => {
    expect(isVisibleInView(msg('a', ['b']), 'all', 'host')).toBe(true)
    expect(isVisibleInView(msg('host', ['a']), 'all', 'host')).toBe(true)
  })

  describe('no-side-chats', () => {
    it('keeps broadcasts, even when they name someone else', () => {
      expect(isVisibleInView(msg('a', '*', 'ping @b'), 'no-side-chats', 'host')).toBe(true)
    })

    it('hides what two others addressed to each other', () => {
      expect(isVisibleInView(msg('a', ['b']), 'no-side-chats', 'host')).toBe(false)
    })

    it('keeps what is addressed to me, and what I sent', () => {
      expect(isVisibleInView(msg('a', ['host']), 'no-side-chats', 'host')).toBe(true)
      expect(isVisibleInView(msg('host', ['a']), 'no-side-chats', 'host')).toBe(true)
    })

    it('keeps joins and leaves — they are broadcast', () => {
      expect(isVisibleInView(msg('a', '*', '', 'join'), 'no-side-chats', 'host')).toBe(true)
    })
  })

  describe('for-me', () => {
    it('takes what is addressed to me or mentions me', () => {
      expect(isVisibleInView(msg('a', ['host']), 'for-me', 'host')).toBe(true)
      expect(isVisibleInView(msg('a', '*', 'ping @host'), 'for-me', 'host')).toBe(true)
    })

    it('drops broadcasts that do not name me, and what others say to each other', () => {
      expect(isVisibleInView(msg('a', '*', 'status: green'), 'for-me', 'host')).toBe(false)
      expect(isVisibleInView(msg('a', ['b']), 'for-me', 'host')).toBe(false)
      expect(isVisibleInView(msg('a', '*', 'ping @b'), 'for-me', 'host')).toBe(false)
    })

    it('drops every join and leave, my own included, and keeps my own messages', () => {
      expect(isVisibleInView(msg('a', '*', '', 'join'), 'for-me', 'host')).toBe(false)
      expect(isVisibleInView(msg('host', '*', '', 'join'), 'for-me', 'host')).toBe(false)
      expect(isVisibleInView(msg('host', '*', 'everyone: ship it'), 'for-me', 'host')).toBe(true)
    })
  })
})
