import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { upsert, locate, remove, isUserModified, styleFor, BlockError } from '../../src/core/blocks.js'
import { hash, normalize } from '../../src/core/text.js'

describe('managed blocks — creation', () => {
  test('creates a block in an empty file', () => {
    const r = upsert('', { id: 'pointer', body: 'hello', version: 1, style: 'html' })
    assert.equal(r.action, 'created')
    assert.match(r.text, /harness:begin id=pointer v=1 hash=[0-9a-f]{64}/)
    assert.match(r.text, /harness:end id=pointer/)
    assert.match(r.text, /^hello$/m)
  })

  test('appends to an existing file without disturbing its content', () => {
    const existing = '# My project\n\nSome notes the user wrote.\n'
    const r = upsert(existing, { id: 'pointer', body: 'managed', version: 1, style: 'html' })
    assert.equal(r.action, 'created')
    assert.ok(r.text.startsWith(existing.trimEnd()), 'user content must be preserved verbatim at the top')
    assert.match(r.text, /managed/)
  })

  test('declared hash matches the interior it wraps', () => {
    const r = upsert('', { id: 'x', body: 'body text', version: 2, style: 'html' })
    const found = locate(r.text, 'x')
    assert.equal(found.declaredHash, hash(found.interior))
    assert.equal(found.version, '2')
  })
})

describe('managed blocks — idempotency', () => {
  test('re-running with identical body is a no-op', () => {
    const a = upsert('', { id: 'x', body: 'same', version: 1, style: 'html' })
    const b = upsert(a.text, { id: 'x', body: 'same', version: 1, style: 'html' })
    assert.equal(b.action, 'unchanged')
    assert.equal(b.text, a.text, 'second run must produce byte-identical output')
  })

  test('changed body updates in place and leaves surrounding text alone', () => {
    const start = 'BEFORE\n\n'
    const a = upsert(start, { id: 'x', body: 'v1', version: 1, style: 'html' })
    const withTail = a.text + '\nAFTER\n'
    const b = upsert(withTail, { id: 'x', body: 'v2', version: 1, style: 'html' })
    assert.equal(b.action, 'updated')
    assert.match(b.text, /^BEFORE$/m)
    assert.match(b.text, /^AFTER$/m)
    assert.match(b.text, /^v2$/m)
    assert.doesNotMatch(b.text, /^v1$/m)
  })

  test('a version bump alone forces a rewrite', () => {
    const a = upsert('', { id: 'x', body: 'same', version: 1, style: 'html' })
    const b = upsert(a.text, { id: 'x', body: 'same', version: 2, style: 'html' })
    assert.equal(b.action, 'updated')
    assert.match(b.text, /v=2/)
  })
})

describe('managed blocks — POSITIVE CONTROLS (these must fail)', () => {
  test('duplicate blocks throw rather than clobbering one', () => {
    const one = upsert('', { id: 'x', body: 'a', version: 1, style: 'html' })
    const doubled = one.text + '\n' + one.text
    assert.throws(
      () => upsert(doubled, { id: 'x', body: 'b', version: 1, style: 'html' }),
      (err) => err instanceof BlockError && err.code === 'DUPLICATE' && err.count === 2,
      'a duplicated block MUST abort — this is assertion-before-replace',
    )
  })

  test('a begin marker with no end throws', () => {
    const broken = '<!-- harness:begin id=x v=1 hash=abc -->\nbody\n'
    assert.throws(
      () => upsert(broken, { id: 'x', body: 'new', version: 1, style: 'html' }),
      (err) => err instanceof BlockError && err.code === 'UNBALANCED',
    )
  })

  test('an end marker with no begin throws', () => {
    const broken = 'body\n<!-- harness:end id=x -->\n'
    assert.throws(
      () => upsert(broken, { id: 'x', body: 'new', version: 1, style: 'html' }),
      (err) => err instanceof BlockError && err.code === 'UNBALANCED',
    )
  })

  test('inverted markers throw', () => {
    const broken = '<!-- harness:end id=x -->\nbody\n<!-- harness:begin id=x v=1 hash=abc -->\n'
    assert.throws(
      () => upsert(broken, { id: 'x', body: 'new', version: 1, style: 'html' }),
      (err) => err instanceof BlockError && err.code === 'INVERTED',
    )
  })

  test('a user edit inside the block blocks the write instead of eating it', () => {
    const a = upsert('', { id: 'x', body: 'original', version: 1, style: 'html' })
    const edited = a.text.replace('original', 'the user rewrote this line')
    assert.equal(isUserModified(edited, 'x'), true)

    const b = upsert(edited, { id: 'x', body: 'regenerated', version: 1, style: 'html' })
    assert.equal(b.blocked, 'user-modified')
    assert.equal(b.text, edited, 'the file must come back untouched')
    assert.equal(b.previousInterior, 'the user rewrote this line')
    assert.doesNotMatch(b.text, /regenerated/)
  })

  test('--force overrides a user edit, but only when asked', () => {
    const a = upsert('', { id: 'x', body: 'original', version: 1, style: 'html' })
    const edited = a.text.replace('original', 'user text')
    const b = upsert(edited, { id: 'x', body: 'regenerated', version: 1, style: 'html', force: true })
    assert.equal(b.action, 'updated')
    assert.match(b.text, /regenerated/)
  })
})

describe('managed blocks — line endings and BOM must never read as drift', () => {
  test('a CRLF file round-trips as unchanged and keeps CRLF', () => {
    const a = upsert('', { id: 'x', body: 'line one\nline two', version: 1, style: 'html' })
    const crlf = a.text.replace(/\n/g, '\r\n')
    assert.equal(isUserModified(crlf, 'x'), false, 'CRLF checkout must not look like a user edit')

    const b = upsert(crlf, { id: 'x', body: 'line one\nline two', version: 1, style: 'html' })
    assert.equal(b.action, 'unchanged')
    assert.ok(b.text.includes('\r\n'), 'CRLF must be preserved, not silently normalized to LF')
  })

  test('a BOM survives and does not read as drift', () => {
    const a = upsert('', { id: 'x', body: 'content', version: 1, style: 'html' })
    const bommed = '﻿' + a.text
    assert.equal(isUserModified(bommed, 'x'), false)
    const b = upsert(bommed, { id: 'x', body: 'content', version: 1, style: 'html' })
    assert.equal(b.action, 'unchanged')
    assert.ok(b.text.startsWith('﻿'), 'BOM must be preserved')
  })
})

describe('managed blocks — comment styles', () => {
  test('hash style for .gitignore', () => {
    assert.equal(styleFor('.gitignore'), 'hash')
    assert.equal(styleFor('/repo/.gitignore'), 'hash')
    const r = upsert('node_modules/\n', { id: 'ign', body: '.harness/bin/', filePath: '.gitignore' })
    assert.match(r.text, /^# harness:begin id=ign/m)
    assert.match(r.text, /^node_modules\/$/m)
  })

  test('slash style for source files', () => {
    assert.equal(styleFor('src/App.swift'), 'slash')
    const r = upsert('', { id: 'h', body: 'note', filePath: 'src/App.swift' })
    assert.match(r.text, /^\/\/ harness:begin id=h/m)
  })

  test('html style for markdown, and for unknown extensions', () => {
    assert.equal(styleFor('CLAUDE.md'), 'html')
    assert.equal(styleFor('weird.xyz'), 'html')
  })

  test('a block written in one style is found regardless of style', () => {
    const r = upsert('', { id: 'x', body: 'b', filePath: '.gitignore' })
    assert.equal(locate(r.text, 'x').present, true)
  })
})

describe('managed blocks — removal (the eject path)', () => {
  test('removes only our block and leaves user content', () => {
    const original = 'USER TOP\n'
    const a = upsert(original, { id: 'x', body: 'ours', version: 1, style: 'html' })
    const withTail = a.text + 'USER BOTTOM\n'
    const r = remove(withTail, 'x')
    assert.equal(r.action, 'removed')
    assert.match(r.text, /USER TOP/)
    assert.match(r.text, /USER BOTTOM/)
    assert.doesNotMatch(r.text, /harness:begin/)
    assert.doesNotMatch(r.text, /ours/)
  })

  test('removing an absent block is a no-op, not an error', () => {
    const r = remove('nothing here\n', 'x')
    assert.equal(r.action, 'absent')
    assert.equal(r.text, 'nothing here\n')
  })

  test('removal reports what was there, so eject can print the residue', () => {
    const a = upsert('', { id: 'x', body: 'the content', version: 1, style: 'html' })
    const r = remove(a.text, 'x')
    assert.equal(r.previousInterior, 'the content')
  })
})

describe('managed blocks — ids are matched exactly', () => {
  test('a similarly-named id is not mistaken for ours', () => {
    const a = upsert('', { id: 'pointer', body: 'A', version: 1, style: 'html' })
    const b = upsert(a.text, { id: 'pointer-extra', body: 'B', version: 1, style: 'html' })
    assert.equal(b.action, 'created')
    assert.equal(locate(b.text, 'pointer').interior, 'A')
    assert.equal(locate(b.text, 'pointer-extra').interior, 'B')
  })

  test('regex metacharacters in an id do not break matching', () => {
    const r = upsert('', { id: 'a.b+c', body: 'x', version: 1, style: 'html' })
    assert.equal(locate(r.text, 'a.b+c').present, true)
    assert.equal(locate(r.text, 'aXbXc').present, false)
  })
})

describe('text normalization', () => {
  test('normalize collapses CRLF and strips BOM', () => {
    assert.equal(normalize('﻿a\r\nb\rc'), 'a\nb\nc')
  })
  test('hash is stable across line-ending styles', () => {
    assert.equal(hash('a\r\nb'), hash('a\nb'))
  })
})
