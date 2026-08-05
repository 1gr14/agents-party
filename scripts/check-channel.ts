#!/usr/bin/env bun
/**
 * check-channel — the version → channel guard, run right before publishing (scripts/publish.ts spawns it first).
 *
 * There is no tag ↔ version cross-check anymore: a release is a push to `main` whose pipeline goes green, and the CI
 * release job derives the tag from `package.json` AFTER publishing, so the two hold by construction. What still needs
 * asserting is the version SHAPE, because the version alone decides the npm dist-tag: `x.y.z` → `latest`,
 * `x.y.z-next.N` → `next`. A malformed version (a typo'd suffix, a stray `-beta.1`) would quietly invent a third
 * channel on npm — refuse it here, before a single `npm publish` runs.
 *
 *     bun run check:channel   # validate the version in package.json + print the dist-tag it would publish under
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const isPrerelease = (version: string): boolean => version.includes('-')

/** The npm dist-tag a version publishes under: prerelease → 'next', stable → 'latest'. */
export const channelFor = (version: string): 'next' | 'latest' => (isPrerelease(version) ? 'next' : 'latest')

/** The only two shapes we ever publish — exactly what scripts/release.ts produces (stable, or the `next` line). */
const PUBLISHABLE = /^\d+\.\d+\.\d+(?:-next\.\d+)?$/

/** Throw if `version` isn't a shape that maps onto one of our two channels. */
export function assertVersion(version: string): void {
  if (PUBLISHABLE.test(version)) return
  throw new Error(
    `Version guard: "${version}" is not a version we publish. Use x.y.z (→ latest) or x.y.z-next.N (→ next); ` +
      `\`bun run release …\` only ever produces those, so this means package.json was edited by hand.`,
  )
}

export const pkgVersion = (): string =>
  (JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8')) as { version: string }).version

if (import.meta.main) {
  const version = pkgVersion()
  try {
    assertVersion(version)
    console.info(`version OK: ${version} (dist-tag: ${channelFor(version)})`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
