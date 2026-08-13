import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPlan, formatPlan, NEW, MERGE, PATCH, SKIP, UNCHANGED } from '../../src/core/plan.js'
import { upsert } from '../../src/core/blocks.js'
import { hash } from '../../src/core/text.js'
import { emptyManifest, record } from '../../src/core/manifest.js'

let root
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'caselaw-plan-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const put = async (rel, content) => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
  return content
}

const fileArtifact = (path, body) => ({ path, kind: 'file', body })
const blockArtifact = (path, blockId, body) => ({ path, kind: 'block', blockId, body, version: 1 })

describe('plan — new files', () => {
  test('a file that does not exist is NEW', async () => {
    const { entries, summary } = await buildPlan(root, [fileArtifact('docs/a.md', 'hello')])
    assert.equal(entries[0].action, NEW)
    assert.equal(summary.willWrite, 1)
  })

  test('a block in a file that does not exist is NEW, not MERGE', async () => {
    const { entries } = await buildPlan(root, [blockArtifact('CLAUDE.md', 'pointer', 'ours')])
    assert.equal(entries[0].action, NEW)
  })
})

describe('plan — existing files', () => {
  test('a block added to a user’s existing file is PATCH and preserves their content', async () => {
    await put('CLAUDE.md', '# My notes\n\nUser prose.\n')
    const { entries } = await buildPlan(root, [blockArtifact('CLAUDE.md', 'pointer', 'ours')])
    assert.equal(entries[0].action, PATCH)
    assert.match(entries[0].nextText, /# My notes/)
    assert.match(entries[0].nextText, /User prose\./)
    assert.match(entries[0].nextText, /ours/)
  })

  test('updating our own existing block is MERGE', async () => {
    const seeded = upsert('# Theirs\n', { id: 'pointer', body: 'v1', version: 1, filePath: 'CLAUDE.md' })
    await put('CLAUDE.md', seeded.text)
    const { entries } = await buildPlan(root, [blockArtifact('CLAUDE.md', 'pointer', 'v2')])
    assert.equal(entries[0].action, MERGE)
    assert.match(entries[0].nextText, /v2/)
    assert.match(entries[0].nextText, /# Theirs/)
  })

  test('identical content is UNCHANGED and writes nothing', async () => {
    const seeded = upsert('', { id: 'p', body: 'same', version: 1, filePath: 'CLAUDE.md' })
    await put('CLAUDE.md', seeded.text)
    const { entries, summary } = await buildPlan(root, [blockArtifact('CLAUDE.md', 'p', 'same')])
    assert.equal(entries[0].action, UNCHANGED)
    assert.equal(summary.willWrite, 0, 'a second run must be a no-op')
  })
})

describe('plan — POSITIVE CONTROLS: refusing to clobber', () => {
  test('a pre-existing file we did not generate is SKIPPED, not overwritten', async () => {
    await put('docs/a.md', 'THE USER WROTE THIS\n')
    const { entries, summary } = await buildPlan(root, [fileArtifact('docs/a.md', 'generated')])
    assert.equal(entries[0].action, SKIP)
    assert.match(entries[0].reason, /already exists/)
    assert.equal(summary.willWrite, 0)
  })

  test('a generated file the user has since edited is SKIPPED with a reason naming that', async () => {
    const original = await put('docs/a.md', 'generated v1\n')
    const manifest = emptyManifest()
    record(manifest, { path: 'docs/a.md', kind: 'file', contentHash: hash(original) })
    await put('docs/a.md', 'generated v1 PLUS MY EDIT\n')

    const { entries } = await buildPlan(root, [fileArtifact('docs/a.md', 'generated v2')], { manifest })
    assert.equal(entries[0].action, SKIP)
    assert.match(entries[0].reason, /you edited this file/)
  })

  test('a generated file the user has NOT touched is regenerated', async () => {
    const original = await put('docs/a.md', 'generated v1')
    const manifest = emptyManifest()
    record(manifest, { path: 'docs/a.md', kind: 'file', contentHash: hash(original) })

    const { entries } = await buildPlan(root, [fileArtifact('docs/a.md', 'generated v2')], { manifest })
    assert.equal(entries[0].action, NEW)
    assert.equal(entries[0].replacing, true)
  })

  test('an edit inside our managed block is SKIPPED', async () => {
    const seeded = upsert('', { id: 'p', body: 'ours', version: 1, filePath: 'CLAUDE.md' })
    await put('CLAUDE.md', seeded.text.replace('ours', 'the user rewrote this'))
    const { entries } = await buildPlan(root, [blockArtifact('CLAUDE.md', 'p', 'regenerated')])
    assert.equal(entries[0].action, SKIP)
    assert.match(entries[0].reason, /edited inside the managed block/)
  })

  test('a duplicated managed block is SKIPPED with the block error, never guessed at', async () => {
    const one = upsert('', { id: 'p', body: 'ours', version: 1, filePath: 'CLAUDE.md' })
    await put('CLAUDE.md', one.text + '\n' + one.text)
    const { entries } = await buildPlan(root, [blockArtifact('CLAUDE.md', 'p', 'new')])
    assert.equal(entries[0].action, SKIP)
    assert.match(entries[0].reason, /appears 2 times/)
  })

  test('--force overrides a user edit, and only then', async () => {
    const seeded = upsert('', { id: 'p', body: 'ours', version: 1, filePath: 'CLAUDE.md' })
    await put('CLAUDE.md', seeded.text.replace('ours', 'user text'))
    const { entries } = await buildPlan(root, [blockArtifact('CLAUDE.md', 'p', 'forced')], { force: true })
    assert.notEqual(entries[0].action, SKIP)
    assert.match(entries[0].nextText, /forced/)
  })
})

describe('plan — presentation', () => {
  test('lists every entry with its action and never hides a skip', async () => {
    await put('docs/keep.md', 'user content')
    const plan = await buildPlan(root, [
      fileArtifact('docs/new.md', 'x'),
      fileArtifact('docs/keep.md', 'y'),
    ])
    const out = formatPlan(plan)
    assert.match(out, /NEW\s+docs\/new\.md/)
    assert.match(out, /SKIP\s+docs\/keep\.md/)
    assert.match(out, /already exists/)
    assert.match(out, /--force/, 'must tell the user how to override, and warn them')
  })

  test('says so plainly when there is nothing to do', async () => {
    const seeded = upsert('', { id: 'p', body: 'same', version: 1, filePath: 'C.md' })
    await put('C.md', seeded.text)
    const plan = await buildPlan(root, [blockArtifact('C.md', 'p', 'same')])
    assert.match(formatPlan(plan), /Nothing to write/)
  })
})
