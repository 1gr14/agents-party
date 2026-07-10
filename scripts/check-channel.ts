#!/usr/bin/env bun
/**
 * check-channel — the tag ↔ version guard. In the classic single-branch model a release is published ONLY from a `v*`
 * tag, and the tag MUST equal `v${pkgVersion()}` so the package.json bump and the git tag can never drift (a stale tag
 * could otherwise publish the wrong version, or a -next tag could ship as stable). Run in CI right before publishing,
 * and locally in the pre-push hook when a tag is pushed.
 *
 * The npm dist-tag / channel is derived from the version itself: a prerelease x.y.z-next.N publishes under `next`, a
 * stable x.y.z under `latest` (see channelFor / scripts/publish.ts).
 *
 * bun run check:channel # tag from GITHUB_REF_NAME when on a tag (CI); else informational bun run check:channel v0.1.0
 *
 * # explicit tag
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const isPrerelease = (version: string): boolean => version.includes('-')

/** The npm dist-tag a version publishes under: prerelease → 'next', stable → 'latest'. */
export const channelFor = (version: string): 'next' | 'latest' => (isPrerelease(version) ? 'next' : 'latest')

/** Throw if a release `tag` doesn't match the working-tree `version` (it must be exactly `v${version}`). */
export function assertTag(version: string, tag: string): void {
  const expected = `v${version}`
  if (tag === expected) return
  throw new Error(
    `Tag guard: release tag "${tag}" does not match the version in package.json (${version}). ` +
      `A release tag must be exactly "${expected}" — re-run \`bun run release …\` so the bump and the tag agree.`,
  )
}

export const pkgVersion = (): string =>
  (JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8')) as { version: string }).version

if (import.meta.main) {
  const version = pkgVersion()
  const onTag = process.env.GITHUB_REF_TYPE === 'tag'
  const tag = process.argv[2] || (onTag ? process.env.GITHUB_REF_NAME : undefined)
  try {
    if (tag) {
      assertTag(version, tag)
      console.info(`channel OK: ${tag} ↔ ${version} (dist-tag: ${channelFor(version)})`)
    } else {
      console.info(`version ${version} (dist-tag: ${channelFor(version)}); no tag to check.`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
