#!/usr/bin/env bun
/**
 * release — bump this package to the next version, promote the CHANGELOG "Unreleased" section (stable only), then
 * commit. Nothing is pushed for you and NOTHING IS TAGGED: you review and push `main`, the one CI run on that push
 * builds/lints/tests as on any push, and its final `release` job publishes (scripts/publish.ts) and only THEN creates
 * the `v<version>` tag. The tag is the RESULT of a green release, never its trigger — so a tag can never point at a
 * commit CI has not proven, and a broken release commit costs a fix commit instead of a burned version. Nothing is
 * derived from commit messages.
 *
 * bun run release patch 0.1.0 → 0.1.1 bun run release minor 0.1.0 → 0.2.0 bun run release prerelease 0.1.0 →
 * 0.1.0-next.0 (re-run → -next.1, -next.2 …) bun run release stable 0.2.0-next.3 → 0.2.0 (strip the prerelease suffix)
 * bun run release 0.3.0 explicit version (also accepts 0.3.0-next.0). Add --no-git to bump only (skip the commit).
 *
 * Classic single-branch model: everything lands on `main`, and a release is just a push to `main` whose pipeline goes
 * green. The dist-tag is derived from the version (prerelease → `next`, stable → `latest`); the tag ↔ version match
 * holds BY CONSTRUCTION — CI reads the version out of package.json and derives the tag from it, so the two cannot
 * drift. The major version is PINNED (see PINNED_MAJOR below) — no command can raise it.
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

// Is the version ALREADY in the tree unpublished? Then there is nothing to bump. Since the tag comes after green,
// a version sitting in package.json that npm has never seen means the previous release never made it through — a red
// pipeline, or it simply hasn't been pushed yet. The fix is a normal commit on `main` and a push, NOT another bump:
// bumping here would burn that version for good (the old double-bump gotcha — a failed release left the bump in the
// tree, the next `release patch` bumped on top of it and the unpublished number was skipped forever).
//
// NEVER_RELEASED is the one version this doesn't apply to: a fresh library sits at 0.0.0, which nothing ever
// publishes (CI treats it as the sentinel too) — so its first `bun run release 0.1.0` must go straight through.
const NEVER_RELEASED = '0.0.0'
if (current !== NEVER_RELEASED && !process.argv.includes('--force')) {
  const id = `${readJson(pkgPath).name as string}@${current}`
  const view = Bun.spawnSync(['npm', 'view', id, 'version'])
  if (view.exitCode !== 0) {
    // Only a genuine "not there" (E404) means unpublished; anything else (offline, registry down, auth) must not be
    // read as "unpublished" — that would silently refuse every release. Fail loudly instead.
    const stderr = view.stderr.toString()
    if (!/e404|404 not found/i.test(stderr)) {
      console.error(`release: could not ask npm about ${id} — not bumping blind.\n${stderr.trim()}`)
      process.exit(1)
    }
    console.info(
      `release: ${id} is NOT on npm — ${current} is bumped but never published (a red pipeline, or you simply ` +
        `haven't pushed yet). Nothing to bump.\n` +
        `  Fix whatever was red with a normal commit, then: git push origin main\n` +
        `  The green run publishes ${current} and tags v${current}.\n` +
        `  To bump anyway and skip ${current} for good: bun run release ${arg} --force`,
    )
    process.exit(0)
  }
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
    `\nBumped to ${next} (--no-git: nothing committed). When ready:\n` +
      `  git add -A && git commit -m "chore(release): ${tagName}"\n` +
      `  git push origin main   # the green run publishes ${next} and tags ${tagName}`,
  )
} else {
  // Commit only. The tag is created by CI at this same commit once the pipeline is green (.github/workflows/ci.yml),
  // so the bump and the tag can't drift and no tag can ever precede a green run.
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd: rootDir, stdout: 'inherit', stderr: 'inherit' })
    if (!r.success) {
      console.error(`git ${args[0]} failed`)
      process.exit(1)
    }
  }
  git('add', '-A')
  git('commit', '-m', `chore(release): ${tagName}`)
  console.info(
    `\nCommitted the ${next} bump (dist-tag: ${isPre ? 'next' : 'latest'}). Nothing pushed, nothing tagged — CI ` +
      `tags ${tagName} itself after the pipeline is green:\n` +
      `  git show HEAD          # review\n` +
      `  git push origin main   # publishes ${next} and tags ${tagName} at the end of the green run\n` +
      `If that run goes red, fix it with a normal commit and push again — ${next} is still yours.\n` +
      `To undo before pushing: git reset --soft HEAD~1`,
  )
}
