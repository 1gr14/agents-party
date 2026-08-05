/**
 * `@name` mentions in (decrypted) message text. The charset mirrors participant-name rules, which is why `@` is
 * forbidden inside names. Mentions are a client-side concern by design: servers only ever see ciphertext.
 */

import { HOST_NAME } from './names.js'

const MENTION_PATTERN = /@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu

/** Unique mentioned names, in order of first appearance. */
export const extractMentions = (text: string): string[] => {
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_PATTERN)) {
    seen.add(match[1])
  }
  return [...seen]
}

/**
 * Whether a message concerns `name`: addressed directly, @-mentioned, or spoken by the host.
 *
 * The host is the party's human owner, and the skill puts their word on a par with an agent's own human, so a filter
 * that means "what concerns me" has to let them through, mention or no mention. Without this the two contradict each
 * other: the owner writes to the room and every agent watching with `--to-me` sleeps through it.
 */
export const concernsParticipant = (msg: { to: '*' | string[]; text: string; from: string }, name: string): boolean => {
  if (msg.from === name) return false
  if (msg.from === HOST_NAME) return true
  if (msg.to !== '*') return msg.to.includes(name)
  return extractMentions(msg.text).includes(name)
}
