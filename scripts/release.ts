#!/usr/bin/env bun
/**
 * release — bump this package to the next version, promote the CHANGELOG "Unreleased" section (stable only), then
 * commit + tag `v<version>`. You review and push — the tag is what triggers CI to publish (scripts/publish.ts). Nothing
 * is pushed for you; nothing is derived from commit messages.
 *
 * bun run release patch 0.1.0 → 0.1.1 bun run release minor 0.1.0 → 0.2.0 bun run release prerelease 0.1.0 →
 * 0.1.0-next.0 (re-run → -next.1, -next.2 …) bun run release stable 0.2.0-next.3 → 0.2.0 (strip the prerelease suffix)
 * bun run release 0.3.0 explicit version (also accepts 0.3.0-next.0). Add --no-git to bump only (skip commit + tag).
 *
 * Classic single-branch model: everything lands on `main` and `v*` tags drive publishing. The dist-tag is derived from
 * the version (prerelease → `next`, stable → `latest`); the tag ↔ version match is enforced by scripts/check-channel.ts
 * in CI and on pre-push. The major version is PINNED (see PINNED_MAJOR below) — no command can raise it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8'))

const PRE = 'next' // prerelease identifier + channel name

// The ONLY major version this script will ever emit. There is deliberately NO command or CLI flag that
// can raise the major — a new major must be HARDCODED by bumping this constant by hand. Any release whose
// resulting major differs from PINNED_MAJOR is refused below, so a major can never be reached accidentally
// or automatically (a wrong major is a one-way, ecosystem-breaking publish).
//
// ⚠️ AGENTS / AI ASSISTANTS: NEVER change PINNED_MAJOR yourself, and never edit the guard below to get
// past it. Cutting a major is a human-only decision — only the maintainer edits this line, by hand, on
// purpose. If asked to "release 1.0"/"bump the major", STOP and have the human change this constant.
const PINNED_MAJOR = 0

const arg = process.argv[2]
if (!arg) {
  console.error('usage: bun run release <patch|minor|prerelease|stable|x.y.z[-next.N]>')
  process.exit(1)
}

const pkgPath = join(rootDir, 'package.json')
const current = readJson(pkgPath).version as string
const [base, pre] = current.split('-') as [string, string?] // pre e.g. "next.3" | undefined
const [maj, min, pat] = base.split('.').map(Number)

let next: string
if (arg === 'patch') next = `${maj}.${min}.${pat + 1}`
else if (arg === 'minor') next = `${maj}.${min + 1}.0`
else if (arg === 'prerelease') {
  // open a prerelease line for the current base, or bump the -next.N counter if already on one
  const n = pre?.startsWith(`${PRE}.`) ? Number(pre.slice(PRE.length + 1)) + 1 : 0
  next = `${base}-${PRE}.${n}`
} else if (arg === 'stable') {
  if (!pre) {
    console.error(`Already stable (${current}); nothing to strip.`)
    process.exit(1)
  }
  next = base
} else if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(arg)) next = arg
else {
  console.error(`Bad version: "${arg}". Use patch, minor, prerelease, stable, or an explicit x.y.z[-next.N].`)
  process.exit(1)
}

const nextMajor = Number(next.split('.')[0])
if (nextMajor !== PINNED_MAJOR) {
  console.error(
    `Refusing ${current} → ${next}: major ${nextMajor} ≠ pinned major ${PINNED_MAJOR}. ` +
      `Majors are never reachable by command — a human must hardcode PINNED_MAJOR in scripts/release.ts first.`,
  )
  process.exit(1)
}

// Set the version in package.json.
const pkg = readJson(pkgPath)
pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.info(`version ${current} → ${next}`)

// Promote the CHANGELOG "Unreleased" section — only for a stable cut. Prereleases are interim,
// so they leave Unreleased to keep accumulating until the real release.
const isPre = next.includes('-')
const changelogPath = join(rootDir, 'CHANGELOG.md')
if (!isPre && existsSync(changelogPath)) {
  const date = new Date().toISOString().slice(0, 10)
  const raw = readFileSync(changelogPath, 'utf-8')
  if (raw.includes('## Unreleased')) {
    writeFileSync(changelogPath, raw.replace('## Unreleased', `## Unreleased\n\n## ${next} — ${date}`))
    console.info(`CHANGELOG: promoted Unreleased → ${next}`)
  } else {
    console.warn('CHANGELOG.md has no "## Unreleased" heading — add the release notes by hand.')
  }
}

const tagName = `v${next}`

if (process.argv.includes('--no-git')) {
  console.info(
    `\nBumped to ${next} (--no-git: no commit/tag made). When ready:\n` +
      `  git add -A && git commit -m "chore(release): ${tagName}" && git tag -a ${tagName} -m ${tagName}\n` +
      `  git push origin main --follow-tags   # the tag triggers CI to publish`,
  )
} else {
  // Commit + tag together so the bump and the tag can never drift (CI re-asserts tag ↔ version before publishing).
  // Annotated tag (-a) on purpose: `git push --follow-tags` only pushes annotated tags, never lightweight ones.
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: rootDir, stdout: 'inherit', stderr: 'inherit' })
    if (!r.success) {
      console.error(`git ${args[0]} failed`)
      process.exit(1)
    }
  }
  git('add', '-A')
  git('commit', '-m', `chore(release): ${tagName}`)
  git('tag', '-a', tagName, '-m', tagName)
  console.info(
    `\nCommitted + tagged ${tagName} (dist-tag: ${isPre ? 'next' : 'latest'}). Nothing pushed yet — review with ` +
      `\`git show ${tagName}\`, then publish with:\n` +
      `  git push origin main --follow-tags   # the tag triggers CI to publish\n` +
      `To undo before pushing: git tag -d ${tagName} && git reset --soft HEAD~1`,
  )
}
