#!/usr/bin/env bun
/**
 * publish — publish this package if its current version isn't on npm yet. Idempotent: an already-published version is
 * skipped, so it's safe to run on every push. Runs in CI with npm auth (OIDC Trusted Publisher → provenance).
 *
 * The dist-tag comes from the version: a prerelease x.y.z-next.N publishes under `--tag next`, a stable x.y.z under
 * `latest`. The tag ↔ version guard (scripts/check-channel.ts) is asserted first, so the git tag that triggered the
 * release must match the version being published. Provenance comes automatically from OIDC Trusted Publishing.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Channel guard first — refuse to publish if the version doesn't match the branch.
const guard = Bun.spawnSync(['bun', join(rootDir, 'scripts/check-channel.ts')], {
  stdout: 'inherit',
  stderr: 'inherit',
})
if (guard.exitCode !== 0) process.exit(guard.exitCode)

const distTag = (version: string): string => (version.includes('-') ? version.split('-')[1].split('.')[0] : 'latest')

const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8')) as {
  name?: string
  version?: string
  private?: boolean
}
if (!pkg.name || !pkg.version || pkg.private) {
  console.info('Nothing to publish (no name/version, or package is private).')
  process.exit(0)
}

const id = `${pkg.name}@${pkg.version}`
const onNpm = Bun.spawnSync(['npm', 'view', id, 'version']).exitCode === 0
if (onNpm) {
  console.info(`skip ${id} (already published)`)
  process.exit(0)
}

const tag = distTag(pkg.version)
console.info(`publish ${id} (tag: ${tag})`)
const res = Bun.spawnSync(['npm', 'publish', '--tag', tag], {
  cwd: rootDir,
  stdout: 'inherit',
  stderr: 'inherit',
})
if (res.exitCode !== 0) {
  console.error(`FAILED to publish ${id}`)
  process.exit(res.exitCode)
}
console.info(`Published ${id}.`)
