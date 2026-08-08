import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { install } from './install.js'

const makeTmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-install-'))

const expectSkill = (file: string): void => {
  const content = fs.readFileSync(file, 'utf8')
  // The Agent Skills frontmatter is what makes the file discoverable — every target keeps it.
  expect(content.startsWith('---')).toBe(true)
  expect(content).toContain('name: party')
  // The skill leads with the global install and then spells every command bare: running a whole party through npx
  // re-resolves `@latest` on each command, and a party re-arms its listener after every message.
  expect(content).toContain('npm i -g agents-party@latest')
  expect(content).toContain('agents-party listen ')
  // Where the launcher does survive (nothing installed yet) it stays pinned — a bare `npx agents-party` can be
  // served stale from the npx cache and silently run an old version.
  expect(content).not.toMatch(/npx agents-party(?!@latest)/)
}

describe('install', () => {
  it('claude: writes SKILL.md into the project .claude', () => {
    const dir = makeTmpDir()
    const { file } = install(dir, 'claude')
    expect(file).toBe(path.join(dir, '.claude', 'skills', 'party', 'SKILL.md'))
    expectSkill(file)
  })

  it('claude --global: writes into the home .claude', () => {
    const dir = makeTmpDir()
    const home = makeTmpDir()
    const { file } = install(dir, 'claude', { global: true, homeDir: home })
    expect(file).toBe(path.join(home, '.claude', 'skills', 'party', 'SKILL.md'))
    expectSkill(file)
  })

  it('cursor: writes a skill, not the retired .cursor/commands prompt', () => {
    const dir = makeTmpDir()
    const { file } = install(dir, 'cursor')
    expect(file).toBe(path.join(dir, '.cursor', 'skills', 'party', 'SKILL.md'))
    expectSkill(file)
    expect(fs.existsSync(path.join(dir, '.cursor', 'commands'))).toBe(false)
  })

  it('codex: writes a skill into .agents instead of only printing a snippet', () => {
    const dir = makeTmpDir()
    const { file, next } = install(dir, 'codex')
    expect(file).toBe(path.join(dir, '.agents', 'skills', 'party', 'SKILL.md'))
    expectSkill(file)
    expect(next).toContain('AGENTS.md')
  })

  it('codex --global: writes into the home .agents', () => {
    const dir = makeTmpDir()
    const home = makeTmpDir()
    const { file } = install(dir, 'codex', { global: true, homeDir: home })
    expect(file).toBe(path.join(home, '.agents', 'skills', 'party', 'SKILL.md'))
    expectSkill(file)
  })

  it('tells the user what to do next, and which scope the file landed in', () => {
    const dir = makeTmpDir()
    const home = makeTmpDir()
    // The CLI defaults to the home scope (a skill is personal); a project install is the deliberate narrowing.
    const global = install(dir, 'claude', { global: true, homeDir: home })
    expect(global.next).toContain('/party')
    expect(global.next).toContain('every project on this machine')

    const local = install(dir, 'claude', { homeDir: home })
    expect(local.next).toContain('/party')
    expect(local.next).toContain(dir)
    expect(local.next).toContain('travels with the repo')
  })
})
