import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `agents-party install <target>` — put the party skill/prompt where the user's agent picks it up. The canonical text
 * ships with the package as `skill/party.md` (one source of truth for the repo, the installer, and the docs).
 */

export type InstallTarget = 'claude' | 'cursor' | 'codex'

export interface InstallOptions {
  /** For `claude`: install to `~/.claude` instead of the project's `.claude`. */
  global?: boolean
  /** Overridable for tests. */
  homeDir?: string
}

/** The package ships skill/party.md next to dist/ — resolve it from either. */
const skillSource = (): string => fs.readFileSync(new URL('../skill/party.md', import.meta.url), 'utf8')

// \r?\n: on Windows checkouts the skill file may arrive with CRLF line endings.
const stripFrontmatter = (markdown: string): string => markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n)+/, '')

const write = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/**
 * Install the party prompt for a target and return what to tell the user: the written file path, or the snippet itself
 * for snippet-based targets.
 */
export const install = (
  dir: string,
  target: InstallTarget,
  options: InstallOptions = {},
): { file?: string; snippet?: string } => {
  const home = options.homeDir ?? os.homedir()
  if (target === 'claude') {
    const file = path.join(
      options.global ? path.join(home, '.claude') : path.join(dir, '.claude'),
      'skills',
      'party',
      'SKILL.md',
    )
    write(file, skillSource())
    return { file }
  }
  if (target === 'cursor') {
    const file = path.join(dir, '.cursor', 'commands', 'party.md')
    write(file, stripFrontmatter(skillSource()))
    return { file }
  }
  // codex has no per-project prompt dir convention — hand back a snippet for AGENTS.md.
  return {
    snippet: `Add this to your AGENTS.md (or paste at the start of a session):\n\n${stripFrontmatter(skillSource())}`,
  }
}
