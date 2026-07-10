# Contributing

Thanks for helping out. This page tells you how.

Code is not the only way to contribute. Fixing typos, improving docs, triaging
issues, and reviewing pull requests all count.

## Setup

You need [Bun](https://bun.sh) 1+.

```sh
git clone https://github.com/1gr14/agents-party.git
cd agents-party
bun install
```

## Commands

```sh
bun run test     # run tests
bun run types    # type-check
bun run lint     # lint and auto-fix
bun run build    # build to dist/
bun run smoke    # smoke-test the built package
```

Run `bun run test`, `bun run types`, and `bun run lint` before you push.

## Issues

- Search existing issues first, including closed ones.
- For a bug, include a minimal example that reproduces it. A runnable link is
  best.
- For a feature, explain the problem before the solution.

## Pull requests

- For large or breaking changes, open an issue first. Don't write a big PR that
  might get rejected.
- One PR, one topic. No unrelated changes.
- Match the existing code style.
- Add or update tests for your change. When you change public types, add type
  tests with `expectTypeOf` from `bun:test` (checked by `tsc`).
- Work on a branch, not `main`, and open the PR against `main`. CI runs the full
  gate (types, lint, tests, smoke) on every PR — that green check is required to
  merge. Releases are maintainer-only and tag-driven; you never bump versions or
  tag in a PR.
- Keep "Allow edits from maintainers" checked.

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) (checked by
commitlint) — they keep history readable. Versions are **not** derived from
commits: the maintainer picks the next version explicitly with
`bun run release`, and changelog notes go under `## Unreleased` in
[CHANGELOG.md](./CHANGELOG.md).

```
feat: add greet helper
fix: handle empty name input
docs: clarify usage example
```

Mark a breaking change with `!`:

```
feat!: rename greet() to hello()
```

That's it. Open the PR and we'll take it from there.
