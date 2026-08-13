import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyManifest, load, save, record, forget, reconcile, orphans, ejectPlan, ManifestError,
} from '../../src/core/manifest.js'
import { locate, upsert } from '../../src/core/blocks.js'
import { hash } from '../../src/core/text.js'

let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'caselaw-manifest-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(rel, content) {
  const abs = join(root, rel)
  await mkdir(join(abs, '..'), { recursive: true })
  await writeFile(abs, content, 'utf8')
  return content
}

describe('manifest — persistence', () => {
  test('load returns null when absent, round-trips after save', async () => {
    assert.equal(await load(root), null)
    const m = emptyManifest({ cliVersion: '1.2.3', templateVersion: '4' })
    record(m, { path: 'docs/a.md', kind: 'file', contentHash: hash('x') })
    await save(root, m, { now: '2026-08-12T00:00:00.000Z' })

    const back = await load(root)
    assert.equal(back.cliVersion, '1.2.3')
    assert.equal(back.templateVersion, '4')
    assert.equal(back.generatedAt, '2026-08-12T00:00:00.000Z')
    assert.equal(back.entries['docs/a.md'].kind, 'file')
  })

  test('POSITIVE CONTROL: a future schema version is refused, not guessed at', async () => {
    await mkdir(join(root, '.caselaw'), { recursive: true })
    await writeFile(
      join(root, '.caselaw/manifest.json'),
      JSON.stringify({ schemaVersion: 99, entries: {} }),
      'utf8',
    )
    await assert.rejects(
      () => load(root),
      (e) => e instanceof ManifestError && e.code === 'SCHEMA_MISMATCH',
    )
  })

  test('POSITIVE CONTROL: malformed JSON is refused', async () => {
    await mkdir(join(root, '.caselaw'), { recursive: true })
    await writeFile(join(root, '.caselaw/manifest.json'), '{ not json', 'utf8')
    await assert.rejects(
      () => load(root),
      (e) => e instanceof ManifestError && e.code === 'UNREADABLE',
    )
  })
})

describe('manifest — recording', () => {
  test('POSITIVE CONTROL: a block entry without a blockId is rejected', () => {
    const m = emptyManifest()
    assert.throws(
      () => record(m, { path: 'CLAUDE.md', kind: 'block', contentHash: 'abc' }),
      (e) => e instanceof ManifestError && e.code === 'MISSING_BLOCK_ID',
    )
  })

  test('POSITIVE CONTROL: an unknown ownership kind is rejected', () => {
    const m = emptyManifest()
    assert.throws(
      () => record(m, { path: 'x', kind: 'symlink', contentHash: 'abc' }),
      (e) => e instanceof ManifestError && e.code === 'BAD_KIND',
    )
  })

  test('forget removes an entry', () => {
    const m = emptyManifest()
    record(m, { path: 'a.md', kind: 'file', contentHash: 'h' })
    forget(m, 'a.md')
    assert.deepEqual(Object.keys(m.entries), [])
  })
})

describe('manifest — reconcile against reality', () => {
  test('an untouched generated file is clean', async () => {
    const content = await put('docs/a.md', 'generated content\n')
    const m = emptyManifest()
    record(m, { path: 'docs/a.md', kind: 'file', contentHash: hash(content) })

    const r = await reconcile(root, m, { locate })
    assert.deepEqual(r.clean, ['docs/a.md'])
    assert.deepEqual(r.modified, [])
  })

  test('POSITIVE CONTROL: an edited generated file is reported modified', async () => {
    const content = await put('docs/a.md', 'generated content\n')
    const m = emptyManifest()
    record(m, { path: 'docs/a.md', kind: 'file', contentHash: hash(content) })
    await put('docs/a.md', 'the user rewrote this\n')

    const r = await reconcile(root, m, { locate })
    assert.deepEqual(r.modified, ['docs/a.md'])
    assert.deepEqual(r.clean, [])
  })

  test('a deleted generated file is reported missing, not modified', async () => {
    const m = emptyManifest()
    record(m, { path: 'docs/gone.md', kind: 'file', contentHash: hash('x') })
    const r = await reconcile(root, m, { locate })
    assert.deepEqual(r.missing, ['docs/gone.md'])
  })

  test('a CRLF checkout of a generated file stays clean', async () => {
    const content = 'line one\nline two\n'
    const m = emptyManifest()
    record(m, { path: 'docs/a.md', kind: 'file', contentHash: hash(content) })
    await put('docs/a.md', content.replace(/\n/g, '\r\n'))

    const r = await reconcile(root, m, { locate })
    assert.deepEqual(r.clean, ['docs/a.md'], 'CRLF must not read as a user edit')
  })

  test('block entries track only the block interior, not the whole file', async () => {
    const written = upsert('# User heading\n\nUser prose.\n', {
      id: 'pointer', body: 'ours', version: 1, filePath: 'CLAUDE.md',
    })
    await put('CLAUDE.md', written.text)
    const m = emptyManifest()
    record(m, { path: 'CLAUDE.md', kind: 'block', blockId: 'pointer', contentHash: hash('ours') })

    let r = await reconcile(root, m, { locate })
    assert.deepEqual(r.clean, ['CLAUDE.md'])

    // The user edits their OWN part of the file — our block is untouched.
    await put('CLAUDE.md', written.text.replace('User prose.', 'Totally different prose.'))
    r = await reconcile(root, m, { locate })
    assert.deepEqual(r.clean, ['CLAUDE.md'], 'edits outside our block are not our business')

    // Now they edit INSIDE our block.
    await put('CLAUDE.md', written.text.replace('ours', 'theirs'))
    r = await reconcile(root, m, { locate })
    assert.deepEqual(r.modified, ['CLAUDE.md'])
  })

  test('a block deleted from a surviving file is missing, not modified', async () => {
    await put('CLAUDE.md', '# just the user now\n')
    const m = emptyManifest()
    record(m, { path: 'CLAUDE.md', kind: 'block', blockId: 'pointer', contentHash: hash('ours') })
    const r = await reconcile(root, m, { locate })
    assert.deepEqual(r.missing, ['CLAUDE.md'])
  })

  test('a duplicated block surfaces as unreadable rather than crashing the run', async () => {
    const one = upsert('', { id: 'pointer', body: 'ours', version: 1, filePath: 'CLAUDE.md' })
    await put('CLAUDE.md', one.text + '\n' + one.text)
    const m = emptyManifest()
    record(m, { path: 'CLAUDE.md', kind: 'block', blockId: 'pointer', contentHash: hash('ours') })

    const r = await reconcile(root, m, { locate })
    assert.equal(r.unreadable.length, 1)
    assert.match(r.unreadable[0].reason, /appears 2 times/)
  })
})

describe('manifest — orphans and eject', () => {
  test('orphans are entries no longer in the write plan', () => {
    const m = emptyManifest()
    record(m, { path: 'docs/a.md', kind: 'file', contentHash: 'h' })
    record(m, { path: 'docs/removed.md', kind: 'file', contentHash: 'h' })
    assert.deepEqual(orphans(m, ['docs/a.md']), ['docs/removed.md'])
  })

  test('eject deletes whole files, strips blocks, and never touches user-edited content', () => {
    const m = emptyManifest()
    record(m, { path: 'docs/a.md', kind: 'file', contentHash: 'h' })
    record(m, { path: 'docs/edited.md', kind: 'file', contentHash: 'h' })
    record(m, { path: 'CLAUDE.md', kind: 'block', blockId: 'pointer', contentHash: 'h' })

    const plan = ejectPlan(m, { clean: ['docs/a.md', 'CLAUDE.md'], modified: ['docs/edited.md'], missing: [], unreadable: [] })
    assert.deepEqual(plan.deleteFiles, ['docs/a.md'])
    assert.deepEqual(plan.stripBlocks, [{ path: 'CLAUDE.md', blockId: 'pointer' }])
    assert.deepEqual(plan.leaveAlone, [{ path: 'docs/edited.md', reason: 'you edited it' }])
  })
})
