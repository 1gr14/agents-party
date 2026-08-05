import fs from 'node:fs'
import { dataDir, partiesDir, partyFilePath, registryPath } from './core/dirs.js'
import { errorFromCode } from './core/errors.js'
import { serverBaseUrl } from './core/refs.js'
import { createSqliteRegistry } from './registry/sqlite.js'
import { createStorePool } from './store/pool.js'

/**
 * `prune` cleans up parties. A party is data, not a process — nothing reaps old ones, so they pile up. Selection is
 * registry-driven: a party's activity is `lastMessageAt ?? createdAt`, and anything older than the cutoff (default 30
 * days) is a candidate; `--all` takes everything. Without `--yes` it is a dry run that only lists what would go.
 *
 * Local mode (default): a party is a registry row plus a `<dir>/parties/<id>.sqlite` file. Deleting one removes both
 * (and the SQLite -wal/-shm siblings). Files under `parties/` with no registry row are orphans — leaked garbage — and
 * are always listed and, with `--yes`, deleted too.
 *
 * Remote mode (`--server`): the same selection against a party server's registry (owner-authed). The dry run lists from
 * `GET /api/parties`; `--yes` calls the server's bulk `DELETE /api/parties?lastMessageBefore=…` so hundreds of parties
 * go in one request.
 */

export interface PruneOptions {
  dir?: string
  olderThan?: string
  all?: boolean
  yes?: boolean
}

export interface PruneRemoteOptions {
  server: string
  token?: string
  olderThan?: string
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

interface Candidate {
  id: string
  title: string
  ageMs: number
  sizeBytes: number
  messages: string
  orphaned: boolean
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

/** Orphans: `parties/<id>.sqlite` files with no registry row. Their id is the basename; age is the file mtime. */
const findOrphans = (dir: string, known: Set<string>, now: number): Candidate[] => {
  let names: string[]
  try {
    names = fs.readdirSync(partiesDir(dir)).filter((name) => name.endsWith('.sqlite'))
  } catch {
    return []
  }
  const orphans: Candidate[] = []
  for (const name of names) {
    const id = name.slice(0, -'.sqlite'.length)
    if (known.has(id)) continue
    let sizeBytes = 0
    let ageMs = 0
    try {
      const stat = fs.statSync(partyFilePath(id, dir))
      sizeBytes = stat.size
      ageMs = now - stat.mtimeMs
    } catch {
      continue
    }
    orphans.push({ id, title: '(orphaned)', ageMs, sizeBytes, messages: '?', orphaned: true })
  }
  return orphans
}

const renderDryRun = (selected: Candidate[]): string => {
  const totalSize = selected.reduce((sum, c) => sum + c.sizeBytes, 0)
  const header = ['ID', 'TITLE', 'AGE', 'SIZE', 'MSGS']
  const rows = selected.map((c) => [c.id, c.title, relativeAge(c.ageMs), humanSize(c.sizeBytes), c.messages])
  const orphanCount = selected.filter((c) => c.orphaned).length
  const lines = [
    column([header, ...rows]),
    '',
    `${selected.length} ${selected.length === 1 ? 'party' : 'parties'}, ${humanSize(totalSize)} total`,
  ]
  if (orphanCount > 0) {
    lines.push(`${orphanCount} orphaned ${orphanCount === 1 ? 'file' : 'files'} with no registry row`)
  }
  lines.push('Dry run — run again with --yes to delete.')
  return lines.join('\n')
}

/** Prune on a party server: same selection, over the owner's registry there. */
export const pruneRemote = async (options: PruneRemoteOptions): Promise<string> => {
  const baseUrl = serverBaseUrl(options.server)
  const headers = options.token === undefined ? undefined : { authorization: `Bearer ${options.token}` }
  const cutoffMs = options.olderThan === undefined ? DEFAULT_AGE_MS : parseDuration(options.olderThan)
  const now = Date.now()

  const request = async <T>(path: string, method = 'GET'): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, { method, ...(headers === undefined ? {} : { headers }) })
    const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string }
    if (!response.ok) {
      throw errorFromCode(body.code ?? 'BAD_REQUEST', body.message ?? `HTTP ${response.status} from ${options.server}`)
    }
    return body as T
  }

  if (options.yes !== true) {
    type WireMeta = {
      id: string
      title: string
      createdAt: number
      lastMessageAt: number | null
      messagesCount: number
      sizeBytes: number
    }
    const { parties } = await request<{ parties: WireMeta[] }>('/api/parties')
    const selected: Candidate[] = parties
      .filter((p) => options.all === true || now - (p.lastMessageAt ?? p.createdAt) >= cutoffMs)
      .map((p) => ({
        id: p.id,
        title: p.title,
        ageMs: now - (p.lastMessageAt ?? p.createdAt),
        sizeBytes: p.sizeBytes,
        messages: String(p.messagesCount),
        orphaned: false,
      }))
      .sort((a, b) => b.ageMs - a.ageMs)
    if (selected.length === 0) return 'Nothing to prune.'
    return renderDryRun(selected)
  }

  const query = options.all === true ? 'all=true' : `lastMessageBefore=${now - cutoffMs}`
  const result = await request<{ deleted: number; freedBytes: number }>(`/api/parties?${query}`, 'DELETE')
  if (result.deleted === 0) return 'Nothing to prune.'
  return `Deleted ${result.deleted} ${result.deleted === 1 ? 'party' : 'parties'}, freed ${humanSize(result.freedBytes)}.`
}

/**
 * Select local parties (registry rows past the cutoff, plus orphan files), then list them (dry run) or delete them
 * (`--yes`). Returns the text to print. Never throws for an empty selection — it returns "Nothing to prune." so the
 * caller can always exit 0.
 */
export const prune = async (options: PruneOptions): Promise<string> => {
  const dir = options.dir ?? dataDir()
  if (!fs.existsSync(dir)) return 'Nothing to prune.'

  const cutoffMs = options.olderThan === undefined ? DEFAULT_AGE_MS : parseDuration(options.olderThan)
  const now = Date.now()

  const registry = await createSqliteRegistry(registryPath(dir))
  let selected: Candidate[]
  try {
    const entries = await registry.list()
    const known = new Set(entries.map((e) => e.id))

    const fromRegistry: Candidate[] = entries
      .filter((e) => options.all === true || now - (e.lastMessageAt ?? e.createdAt) >= cutoffMs)
      .map((e) => ({
        id: e.id,
        title: e.title,
        ageMs: now - (e.lastMessageAt ?? e.createdAt),
        sizeBytes: e.sizeBytes,
        messages: String(e.messagesCount),
        orphaned: false,
      }))

    selected = [...fromRegistry, ...findOrphans(dir, known, now)]

    if (selected.length === 0) return 'Nothing to prune.'

    selected.sort((a, b) => b.ageMs - a.ageMs)
    const totalSize = selected.reduce((sum, c) => sum + c.sizeBytes, 0)

    if (options.yes !== true) return renderDryRun(selected)

    // Delete: registry row (if any) then the party's files (via the pool's remove, which also drops -wal/-shm).
    const pool = createStorePool(dir)
    try {
      for (const c of selected) {
        if (!c.orphaned) await registry.remove(c.id)
        await pool.remove(c.id)
      }
    } finally {
      await pool.closeAll()
    }

    return `Deleted ${selected.length} ${selected.length === 1 ? 'party' : 'parties'}, freed ${humanSize(totalSize)}.`
  } finally {
    await registry.close()
  }
}
