/**
 * `@name` mentions in message text. The charset mirrors participant-name rules, which is why `@` is forbidden inside
 * names.
 */

const MENTION_PATTERN = /@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu

/** Unique mentioned names, in order of first appearance. */
export const extractMentions = (text: string): string[] => {
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_PATTERN)) {
    seen.add(match[1])
  }
  return [...seen]
}

/** Whether a message concerns `name`: addressed directly or @-mentioned. */
export const concernsParticipant = (
  msg: { to: 'all' | string[]; text: string; from: string },
  name: string,
): boolean => {
  if (msg.from === name) return false
  if (msg.to !== 'all') return msg.to.includes(name)
  return extractMentions(msg.text).includes(name)
}
