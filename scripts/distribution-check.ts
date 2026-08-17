#!/usr/bin/env bun
/**
 * distribution-check — where the skill is listed, and where it still isn't.
 *
 * Getting into a skill directory is not one action but a slow drip: some catalogs crawl GitHub on their own schedule,
 * some rank by install telemetry, some only move when a maintainer merges a pull request. So "did it land?" is a
 * question you ask repeatedly for weeks, and this script is the answer that doesn't rely on memory: run it, read the
 * table, act on the ❌ rows. The plan behind each row is in dev/docs/distribution.md.
 *
 * Only checks that can be trusted are automated: an HTTP status, a JSON API, a raw Markdown file we can grep. Catalogs
 * that render their listings in the browser would answer "not found" to a fetch even when we are listed, so they are
 * printed as links to open by hand instead of being reported as a fact.
 *
 *     bun run check:distribution
 */

const REPO = '1gr14/agents-party'
const PACKAGE = 'agents-party'
const MCP_NAME = 'io.github.1gr14/agents-party'
/** What a listing of ours looks like in someone else's Markdown. */
const NEEDLE = 'agents-party'

type Row = { label: string; listed: boolean; note: string }

const get = async (url: string, init?: RequestInit): Promise<Response | null> => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
  } catch {
    return null
  }
}

/**
 * A directory that lists us at a predictable URL: 200 means listed, 404 means not, anything else is unknown.
 *
 * For skills.sh this MUST stay the two-segment `/<owner>/<repo>` URL. It is the only path there that answers honestly —
 * an unknown repo 404s while `/anthropics/skills` returns 200. The tempting per-skill URL (`/<owner>/<repo>/<skill>`)
 * is served by an SPA catch-all that returns 200 for any nonsense you put in it, so checking it would paint this row
 * green forever.
 */
const checkUrl = async (label: string, url: string): Promise<Row> => {
  const response = await get(url, { method: 'GET' })
  if (response === null) return { label, listed: false, note: `unreachable — ${url}` }
  if (response.ok) return { label, listed: true, note: url }
  return { label, listed: false, note: response.status === 404 ? `not listed — ${url}` : `HTTP ${response.status}` }
}

/** An awesome list is plain Markdown in a repo: fetch the README of the default branch and look for our name. */
const checkList = async (repo: string, file = 'README.md'): Promise<Row> => {
  const url = `https://raw.githubusercontent.com/${repo}/HEAD/${file}`
  const response = await get(url)
  if (response === null || !response.ok) {
    return { label: repo, listed: false, note: `could not read ${file}` }
  }
  const text = await response.text()
  return {
    label: repo,
    listed: text.toLowerCase().includes(NEEDLE),
    note: `https://github.com/${repo}`,
  }
}

const checkMcpRegistry = async (): Promise<Row> => {
  const label = 'MCP registry'
  const url = `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(PACKAGE)}`
  const response = await get(url)
  if (response === null || !response.ok) return { label, listed: false, note: 'registry unreachable' }
  const body = (await response.json()) as { servers?: { server?: { name?: string; version?: string } }[] }
  const found = body.servers?.find((entry) => entry.server?.name === MCP_NAME)
  return {
    label,
    listed: found !== undefined,
    note:
      found === undefined
        ? `not published — mcp-publisher login github && mcp-publisher publish`
        : `${MCP_NAME} @ ${found.server?.version ?? '?'}`,
  }
}

const npmDownloads = async (): Promise<string> => {
  const response = await get(`https://api.npmjs.org/downloads/point/last-month/${PACKAGE}`)
  if (response === null || !response.ok) return '?'
  const body = (await response.json()) as { downloads?: number }
  return String(body.downloads ?? '?')
}

const githubStars = async (): Promise<string> => {
  const response = await get(`https://api.github.com/repos/${REPO}`)
  if (response === null || !response.ok) return '?'
  const body = (await response.json()) as { stargazers_count?: number }
  return String(body.stargazers_count ?? '?')
}

/** Catalogs that build their pages in the browser: a fetch cannot tell listed from not, so we only print where to look. */
const manual: [string, string][] = [
  ['skillsclaude.org', `https://skillsclaude.org/skills?q=${PACKAGE}`],
  ['claudemarketplaces.com', `https://claudemarketplaces.com/search?q=${PACKAGE}`],
  ['agentskill.club', 'https://www.agentskill.club/'],
  ['lobehub.com/skills', `https://lobehub.com/skills?q=${PACKAGE}`],
  ['GitHub topic', 'https://github.com/topics/claude-code-skills'],
]

const [downloads, stars, automatic, lists] = await Promise.all([
  npmDownloads(),
  githubStars(),
  Promise.all([checkUrl('skills.sh', `https://www.skills.sh/${REPO}`), checkMcpRegistry()]),
  Promise.all([
    checkList('hesreallyhim/awesome-claude-code'),
    checkList('ComposioHQ/awesome-claude-skills'),
    checkList('travisvn/awesome-claude-skills'),
    checkList('heilcheng/awesome-agent-skills'),
    checkList('punkpeye/awesome-mcp-servers'),
  ]),
])

const mark = (row: Row): string => `  ${row.listed ? '✅' : '❌'} ${row.label.padEnd(34)}${row.note}`

console.info(`\n${PACKAGE} — distribution check (${new Date().toISOString().slice(0, 10)})\n`)
console.info('Signals')
console.info(`     npm downloads, last 30 days     ${downloads}`)
console.info(`     GitHub stars                    ${stars}\n`)
console.info('Directories')
for (const row of automatic) console.info(mark(row))
console.info('\nAwesome lists (README grep)')
for (const row of lists) console.info(mark(row))
console.info('\nCheck by hand (these render in the browser)')
for (const [label, url] of manual) console.info(`     ${label.padEnd(34)}${url}`)
console.info('\nWhat each row means and what to do about it: dev/docs/distribution.md\n')
