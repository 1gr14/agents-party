import fs from 'node:fs'
import path from 'node:path'
import { defaultPartyDir } from './transports/local.js'
import { openSqliteReadonly } from './transports/sqlite-driver.js'

/**
 * `prune` cleans up local party files (the SQLite files in the agents-party dir). A party file is data, not a process —
 * nothing reaps old ones, so they pile up. Selection is by file mtime and/or whether the party was closed; without
 * `--yes` it is a dry run that just lists what would go. Only `*.sqlite` files directly in the dir are ever touched.
 */

export interface PruneOptions {
  dir?: string
  olderThan?: string
  closed?: boolean
  all?: boolean
  yes?: boolean
}

const DAY_MS = 86_400_000
const DEFAULT_AGE_MS = 30 * DAY_MS

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: DAY_MS,
  w: 7 * DAY_MS,
}

/** Parse a duration like `7d`, `24h`, `30m`; a bare number is days. Returns milliseconds. */
export const parseDuration = (input: string): number => {
  const match = /^(\d+(?:\.\d+)?)\s*([smhdw]?)$/i.exec(input.trim())
  if (!match) {
    throw new Error(`Invalid duration "${input}" — use e.g. 7d, 24h, 30m, or a plain number of days.`)
  }
  const unit = match[2] === '' ? 'd' : match[2]!.toLowerCase()
  return Number(match[1]) * UNIT_MS[unit]!
}

const humanSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

const relativeAge = (ageMs: number): string => {
  if (ageMs < 60_000) return 'just now'
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`
  if (ageMs < DAY_MS) return `${Math.floor(ageMs / 3_600_000)}h ago`
  return `${Math.floor(ageMs / DAY_MS)}d ago`
}

interface PartyInfo {
  closed: boolean
  participants: number
  title?: string
}

const inspect = async (filePath: string): Promise<PartyInfo> => {
  try {
    const db = await openSqliteReadonly(filePath)
    try {
      const closed = db.all("SELECT 1 FROM messages WHERE kind = 'close' LIMIT 1").length > 0
      const participants = Number(db.all('SELECT COUNT(*) AS n FROM participants')[0]?.n ?? 0)
      const title = db.all("SELECT value FROM meta WHERE key = 'name' LIMIT 1")[0]?.value
      return { closed, participants, ...(title == null ? {} : { title: String(title) }) }
    } finally {
      db.close()
    }
  } catch {
    // A file we can't open as a party (corrupt, foreign, mid-write) still counts by mtime/size — just no metadata.
    return { closed: false, participants: 0 }
  }
}

interface Candidate {
  name: string
  filePath: string
  ageMs: number
  size: number
  info: PartyInfo
}

const column = (rows: string[][]): string => {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)))
  return rows
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i]!))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

/**
 * Select local party files, then either list them (dry run) or delete them (`--yes`). Returns the text to print. Never
 * throws for an empty selection — it returns a "Nothing to prune." line so the caller can always exit 0.
 */
export const prune = async (options: PruneOptions): Promise<string> => {
  const dir = options.dir ?? defaultPartyDir()

  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.sqlite'))
  } catch {
    return 'Nothing to prune.'
  }

  // Age filter is on unless only --closed was asked for; --older-than always turns it on. --all drops the age
  // filter but still honors --closed — `prune --all --closed` means "every closed party", not "everything".
  const cutoffMs = options.olderThan === undefined ? DEFAULT_AGE_MS : parseDuration(options.olderThan)
  const useAge = !options.all && (options.olderThan !== undefined || !options.closed)
  const now = Date.now()

  const selected: Candidate[] = []
  for (const name of names) {
    const filePath = path.join(dir, name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    const ageMs = now - stat.mtimeMs

    if (useAge && ageMs < cutoffMs) continue
    const info = await inspect(filePath)
    if (options.closed && !info.closed) continue

    selected.push({ name, filePath, ageMs, size: stat.size, info })
  }

  if (selected.length === 0) return 'Nothing to prune.'

  selected.sort((a, b) => b.ageMs - a.ageMs)
  const totalSize = selected.reduce((sum, c) => sum + c.size, 0)

  if (!options.yes) {
    const header = ['FILE', 'TITLE', 'MTIME', 'SIZE', 'CLOSED', 'WHO']
    const rows = selected.map((c) => [
      c.name,
      c.info.title ?? '',
      relativeAge(c.ageMs),
      humanSize(c.size),
      c.info.closed ? 'closed' : 'open',
      String(c.info.participants),
    ])
    const table = column([header, ...rows])
    return [
      table,
      '',
      `${selected.length} ${selected.length === 1 ? 'party' : 'parties'}, ${humanSize(totalSize)} total`,
      'Dry run — run again with --yes to delete.',
    ].join('\n')
  }

  for (const c of selected) {
    fs.rmSync(c.filePath, { force: true })
    // SQLite WAL leaves these siblings behind; a stale -wal/-shm without its .sqlite is just garbage.
    for (const sibling of [`${c.filePath}-wal`, `${c.filePath}-shm`]) {
      fs.rmSync(sibling, { force: true })
    }
  }

  return `Deleted ${selected.length} ${selected.length === 1 ? 'party' : 'parties'}, freed ${humanSize(totalSize)}.`
}
