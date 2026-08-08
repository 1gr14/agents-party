import { joinBriefing } from './invite.js'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-cli-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * Run the CLI in a fresh process with the data dir isolated via AGENTS_PARTY_DIR. Async Bun.spawn (not spawnSync): a
 * synchronous spawn with a stdin buffer loses stdin on Linux, and long-running commands (listen) need to be awaited.
 */
const cli = async (...args: string[]): Promise<CliResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...args],
    env: { ...process.env, AGENTS_PARTY_DIR: dir },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

/** Like `cli`, but feeds `input` on stdin — for testing that piped text (patches) is sent verbatim. */
const cliStdin = async (input: string, ...args: string[]): Promise<CliResult> => {
  // A real pipe, written and closed, is what a shell redirect looks like to the child. Handing Bun.spawn a Blob
  // instead delivered nothing to the child on Linux (it worked on macOS and Windows), so the CLI read an empty stdin.
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI, ...args],
    env: { ...process.env, AGENTS_PARTY_DIR: dir },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc.stdin.write(input)
  await proc.stdin.end()
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

/** create auto-joins the caller as `organizer` and prints the local ref — return it. */
const createParty = async (): Promise<string> => {
  const created = await cli('create', '--title', 'demo')
  expect(created.code).toBe(0)
  const ref = /ref:\s+(\S+)/.exec(created.stdout)?.[1]
  if (!ref) throw new Error(`no ref in output: ${created.stdout}`)
  return ref
}

describe('cli', () => {
  it('help prints usage and lists commands, exits 0', async () => {
    const result = await cli('help')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('party line for AI agents')
    expect(result.stdout).toContain('Usage:')
    expect(result.stdout).toContain('agents-party create')
    expect(result.stdout).toContain('agents-party join')
    expect(result.stdout).toContain('Exit codes')
  })

  it('create prints a local ref and an invite hint', async () => {
    const created = await cli('create', '--title', 'demo')
    expect(created.code).toBe(0)
    expect(created.stdout).toContain('ref:    local:')
    expect(created.stdout).toContain('joined: organizer')
    expect(created.stdout).toContain('invite:')
  })

  it('join → send → read round-trip shows plaintext to the recipient', async () => {
    const ref = await createParty()
    expect((await cli('join', ref, '--as', 'guest')).code).toBe(0)

    const sent = await cli('send', ref, '--as', 'organizer', '--to', 'guest', 'hello guest')
    expect(sent.code).toBe(0)
    expect(sent.stdout).toContain('→ guest')

    const read = await cli('read', ref, '--as', 'guest')
    expect(read.code).toBe(0)
    expect(read.stdout).toContain('hello guest')

    const who = await cli('who', ref)
    expect(who.stdout).toContain('organizer\tactive')
    expect(who.stdout).toContain('guest\tactive')
  }, 20_000)

  it('send pipes multiline stdin verbatim — a patch survives byte-exact', async () => {
    const ref = await createParty()
    const patch = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n line2\n'
    const sent = await cliStdin(patch, 'send', ref, '--as', 'organizer')
    // stderr first: a bare exit-code assertion tells you nothing about WHY the CLI refused
    expect(sent.stderr).toBe('')
    expect(sent.code).toBe(0)

    const read = await cliStdin('', 'read', ref, '--as', 'organizer', '--json')
    expect(read.code).toBe(0)
    const line = read.stdout
      .trim()
      .split('\n')
      .find((l) => l.includes('"kind":"message"'))
    expect(line).toBeDefined()
    expect((JSON.parse(line!) as { text: string }).text).toBe(patch)
  }, 20_000)

  it('--to addressing is invisible to a third participant', async () => {
    const ref = await createParty()
    await cli('join', ref, '--as', 'guest')
    await cli('join', ref, '--as', 'other')
    await cli('send', ref, '--as', 'organizer', '--to', 'guest', 'secret')
    expect((await cli('read', ref, '--as', 'other')).stdout).not.toContain('secret')
    expect((await cli('read', ref, '--as', 'guest')).stdout).toContain('secret')
  })

  it('listen exits 2 on timeout when nothing arrives', async () => {
    const ref = await createParty()
    const result = await cli('listen', ref, '--as', 'organizer', '--timeout', '1')
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
  })

  it('--to-me keeps waiting through a broadcast instead of reporting a timeout', async () => {
    const ref = await createParty()
    expect((await cli('join', ref, '--as', 'guest')).code).toBe(0)

    // Two messages while one listener waits: a broadcast naming nobody, then one addressed to it. Exit 2 on the
    // broadcast would say the party was silent, which is a lie the agent acts on — it reads 2 as "timed out",
    // re-arms, gets 2 again, and gives up on a party that is in fact busy.
    const waiting = cli('listen', ref, '--as', 'organizer', '--to-me', '--timeout', '10')
    await new Promise((resolve) => setTimeout(resolve, 400))
    await cli('send', ref, '--as', 'guest', 'for everyone, nobody in particular')
    await new Promise((resolve) => setTimeout(resolve, 400))
    await cli('send', ref, '--as', 'guest', '--to', 'organizer', 'this one is yours')

    const result = await waiting
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('this one is yours')
    expect(result.stdout).not.toContain('nobody in particular')
  }, 15_000)

  it('listen without --since waits for the next message, it does not replay the backlog', async () => {
    const ref = await createParty()
    expect((await cli('join', ref, '--as', 'guest')).code).toBe(0)
    await cli('send', ref, '--as', 'guest', 'old news')

    const waiting = cli('listen', ref, '--as', 'organizer', '--timeout', '10')
    await new Promise((resolve) => setTimeout(resolve, 400))
    await cli('send', ref, '--as', 'guest', 'the new thing')

    const result = await waiting
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('the new thing')
    expect(result.stdout).not.toContain('old news')
  }, 15_000)

  it('invite prints a short prompt with the ref, the join command and a human hint', async () => {
    const ref = await createParty()
    const result = await cli('invite', ref, '--for', 'win-agent', '--desc', 'runs windows tests')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(ref)
    expect(result.stdout).toContain('--as win-agent')
    expect(result.stdout).toContain('A human instead of an agent?') // local ref → the local web viewer hint
    // Short on purpose: the working contract belongs to `join`, not to a wall of text a human has to paste.
    expect(result.stdout).not.toContain('listen')
    expect(result.stdout.split('\n').length).toBeLessThan(12)
    const remote = await cli('invite', 'party:example.com/11111111-2222-3333-4444-555555555555#k=abc')
    expect(remote.stdout).toContain('https://example.com/join/11111111-2222-3333-4444-555555555555#k=abc')
  })

  it('the briefing tells a launcher-run guest to install once, and leaves an installed one alone', () => {
    // A party spends most of its life re-arming listen, and every npx command re-resolves @latest against the registry.
    const npx = joinBriefing({ ref: 'local:abc', name: 'win-tests', runner: 'npx agents-party@latest' })
    expect(npx).toContain('npm i -g agents-party@latest')
    expect(npx).toContain('resolved again on every command')

    const bunx = joinBriefing({ ref: 'local:abc', name: 'win-tests', runner: 'bunx agents-party@latest' })
    expect(bunx).toContain('bun add -g agents-party@latest')

    // Already on the installed binary: nothing to advise.
    expect(joinBriefing({ ref: 'local:abc', name: 'win-tests', runner: 'agents-party' })).not.toContain(
      '-g agents-party',
    )
  })

  it('the plain invite is the default: no name pinned, one text for any number of guests', async () => {
    const ref = await createParty()

    const plain = await cli('invite', ref)
    expect(plain.code).toBe(0)
    expect(plain.stdout).toContain('--as <your-name>')
    expect(plain.stdout).toContain('Pick a short name for yourself')

    // Pinning a name is the exception, and it drops the naming instruction.
    const pinned = await cli('invite', ref, '--for', 'win-tests')
    expect(pinned.stdout).toContain('--as win-tests')
    expect(pinned.stdout).not.toContain('Pick a short name for yourself')
  })

  it('join prints the working contract, and --json keeps it machine-readable', async () => {
    const ref = await createParty()
    const joined = await cli('join', ref, '--as', 'reviewer', '--desc', 'reviews the diffs')
    expect(joined.code).toBe(0)
    expect(joined.stdout).toContain('joined: reviewer')
    expect(joined.stdout).toContain('listen') // the loop
    expect(joined.stdout).toContain('--since <cursor>') // re-arming with the cursor
    expect(joined.stdout).toContain('"host" is the party') // who may be trusted
    const json = await cli('join', ref, '--as', 'reviewer-2', '--json')
    expect(JSON.parse(json.stdout.trim())).toMatchObject({ name: 'reviewer-2' })
  })

  it('read takes the latest --limit messages and pages older with --before', async () => {
    const ref = await createParty()
    await cli('join', ref, '--as', 'a')
    for (const text of ['one', 'two', 'three']) await cli('send', ref, '--as', 'a', text)
    const latest = await cli('read', ref, '--as', 'a', '--limit', '2', '--json')
    const tail = latest.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { text: string; cursor: string })
    expect(tail.map((message) => message.text)).toEqual(['two', 'three'])
    const older = await cli('read', ref, '--as', 'a', '--before', tail[0]!.cursor, '--limit', '1', '--json')
    expect((JSON.parse(older.stdout.trim()) as { text: string }).text).toBe('one')
    const bad = await cli('read', ref, '--as', 'a', '--limit', '0')
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('--limit expects a positive integer')
  })

  it('invite --skill prints the one-line /party command', async () => {
    const ref = await createParty()
    const result = await cli('invite', ref, '--for', 'reviewer', '--desc', 'reviews the plan', '--skill')
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(`/party join '${ref}' --as reviewer --desc "reviews the plan"`)
  })

  it('delete --yes removes the party; a later command fails with exit 1', async () => {
    const ref = await createParty()
    const deleted = await cli('delete', ref, '--yes')
    expect(deleted.code).toBe(0)
    expect(deleted.stdout).toContain('deleted:')

    const who = await cli('who', ref)
    expect(who.code).toBe(1)
    expect(who.stderr).toContain('agents-party:')
  })

  it('unknown command exits 1', async () => {
    const result = await cli('dance')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('unknown command')
  })
})
