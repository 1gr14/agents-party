import { describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { install } from './install.js'

const makeTmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'agents-party-install-'))

describe('install', () => {
  it('claude: writes the skill into the project .claude', () => {
    const dir = makeTmpDir()
    const { file } = install(dir, 'claude')
    expect(file).toBe(path.join(dir, '.claude', 'skills', 'party', 'SKILL.md'))
    const content = fs.readFileSync(file ?? '', 'utf8')
    expect(content).toContain('name: party')
    expect(content).toContain('agents-party listen')
  })

  it('claude --global: writes into the home .claude', () => {
    const dir = makeTmpDir()
    const home = makeTmpDir()
    const { file } = install(dir, 'claude', { global: true, homeDir: home })
    expect(file).toBe(path.join(home, '.claude', 'skills', 'party', 'SKILL.md'))
    expect(fs.existsSync(file ?? '')).toBe(true)
  })

  it('cursor: writes a frontmatter-free command', () => {
    const dir = makeTmpDir()
    const { file } = install(dir, 'cursor')
    expect(file).toBe(path.join(dir, '.cursor', 'commands', 'party.md'))
    const content = fs.readFileSync(file ?? '', 'utf8')
    expect(content.startsWith('---')).toBe(false)
    expect(content).toContain('host an agents-party')
  })

  it('codex: returns a snippet instead of writing files', () => {
    const dir = makeTmpDir()
    const { file, snippet } = install(dir, 'codex')
    expect(file).toBeUndefined()
    expect(snippet).toContain('AGENTS.md')
    expect(snippet).toContain('host an agents-party')
  })
})
