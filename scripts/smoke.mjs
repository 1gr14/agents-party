// Post-build smoke test: verifies the published artifact loads under plain Node
// and that the package "exports" map resolves. SQLite-dependent paths run only
// where a driver exists (Node 22.5+); the rest must work everywhere (Node 20+).
import { spawnSync } from 'node:child_process'
import { formatNtfyRef, generateInvitePrompt, generateKey, isVisibleTo, parseRef } from '../dist/index.js'

const assert = (cond, msg) => {
  if (!cond) {
    console.error('smoke test failed:', msg)
    process.exit(1)
  }
}

// Pure surface — every supported Node.
const ref = formatNtfyRef({ server: 'https://ntfy.sh', topic: 'ap-smoke', key: generateKey() })
const parsed = parseRef(ref)
assert(parsed.scheme === 'ntfy' && parsed.topic === 'ap-smoke', 'ntfy ref should round-trip')
assert(parseRef('local:/tmp/party.sqlite').path === '/tmp/party.sqlite', 'local ref should round-trip')
assert(isVisibleTo({ from: 'a', to: ['b'] }, 'b') === true, 'visibility rule should hold')
assert(
  generateInvitePrompt({ ref, guestName: 'smokey' }).includes(`'${ref}'`),
  'invite prompt should carry the quoted ref',
)

// The CLI bin must print help under plain Node.
const help = spawnSync(process.execPath, ['dist/cli.js', 'help'], { encoding: 'utf8' })
assert(help.status === 0, `cli help should exit 0 (got ${help.status}: ${help.stderr})`)
assert(help.stdout.includes('agents-party'), 'cli help should print usage')

// SQLite round-trip — only where node:sqlite exists.
const hasSqlite = await import('node:sqlite').then(
  () => true,
  () => false,
)
if (hasSqlite) {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { connect, createLocalParty } = await import('../dist/index.js')
  const { ref: localRef } = await createLocalParty({
    dir: mkdtempSync(join(tmpdir(), 'agents-party-smoke-')),
  })
  const host = await connect(localRef, { as: 'host' })
  await host.join()
  await host.send('smoke says hi')
  const messages = await host.read()
  assert(
    messages.some((m) => m.text === 'smoke says hi'),
    'local party round-trip should work',
  )
  await host.close()
  console.log('smoke ok (with sqlite round-trip)')
} else {
  console.log('smoke ok (no node:sqlite on this Node — pure surface only)')
}
