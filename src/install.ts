import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `agents-party install <target>` — put the party skill where the user's agent picks it up. The canonical text ships
 * with the package as `skills/party/SKILL.md` (one source of truth for the repo, the installer, and the docs). That
 * path is also the layout every skill directory scans for, so `npx skills add 1gr14/agents-party` finds it in the
 * repo.
 *
 * Every target reads the same open format: the Agent Skills standard (https://agentskills.io) — one `SKILL.md` in a
 * folder named after the skill, carrying `name` + `description` frontmatter. Only the directory differs, so installing
 * is "copy the same file to the right root"; never strip the frontmatter, it is what makes the skill discoverable.
 */

export type InstallTarget = 'claude' | 'cursor' | 'codex'

/** Where each agent looks for skills, relative to the root (`~` by default, the current directory with `--project`). */
const skillsRoot: Record<InstallTarget, string> = {
  claude: '.claude',
  // Cursor moved off `.cursor/commands/<name>.md` to skills; it also reads `.claude/skills`, so one install can serve both.
  cursor: '.cursor',
  // Codex reads `.agents/skills` from the CWD up to the repo root, plus `~/.agents/skills`.
  codex: '.agents',
}

export interface InstallOptions {
  /** Install into `~` (every project on this machine) instead of the current directory (this project only). */
  global?: boolean
  /** Overridable for tests. */
  homeDir?: string
}

/** The package ships skills/party/SKILL.md next to dist/ — resolve it from either. */
const skillSource = (): string => fs.readFileSync(new URL('../skills/party/SKILL.md', import.meta.url), 'utf8')

const write = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const skillFile = (root: string, target: InstallTarget): string =>
  path.join(root, skillsRoot[target], 'skills', 'party', 'SKILL.md')

/** What to tell the user after the copy: which scope they got, and the one thing they do next. */
const nextSteps = (dir: string, target: InstallTarget, home: string, global: boolean): string => {
  const scope = global
    ? 'Scope: your user, so every project on this machine sees it.'
    : `Scope: this folder only (${dir}), so it travels with the repo.`
  const codex =
    target === 'codex' ? '\nOn a Codex build without skills support, point your AGENTS.md at the file above.' : ''
  return `${scope}\nNext: tell your agent "/party" (an open session picks the skill up on its own; restart it if it does not).${codex}`
}

/**
 * Install the party skill for a target: write the file and return its path plus the follow-up text for the user.
 */
export const install = (
  dir: string,
  target: InstallTarget,
  options: InstallOptions = {},
): { file: string; next: string } => {
  const home = options.homeDir ?? os.homedir()
  const global = options.global === true
  const file = skillFile(global ? home : dir, target)
  write(file, skillSource())
  return { file, next: nextSteps(dir, target, home, global) }
}
