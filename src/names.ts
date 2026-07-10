/**
 * Participant name rules, shared by every transport. Names are addressing targets, so the charset must stay
 * unambiguous: no `*` (the "everyone" selector), no `,` (the `--to` list separator), no `@` (reserved for mentions), no
 * whitespace. `all` is the wire-level broadcast sentinel.
 */

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,31}$/u

const RESERVED = new Set(['all'])

export const validateParticipantName = (name: string): void => {
  if (RESERVED.has(name.toLowerCase())) {
    throw new Error(`The name "${name}" is reserved — pick another one.`)
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid participant name "${name}" — use 1-32 letters, digits, dots, dashes or underscores (no spaces, *, @ or commas).`,
    )
  }
}
