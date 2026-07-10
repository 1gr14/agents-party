import { describe, expect, it } from 'bun:test'
import { decryptText, encryptText, generateKey } from './crypto.js'

describe('crypto', () => {
  it('round-trips text', async () => {
    const key = generateKey()
    const blob = await encryptText(key, 'привет, party! 🎉')
    expect(await decryptText(key, blob)).toBe('привет, party! 🎉')
  })

  it('produces a different blob every time (fresh IV)', async () => {
    const key = generateKey()
    expect(await encryptText(key, 'same')).not.toBe(await encryptText(key, 'same'))
  })

  it('generates distinct 32-byte base64url keys', () => {
    const key = generateKey()
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateKey()).not.toBe(key)
  })

  it('returns null for a wrong key', async () => {
    const blob = await encryptText(generateKey(), 'secret')
    expect(await decryptText(generateKey(), blob)).toBeNull()
  })

  it('returns null for tampered ciphertext', async () => {
    const key = generateKey()
    const blob = await encryptText(key, 'secret')
    const tampered = blob.slice(0, -2) + (blob.endsWith('aa') ? 'bb' : 'aa')
    expect(await decryptText(key, tampered)).toBeNull()
  })

  it('returns null for garbage blobs', async () => {
    const key = generateKey()
    expect(await decryptText(key, 'not base64url at all!!!')).toBeNull()
    expect(await decryptText(key, '')).toBeNull()
    expect(await decryptText(key, 'AAAA')).toBeNull()
  })

  it('rejects malformed keys on encrypt', async () => {
    await expect(encryptText('short', 'x')).rejects.toThrow('32 bytes')
  })
})
