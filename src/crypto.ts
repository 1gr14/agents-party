import { Buffer } from 'node:buffer'
import { webcrypto } from 'node:crypto'

/**
 * End-to-end encryption for remote transports: AES-256-GCM via WebCrypto — built into Bun and Node 20+, zero
 * dependencies. The key travels only inside the party ref fragment (`#k=…`), so a public relay sees ciphertext only.
 */

const IV_BYTES = 12

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

const fromBase64Url = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64url'))

/** A fresh random 256-bit key, base64url — goes into the ref's `#k=` fragment. */
export const generateKey = (): string => toBase64Url(webcrypto.getRandomValues(new Uint8Array(32)))

const importKey = async (key: string): Promise<webcrypto.CryptoKey> => {
  const bytes = fromBase64Url(key)
  if (bytes.length !== 32) throw new Error('Invalid party key: expected 32 bytes base64url')
  return webcrypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Encrypt UTF-8 text → base64url(iv ‖ ciphertext). */
export const encryptText = async (key: string, plaintext: string): Promise<string> => {
  const cryptoKey = await importKey(key)
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    new TextEncoder().encode(plaintext),
  )
  const packed = new Uint8Array(IV_BYTES + ciphertext.byteLength)
  packed.set(iv, 0)
  packed.set(new Uint8Array(ciphertext), IV_BYTES)
  return toBase64Url(packed)
}

/**
 * Decrypt base64url(iv ‖ ciphertext) → text, or `null` when the blob is not ours (foreign message on the topic, wrong
 * key, tampering) — callers skip nulls silently.
 */
export const decryptText = async (key: string, blob: string): Promise<string | null> => {
  try {
    const packed = fromBase64Url(blob)
    if (packed.length <= IV_BYTES) return null
    const cryptoKey = await importKey(key)
    const plaintext = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: packed.slice(0, IV_BYTES) },
      cryptoKey,
      packed.slice(IV_BYTES),
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    return null
  }
}
