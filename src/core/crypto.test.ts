import { describe, expect, it } from 'bun:test'
import {
  decryptText,
  deriveMasterKeyPair,
  encryptText,
  generateMasterSalt,
  generatePartyKey,
  looksLikeCiphertext,
  seal,
  unseal,
} from './crypto.js'

describe('message encryption (party key)', () => {
  it('round-trips text', async () => {
    const key = generatePartyKey()
    const blob = await encryptText(key, 'héllo, 世界, 🎉')
    expect(blob).not.toContain('héllo')
    expect(await decryptText(key, blob)).toBe('héllo, 世界, 🎉')
  })

  it('returns null on a wrong key or tampered blob (GCM doubles as the key check)', async () => {
    const blob = await encryptText(generatePartyKey(), 'secret')
    expect(await decryptText(generatePartyKey(), blob)).toBeNull()
    expect(await decryptText(generatePartyKey(), 'not-a-blob')).toBeNull()
  })

  it('every key is unique and 32 bytes', () => {
    expect(generatePartyKey()).not.toBe(generatePartyKey())
    expect(Buffer.from(generatePartyKey(), 'base64url').length).toBe(32)
  })

  it('the envelope check accepts what encryptText produces and rejects what obviously is not it', async () => {
    const key = generatePartyKey()
    expect(looksLikeCiphertext(await encryptText(key, ''))).toBe(true) // even an empty message is iv+tag
    expect(looksLikeCiphertext(await encryptText(key, 'a longer message, still base64url'))).toBe(true)

    expect(looksLikeCiphertext('')).toBe(false)
    expect(looksLikeCiphertext('hello, everyone!')).toBe(false) // spaces, comma, bang — not base64url
    expect(looksLikeCiphertext('c2hvcnQ')).toBe(false) // base64url, but below iv[12]+tag[16]
    expect(looksLikeCiphertext('aGVsbG8gdGhlcmU=')).toBe(false) // padded base64 is not our format
    // Honest about what it is NOT: random base64url of the right length sails through — only the key can judge.
    expect(looksLikeCiphertext('A'.repeat(38))).toBe(true)
  })
})

describe('master key pair + sealing', () => {
  // KDF is deliberately slow (600k PBKDF2 iterations) — derive once, reuse across specs.
  const salt = generateMasterSalt()
  const pairPromise = deriveMasterKeyPair('correct horse battery staple', salt)

  it('derivation is deterministic for the same password+salt', async () => {
    const again = await deriveMasterKeyPair('correct horse battery staple', salt)
    expect((await pairPromise).publicKey).toBe(again.publicKey)
    expect((await pairPromise).privateKey).toBe(again.privateKey)
  }, 20_000)

  it('a different password or salt gives a different pair', async () => {
    const otherPassword = await deriveMasterKeyPair('wrong horse', salt)
    const otherSalt = await deriveMasterKeyPair('correct horse battery staple', generateMasterSalt())
    expect(otherPassword.publicKey).not.toBe((await pairPromise).publicKey)
    expect(otherSalt.publicKey).not.toBe((await pairPromise).publicKey)
  }, 30_000)

  it('seal with the public key, unseal with the private key', async () => {
    const pair = await pairPromise
    const partyKey = generatePartyKey()
    const wrapped = await seal(pair.publicKey, partyKey)
    expect(wrapped).not.toContain(partyKey)
    expect(await unseal(pair.privateKey, wrapped)).toBe(partyKey)
  })

  it('sealing twice gives different blobs (ephemeral keys), both unseal', async () => {
    const pair = await pairPromise
    const a = await seal(pair.publicKey, 'x')
    const b = await seal(pair.publicKey, 'x')
    expect(a).not.toBe(b)
    expect(await unseal(pair.privateKey, a)).toBe('x')
    expect(await unseal(pair.privateKey, b)).toBe('x')
  })

  it('unseal returns null for the wrong private key or garbage', async () => {
    const pair = await pairPromise
    const stranger = await deriveMasterKeyPair('stranger', generateMasterSalt())
    const wrapped = await seal(pair.publicKey, 'secret')
    expect(await unseal(stranger.privateKey, wrapped)).toBeNull()
    expect(await unseal(pair.privateKey, 'garbage')).toBeNull()
  }, 20_000)
})

describe('fixed vectors — pin the wire formats for other implementations (the site mirrors them in WebCrypto)', () => {
  // Any change that breaks these bricks every stored keyWrapped and every stored message. Do NOT regenerate casually.
  const PASSWORD = 'correct horse battery staple'
  const SALT = 'AAAAAAAAAAAAAAAAAAAAAA' // 16 zero bytes, base64url
  const PUBLIC_KEY = 'xvyL00w9bsy5R4cw8iS5SQhAAjpLtG5YK9xjd6EFRjM'
  const PRIVATE_KEY = 'BGDu7H3fi1-R8gN7PiqySPfF2I2-yrtQpCaeUY8ZSM0'
  const PARTY_KEY = 'kBmVIRcfg0lmRJLU4b3-1JbNL0amiE0jr7worjjqLBQ'
  const SEALED =
    'zZ8I1YWA9Fy3rNKt3Gu1rw_NIeW1nBalZhXu_5Mz5kmqQMya1bb6gUKXiIRlhIUDnY2mU7oqNMEXd6-UA7h6UvFKyZj3lePBR0vOe3yZOMQUWFkgpH-sQGNI3Wbe3HnNH3ZFR4lzMg'
  const MESSAGE_BLOB = '6wr2U-dp5Uv0Ps0OjwuXdLib3FczkgRaZ1pbczxuN5qa6WWXcWH3ffBJhjLbVDlTyagMHWuDe-4I6khS'

  it('PBKDF2(password, salt) → the exact X25519 pair', async () => {
    const pair = await deriveMasterKeyPair(PASSWORD, SALT)
    expect(pair.publicKey).toBe(PUBLIC_KEY)
    expect(pair.privateKey).toBe(PRIVATE_KEY)
  }, 20_000)

  it('a historical sealed blob unseals with the derived private key', async () => {
    expect(await unseal(PRIVATE_KEY, SEALED)).toBe(PARTY_KEY)
  })

  // The plaintext is what this exact blob has always decrypted to. It is a historical artefact, not a sample string:
  // rewriting it to match house style would mean regenerating the blob, which is the one thing this test forbids.
  it('a historical message blob decrypts with the party key', async () => {
    expect(await decryptText(PARTY_KEY, MESSAGE_BLOB)).toBe('привет, вечеринка')
  })
})
