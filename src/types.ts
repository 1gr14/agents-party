/**
 * Core model: a party is one shared channel; participants are unique names inside it; messages flow through a pluggable
 * Transport.
 */

export type MessageKind = 'message' | 'join' | 'leave' | 'close'

/** Who a message is for: everyone, or specific participant names. */
export type Recipients = 'all' | string[]

export interface Message {
  /**
   * Opaque transport-scoped cursor — pass it as `since` to read only newer messages. Local transport uses the SQLite
   * rowid, ntfy uses its message id; never parse it, only pass it back.
   */
  cursor: string
  /** Globally unique message id (UUID). */
  id: string
  /** Epoch milliseconds. */
  ts: number
  from: string
  to: Recipients
  kind: MessageKind
  text: string
  /** Id of the message this one replies to. */
  replyTo?: string
}

export interface NewMessage {
  from: string
  to: Recipients
  kind: MessageKind
  text: string
  replyTo?: string
}

export interface Participant {
  name: string
  /** Epoch milliseconds of the (latest) join. */
  joinedTs: number
  /** Set when the participant left; absent while active. */
  leftTs?: number
  /** Free-form role in the party ("reviews the diffs"), set at join. */
  desc?: string
}

export interface JoinOptions {
  desc?: string
}

export interface ReadOptions {
  /** Whose view — only messages this participant may see are returned. */
  for: string
  /** Opaque cursor of the last seen message; omit for the full history. */
  since?: string
}

/**
 * The transport contract — deliberately minimal and pull-based, the lowest common denominator every channel (SQLite
 * file, ntfy topic, future relays) can implement. Adding a transport = implement this, register a ref scheme, pass the
 * shared contract test suite.
 */
export interface Transport {
  /** Register a participant. Rejects a name that is already active. */
  join(name: string, opts?: JoinOptions): Promise<Participant>
  leave(name: string): Promise<void>
  /** Rejects senders that never joined (or already left) and closed parties. */
  send(msg: NewMessage): Promise<Message>
  read(opts: ReadOptions): Promise<Message[]>
  participants(): Promise<Participant[]>
  close(): Promise<void>
  /**
   * How often `listen` should poll this transport, in milliseconds. A local file can be polled aggressively; a public
   * relay should be polled gently.
   */
  pollIntervalMs: number
}

/**
 * Visibility rule shared by all transports: broadcasts are for everyone, addressed messages are for their recipients —
 * and the sender always sees their own messages (a readable transcript).
 */
export const isVisibleTo = (msg: Pick<Message, 'from' | 'to'>, name: string): boolean => {
  if (msg.from === name) return true
  if (msg.to === 'all') return true
  return msg.to.includes(name)
}
