import { concernsParticipant } from './mentions.js'
import { parseRef } from './refs.js'
import { createTransport } from './transports/index.js'
import type { JoinOptions, Message, Participant, Recipients, Transport } from './types.js'

export interface ListenOptions {
  /** Cursor to start after; defaults to the current tail (only new messages). */
  since?: string
  /** Give up after this long and return `[]`. Default 10 minutes. */
  timeoutMs?: number
  /** Poll interval; defaults to the transport's own pace. */
  pollMs?: number
  /** Wake only on messages that concern me: addressed to me or @-mentioning me. */
  toMe?: boolean
}

const DEFAULT_LISTEN_TIMEOUT_MS = 600_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A participant's view of a party over any transport. Stateless by design — `connect` does not join; call `join()`
 * once, then any number of processes can `connect` with the same name and send/read/listen.
 */
export class PartyClient {
  constructor(
    readonly transport: Transport,
    readonly name: string,
    readonly ref: string,
  ) {}

  join(opts: JoinOptions = {}): Promise<Participant> {
    return this.transport.join(this.name, opts)
  }

  send(text: string, opts: { to?: Recipients; replyTo?: string; diff?: boolean } = {}): Promise<Message> {
    return this.transport.send({
      from: this.name,
      to: opts.to ?? '*',
      kind: 'message',
      text,
      ...(opts.replyTo === undefined ? {} : { replyTo: opts.replyTo }),
      ...(opts.diff === true ? { diff: true } : {}),
    })
  }

  /** Close the party for everyone: no new joins or messages after this. */
  endParty(): Promise<Message> {
    return this.transport.send({
      from: this.name,
      to: '*',
      kind: 'close',
      text: `party closed by ${this.name}`,
    })
  }

  /** Messages visible to me (broadcasts, messages addressed to me, my own). */
  read(opts: { since?: string } = {}): Promise<Message[]> {
    return this.transport.read({ for: this.name, since: opts.since })
  }

  who(): Promise<Participant[]> {
    return this.transport.participants()
  }

  leave(): Promise<void> {
    return this.transport.leave(this.name)
  }

  close(): Promise<void> {
    return this.transport.close()
  }

  /** Cursor of the latest message visible to me, or undefined on an empty party. */
  async tailCursor(): Promise<string | undefined> {
    const messages = await this.read()
    return messages.at(-1)?.cursor
  }

  /**
   * Block until someone else's message arrives (chat or join/leave), then return everything new. Returns `[]` on
   * timeout. Made for a background shell task: the agent sleeps here for free and wakes only on a real message.
   */
  async listen(opts: ListenOptions = {}): Promise<Message[]> {
    const pollMs = opts.pollMs ?? this.transport.pollIntervalMs
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_LISTEN_TIMEOUT_MS)
    let since = opts.since ?? (await this.tailCursor())
    while (Date.now() < deadline) {
      const messages = await this.read({ since })
      if (messages.length > 0) since = messages.at(-1)?.cursor
      const fresh = messages.filter((msg) => (opts.toMe ? concernsParticipant(msg, this.name) : msg.from !== this.name))
      if (fresh.length > 0) return fresh
      // Jitter keeps many listeners from hitting a shared relay in lockstep.
      await sleep(pollMs * (0.8 + Math.random() * 0.4))
    }
    return []
  }
}

/** Open a party by ref as a named participant. Does not join — see PartyClient. */
export const connect = async (ref: string, opts: { as: string }): Promise<PartyClient> => {
  if (!opts.as) throw new Error('A participant name is required (--as <name>).')
  const transport = await createTransport(parseRef(ref))
  return new PartyClient(transport, opts.as, ref)
}
