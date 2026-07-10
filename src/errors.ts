/**
 * Stable error codes — the canonical vocabulary shared by the transports and the relay HTTP API
 * (dev/docs/relay-api.md). Transports throw human messages with a `code` attached; `serve` maps codes onto HTTP
 * statuses; the relay client maps them back onto the same messages.
 */

export type TransportErrorCode =
  | 'INVALID_NAME'
  | 'INVALID_INVITE'
  | 'NOT_A_PARTICIPANT'
  | 'PARTY_NOT_FOUND'
  | 'NAME_TAKEN'
  | 'PARTY_CLOSED'
  | 'RATE_LIMITED'

export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TransportError'
  }
}

export const errorCode = (error: unknown): TransportErrorCode | undefined =>
  error instanceof TransportError ? error.code : undefined

/** The relay API's HTTP status for each code (dev/docs/relay-api.md). */
export const HTTP_STATUS: Record<TransportErrorCode, number> = {
  INVALID_NAME: 400,
  INVALID_INVITE: 403,
  NOT_A_PARTICIPANT: 403,
  PARTY_NOT_FOUND: 404,
  NAME_TAKEN: 409,
  PARTY_CLOSED: 410,
  RATE_LIMITED: 429,
}
