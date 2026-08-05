import { describe, expect, it } from 'bun:test'
import { looksLikeDiff, summarizeDiff } from './diff.js'

describe('looksLikeDiff', () => {
  it('recognises a git diff', () => {
    const patch = 'diff --git a/x.ts b/x.ts\nindex 111..222 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n'
    expect(looksLikeDiff(patch)).toBe(true)
  })

  it('recognises a plain unified diff (--- / +++ pair)', () => {
    expect(looksLikeDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')).toBe(true)
  })

  it('recognises a bare hunk header', () => {
    expect(looksLikeDiff('@@ -3,4 +3,5 @@ func()\n context\n+added\n')).toBe(true)
  })

  it('ignores ordinary prose that merely mentions + or @@', () => {
    expect(looksLikeDiff('I think @@ is used in diffs, and 1 + 1 = 2.')).toBe(false)
    expect(looksLikeDiff('just a normal message')).toBe(false)
    expect(looksLikeDiff('')).toBe(false)
  })

  it('does not trip on a lone +++ without a --- pair', () => {
    expect(looksLikeDiff('+++ some emphasis +++')).toBe(false)
  })
})

describe('summarizeDiff', () => {
  it('counts files and +/- lines in a multi-file git diff', () => {
    const patch = [
      'diff --git a/one.ts b/one.ts',
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1,2 +1,2 @@',
      '-old one',
      '+new one',
      ' kept',
      'diff --git a/two.ts b/two.ts',
      '--- a/two.ts',
      '+++ b/two.ts',
      '@@ -0,0 +1 @@',
      '+brand new',
      '',
    ].join('\n')
    const s = summarizeDiff(patch)
    expect(s.files).toBe(2)
    expect(s.additions).toBe(2)
    expect(s.deletions).toBe(1)
    expect(s.firstFile).toBeUndefined()
  })

  it('surfaces the single file name and does not double-count it', () => {
    const patch = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n'
    const s = summarizeDiff(patch)
    expect(s.files).toBe(1)
    expect(s.firstFile).toBe('src/x.ts')
    expect(s.additions).toBe(1)
    expect(s.deletions).toBe(1)
  })

  it('handles a plain unified diff with no git header', () => {
    const s = summarizeDiff('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-one\n-two\n+three\n')
    expect(s.files).toBe(1)
    expect(s.firstFile).toBe('x')
    expect(s.additions).toBe(1)
    expect(s.deletions).toBe(2)
  })
})
