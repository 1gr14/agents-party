import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TransportError } from '../errors.js'
import { validateParticipantName } from '../names.js'
import { formatLocalRef } from '../refs.js'
import { isVisibleTo } from '../types.js'
import type { JoinOptions, Message, NewMessage, Participant, ReadOptions, Transport } from '../types.js'
import { openSqlite } from './sqlite-driver.js'
import type { SqliteDb } from './sqlite-driver.js'

/**
 * The local transport: one SQLite file is the whole party. Any process on the machine with the path can participate;
 * WAL mode keeps concurrent writers safe. Addressed messages are filtered inside the transport — a DM never leaves it
 * for a non-recipient.
 */

const rowToMessage = (row: Record<string, unknown>): Message => ({
  cursor: String(row.seq),
  id: String(row.id),
  ts: Number(row.ts),
  from: String(row.sender),
  // 'all' is the pre-0.2 spelling of '*' — old party files keep working.
  to: row.recipients === '*' || row.recipients === 'all' ? '*' : (JSON.parse(String(row.recipients)) as string[]),
  kind: row.kind as Message['kind'],
  text: String(row.text),
  ...(row.reply_to == null ? {} : { replyTo: String(row.reply_to) }),
  ...(Number(row.diff) === 0 ? {} : { diff: true }),
})

class LocalTransport implements Transport {
  readonly pollIntervalMs = 300

  constructor(private readonly db: SqliteDb) {}

  private insertMessage(msg: NewMessage): Promise<Message> {
    const id = randomUUID()
    const ts = Date.now()
    const recipients = msg.to === '*' ? '*' : JSON.stringify(msg.to)
    const result = this.db.run(
      'INSERT INTO messages (id, ts, sender, recipients, kind, text, reply_to, diff) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, ts, msg.from, recipients, msg.kind, msg.text, msg.replyTo ?? null, msg.diff === true ? 1 : 0],
    )
    return Promise.resolve({ ...msg, id, ts, cursor: String(result.lastInsertRowid) })
  }

  private isActive(name: string): boolean {
    const rows = this.db.all('SELECT name FROM participants WHERE name = ? AND left_ts IS NULL', [name])
    return rows.length > 0
  }

  private assertOpen(): void {
    const rows = this.db.all("SELECT 1 FROM messages WHERE kind = 'close' LIMIT 1")
    if (rows.length > 0) throw new TransportError('PARTY_CLOSED', 'This party is closed — no new messages or joins.')
  }

  async join(name: string, opts: JoinOptions = {}): Promise<Participant> {
    validateParticipantName(name)
    this.assertOpen()
    const now = Date.now()
    const result = this.db.run(
      `INSERT INTO participants (name, joined_ts, left_ts, desc) VALUES (?, ?, NULL, ?)
       ON CONFLICT(name) DO UPDATE SET joined_ts = excluded.joined_ts, left_ts = NULL, desc = excluded.desc
       WHERE participants.left_ts IS NOT NULL`,
      [name, now, opts.desc ?? null],
    )
    if (result.changes === 0) {
      throw new TransportError('NAME_TAKEN', `The name "${name}" is already taken at this party — pick another one.`)
    }
    await this.insertMessage({ from: name, to: '*', kind: 'join', text: `${name} joined` })
    return { name, joinedTs: now, ...(opts.desc === undefined ? {} : { desc: opts.desc }) }
  }

  async leave(name: string): Promise<void> {
    if (!this.isActive(name)) return
    await this.insertMessage({ from: name, to: '*', kind: 'leave', text: `${name} left` })
    this.db.run('UPDATE participants SET left_ts = ? WHERE name = ?', [Date.now(), name])
  }

  async send(msg: NewMessage): Promise<Message> {
    if (!this.isActive(msg.from)) {
      throw new TransportError('NOT_A_PARTICIPANT', `"${msg.from}" is not at this party — join first.`)
    }
    this.assertOpen()
    return this.insertMessage(msg)
  }

  async read(opts: ReadOptions): Promise<Message[]> {
    let sinceSeq = 0
    if (opts.since !== undefined) {
      sinceSeq = Number(opts.since)
      if (!Number.isFinite(sinceSeq)) throw new Error(`Invalid cursor: ${opts.since}`)
    }
    const rows = this.db.all('SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC', [sinceSeq])
    return rows.map(rowToMessage).filter((msg) => isVisibleTo(msg, opts.for))
  }

  participants(): Promise<Participant[]> {
    const rows = this.db.all('SELECT * FROM participants ORDER BY joined_ts ASC')
    return Promise.resolve(
      rows.map((row) => ({
        name: String(row.name),
        joinedTs: Number(row.joined_ts),
        ...(row.left_ts == null ? {} : { leftTs: Number(row.left_ts) }),
        ...(row.desc == null ? {} : { desc: String(row.desc) }),
      })),
    )
  }

  close(): Promise<void> {
    this.db.close()
    return Promise.resolve()
  }
}

export const createLocalTransport = async (filePath: string): Promise<Transport> => {
  return new LocalTransport(await openSqlite(filePath))
}

export const defaultPartyDir = (): string => process.env.AGENTS_PARTY_DIR ?? path.join(os.homedir(), '.agents-party')

/** Create a new local party file and return its ref. Does not join anyone. */
export const createLocalParty = async (
  opts: { name?: string; dir?: string } = {},
): Promise<{ ref: string; path: string }> => {
  const dir = opts.dir ?? defaultPartyDir()
  fs.mkdirSync(dir, { recursive: true })
  const slug = (opts.name ?? 'party').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  const filePath = path.join(dir, `${slug}-${randomBytes(3).toString('hex')}.sqlite`)
  const db = await openSqlite(filePath)
  db.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['name', opts.name ?? slug])
  db.run('INSERT INTO meta (key, value) VALUES (?, ?)', ['createdTs', String(Date.now())])
  db.close()
  return { ref: formatLocalRef(filePath), path: filePath }
}
