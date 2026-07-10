import { describe, expect, it } from 'bun:test'
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

const cli = (...args: string[]): CliResult => {
  const result = Bun.spawnSync({ cmd: [process.execPath, CLI, ...args] })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

const makeTmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-cli-'))

const createParty = (dir: string): string => {
  const created = cli('create', '--name', 'demo', '--dir', dir)
  expect(created.code).toBe(0)
  const ref = /ref:\s+(\S+)/.exec(created.stdout)?.[1]
  if (!ref) throw new Error(`no ref in output: ${created.stdout}`)
  return ref
}

describe('cli', () => {
  it('help prints usage and exits 0', () => {
    const result = cli('help')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('party line for AI agents')
    expect(result.stdout).toContain('Exit codes')
  })

  it('create → join → send → read round-trip', () => {
    const dir = makeTmpDir()
    const ref = createParty(dir)

    expect(cli('join', ref, '--as', 'guest').code).toBe(0)

    const sent = cli('send', ref, '--as', 'host', '--to', 'guest', 'hello guest')
    expect(sent.code).toBe(0)
    expect(sent.stdout).toContain('→ guest')

    const read = cli('read', ref, '--as', 'guest', '--json')
    expect(read.code).toBe(0)
    const messages = read.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { text: string; from: string; kind: string })
    const chat = messages.filter((m) => m.kind === 'message')
    expect(chat).toEqual([{ ...chat[0], from: 'host', text: 'hello guest' }])

    const who = cli('who', ref)
    expect(who.stdout).toContain('host\tactive')
    expect(who.stdout).toContain('guest\tactive')
  })

  it('DMs stay invisible to non-recipients', () => {
    const dir = makeTmpDir()
    const ref = createParty(dir)
    cli('join', ref, '--as', 'guest')
    cli('join', ref, '--as', 'other')
    cli('send', ref, '--as', 'host', '--to', 'guest', 'secret')
    expect(cli('read', ref, '--as', 'other').stdout).not.toContain('secret')
    expect(cli('read', ref, '--as', 'guest').stdout).toContain('secret')
  })

  it('listen exits 2 on timeout when nothing arrives', () => {
    const dir = makeTmpDir()
    const ref = createParty(dir)
    cli('join', ref, '--as', 'guest')
    const result = cli('listen', ref, '--as', 'guest', '--timeout', '0.3')
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
  })

  it('listen wakes when a message for me lands', async () => {
    const dir = makeTmpDir()
    const ref = createParty(dir)
    cli('join', ref, '--as', 'guest')

    const listener = Bun.spawn({
      cmd: [process.execPath, CLI, 'listen', ref, '--as', 'guest', '--timeout', '10', '--json'],
      stdout: 'pipe',
    })
    await Bun.sleep(400)
    expect(cli('send', ref, '--as', 'host', 'are you there?').code).toBe(0)
    expect(await listener.exited).toBe(0)
    const output = await new Response(listener.stdout).text()
    expect(JSON.parse(output.trim())).toMatchObject({ from: 'host', text: 'are you there?' })
  })

  it('invite prints a self-contained prompt', () => {
    const dir = makeTmpDir()
    const ref = createParty(dir)
    const result = cli('invite', ref, '--for', 'win-agent', '--desc', 'runs windows tests')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`'${ref}'`)
    expect(result.stdout).toContain('--as win-agent')
    expect(result.stdout).toContain('--desc "runs windows tests"')
  })

  it('invite without --for tells the guest to pick a name', () => {
    const dir = makeTmpDir()
    const ref = createParty(dir)
    const result = cli('invite', ref)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('pick one yourself')
    expect(result.stdout).toContain('<your-name>')
  })

  it('invite --skill prints the one-line /party command', () => {
    const dir = makeTmpDir()
    const ref = createParty(dir)
    const result = cli('invite', ref, '--for', 'reviewer', '--desc', 'reviews the plan', '--skill')
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(`/party join '${ref}' --as reviewer --desc "reviews the plan"`)
  })

  it('create --remote points at --ntfy until the hosted relay ships', () => {
    const result = cli('create', '--remote')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('agents-party.com')
    expect(result.stderr).toContain('--ntfy')
  })

  it('send --diff marks the message and keeps the patch verbatim', () => {
    const dir = makeTmpDir()
    const ref = createParty(dir)
    cli('join', ref, '--as', 'reviewer')
    const patch = '--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-old\n+new\n'
    const sent = Bun.spawnSync({
      cmd: [process.execPath, CLI, 'send', ref, '--as', 'reviewer', '--diff', '--json'],
      stdin: Buffer.from(patch),
    })
    expect(sent.exitCode).toBe(0)
    expect(JSON.parse(sent.stdout.toString()) as object).toMatchObject({ diff: true, text: patch })

    const read = cli('read', ref, '--as', 'host')
    expect(read.stdout).toContain('[diff]')
    const exported = cli('export', ref, '--as', 'host')
    expect(exported.stdout).toContain('sent a diff:')
    expect(exported.stdout).toContain('```diff')
  })

  it('desc shows up in who; reply-to lands in the message', () => {
    const dir = makeTmpDir()
    const ref = createParty(dir)
    cli('join', ref, '--as', 'guest', '--desc', 'reviews diffs')
    expect(cli('who', ref).stdout).toContain('reviews diffs')

    const sent = cli('send', ref, '--as', 'host', '--json', 'question')
    const sentMsg = JSON.parse(sent.stdout) as { id: string }
    cli('send', ref, '--as', 'guest', '--reply-to', sentMsg.id, 'answer')
    const read = cli('read', ref, '--as', 'host', '--json')
    const answer = read.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { text: string; replyTo?: string })
      .find((m) => m.text === 'answer')
    expect(answer?.replyTo).toBe(sentMsg.id)
  })

  it('close freezes the party; export prints the transcript', () => {
    const dir = makeTmpDir()
    const ref = createParty(dir)
    cli('join', ref, '--as', 'guest', '--desc', 'helper')
    cli('send', ref, '--as', 'host', 'wrap it up')
    const closed = cli('close', ref, '--as', 'host')
    expect(closed.code).toBe(0)
    const late = cli('send', ref, '--as', 'guest', 'am I late?')
    expect(late.code).toBe(1)
    expect(late.stderr).toContain('closed')

    const exported = cli('export', ref, '--as', 'host')
    expect(exported.code).toBe(0)
    expect(exported.stdout).toContain('# agents-party transcript')
    expect(exported.stdout).toContain('guest (helper)')
    expect(exported.stdout).toContain('wrap it up')
    expect(exported.stdout).toContain('party closed by host')
  })

  it('tail follows the party until timeout', async () => {
    const dir = makeTmpDir()
    const ref = createParty(dir)
    cli('join', ref, '--as', 'guest')
    const tail = Bun.spawn({
      cmd: [process.execPath, CLI, 'tail', ref, '--as', 'host', '--timeout', '2'],
      stdout: 'pipe',
    })
    await Bun.sleep(400)
    cli('send', ref, '--as', 'guest', 'live message')
    expect(await tail.exited).toBe(0)
    const output = await new Response(tail.stdout).text()
    expect(output).toContain('guest joined')
    expect(output).toContain('live message')
  })

  it("--to '*' broadcasts to everyone", () => {
    const dir = makeTmpDir()
    const ref = createParty(dir)
    cli('join', ref, '--as', 'guest')
    const sent = cli('send', ref, '--as', 'host', '--to', '*', 'to everyone')
    expect(sent.code).toBe(0)
    expect(sent.stdout).toContain('→ all')
    expect(cli('read', ref, '--as', 'guest').stdout).toContain('to everyone')
  })

  it('refuses to join under a reserved or malformed name', () => {
    const dir = makeTmpDir()
    const ref = createParty(dir)
    const asAll = cli('join', ref, '--as', 'all')
    expect(asAll.code).toBe(1)
    expect(asAll.stderr).toContain('reserved')
    const asStar = cli('join', ref, '--as', '*')
    expect(asStar.code).toBe(1)
    expect(asStar.stderr).toContain('Invalid participant name')
  })

  it('fails clearly on bad input', () => {
    const unknown = cli('dance')
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('unknown command')

    const noName = cli('join', 'local:/tmp/nope.sqlite')
    expect(noName.code).toBe(1)
    expect(noName.stderr).toContain('--as')

    const badRef = cli('join', 'wat:x', '--as', 'a')
    expect(badRef.code).toBe(1)
    expect(badRef.stderr).toContain('Unknown party ref')
  })
})
