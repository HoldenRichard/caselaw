/**
 * Gate runner tests.
 *
 * The rule this file exists to satisfy: **no gate kind counts as existing
 * until it has been watched failing on a known-bad input.** A competing tool
 * in this space ships a feature that generates guardrail files nothing ever
 * reads — users believe a gate exists where none does. Config that nothing
 * enforces is worse than no config, because it buys false confidence.
 *
 * So every kind below gets a matched pair: a POSITIVE CONTROL proving it
 * fires on something genuinely wrong, and a true negative proving it stays
 * quiet on something legitimate. A check that cannot be seen failing, and a
 * check that fires on everything, are equally worthless.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate, matchGlob, extractHookInput, EXIT, KINDS } from '../../runtime/gate.mjs'

let root
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'harness-gate-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const put = async (rel, content) => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

/** A gate with the required universal fields filled in. */
const gate = (over) => ({
  id: 'g', severity: 'block', paths: ['**/*'],
  origin: 'docs/rules/active/r.md', message: 'nope',
  ...over,
})
const cfg = (...gates) => ({ version: 1, gates })
const run = (opts) => evaluate({ root, telemetry: false, ...opts })

// ---------------------------------------------------------------------------
// banned-content
// ---------------------------------------------------------------------------
describe('gate kind: banned-content', () => {
  const emDash = cfg(gate({
    kind: 'banned-content', paths: ['content/**/*.md'],
    patterns: [{ literal: '—', label: 'em dash' }],
  }))

  test('POSITIVE CONTROL: banned-content blocks an em dash in scoped copy', async () => {
    await put('content/a.md', 'Hello — world\n')
    const r = await run({ mode: 'all', config: emDash })
    assert.equal(r.ok, false, 'a planted em dash MUST fail')
    assert.equal(r.blocking.length, 1)
    assert.match(JSON.stringify(r.fires[0]), /em dash/)
  })

  test('true negative: clean copy passes', async () => {
    await put('content/a.md', 'Hello, world\n')
    assert.equal((await run({ mode: 'all', config: emDash })).ok, true)
  })

  test('true negative: the same character OUTSIDE the scope is ignored', async () => {
    await put('notes/a.md', 'Hello — world\n')
    assert.equal((await run({ mode: 'all', config: emDash })).ok, true,
      'an unscoped gate fires on everything, which is how gates get disabled')
  })

  test('POSITIVE CONTROL: a \\u2014 escape does not slip past a JSON-decoded scan', async () => {
    // The subtle one. Raw-text scanning sees the seven ASCII characters
    // — and reports clean, while the value the app renders is an em dash.
    await put('content/x.json', JSON.stringify({ title: 'Hello — world' }))
    const decoded = cfg(gate({
      kind: 'banned-content', paths: ['content/**/*.json'], decode: 'json',
      patterns: [{ literal: '—', label: 'em dash' }],
    }))
    const r = await run({ mode: 'all', config: decoded })
    assert.equal(r.ok, false, 'an escaped em dash is still an em dash to the reader')
  })

  test('regex patterns work, and a bad regex degrades instead of throwing', async () => {
    await put('src/a.js', 'const p = "/Users/someone/x"\n')
    const good = await run({ mode: 'all', config: cfg(gate({
      kind: 'banned-content', paths: ['src/**'], patterns: [{ regex: '/Users/[a-z]', label: 'home path' }],
    })) })
    assert.equal(good.ok, false)

    const bad = await run({ mode: 'all', config: cfg(gate({
      kind: 'banned-content', paths: ['src/**'], patterns: [{ regex: '([unclosed', label: 'broken' }],
    })) })
    assert.equal(bad.ok, true, 'a broken pattern must not block')
    assert.ok(bad.degraded.length + bad.config.problems.length > 0, 'but it must be reported, not silent')
  })

  test('grandfathering suppresses a known violation, and expiry ends the amnesty', async () => {
    await put('content/a.md', 'legacy — text\n')
    const withG = (expires) => cfg(gate({
      kind: 'banned-content', paths: ['content/**/*.md'],
      patterns: [{ literal: '—', label: 'em dash' }],
      grandfather: [{ context: 'legacy — text', reason: 'predates the rule', expires }],
    }))
    assert.equal((await run({ mode: 'all', config: withG('2099-01-01') })).ok, true)

    const expired = await run({ mode: 'all', config: withG('2020-01-01') })
    assert.equal(expired.ok, false, 'an expired exception must stop suppressing')
  })
})

// ---------------------------------------------------------------------------
// required-content
// ---------------------------------------------------------------------------
describe('gate kind: required-content', () => {
  const licence = cfg(gate({
    kind: 'required-content', paths: ['src/**/*.js'],
    requires: [{ literal: '@licence MIT', label: 'licence header' }],
  }))

  test('POSITIVE CONTROL: required-content blocks a file missing the required string', async () => {
    await put('src/a.js', 'export const x = 1\n')
    const r = await run({ mode: 'all', config: licence })
    assert.equal(r.ok, false, 'a missing licence header MUST fail')
  })

  test('true negative: a file containing it passes', async () => {
    await put('src/a.js', '// @licence MIT\nexport const x = 1\n')
    assert.equal((await run({ mode: 'all', config: licence })).ok, true)
  })
})

// ---------------------------------------------------------------------------
// cross-file
// ---------------------------------------------------------------------------
describe('gate kind: cross-file', () => {
  const manifestGate = cfg(gate({
    kind: 'cross-file',
    paths: ['data/**'],
    extract: [
      { name: 'items', file: 'data/items.json', pointer: '/items', key: 'id' },
      { name: 'index', file: 'data/index.json', pointer: '/entries', key: 'id' },
    ],
    assert: [
      { type: 'unique', of: 'items' },
      { type: 'set_equal', left: 'items', right: 'index' },
    ],
  }))

  const write = async (items, entries) => {
    await put('data/items.json', JSON.stringify({ items }))
    await put('data/index.json', JSON.stringify({ entries }))
  }

  test('POSITIVE CONTROL: cross-file blocks two files that disagree', async () => {
    await write([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }])
    const r = await run({ mode: 'all', config: manifestGate })
    assert.equal(r.ok, false, 'a manifest missing an entry MUST fail')
  })

  test('POSITIVE CONTROL: cross-file blocks a duplicate key', async () => {
    await write([{ id: 'a' }, { id: 'a' }], [{ id: 'a' }])
    assert.equal((await run({ mode: 'all', config: manifestGate })).ok, false)
  })

  test('true negative: files in agreement pass', async () => {
    await write([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }])
    assert.equal((await run({ mode: 'all', config: manifestGate })).ok, true,
      'set equality must not care about order')
  })

  test('a missing file degrades rather than silently passing', async () => {
    await put('data/items.json', JSON.stringify({ items: [{ id: 'a' }] }))
    const r = await run({ mode: 'all', config: manifestGate })
    assert.ok(r.degraded.length > 0 || r.ok === false,
      '"I could not read one side" must never read as "they agree"')
  })
})

// ---------------------------------------------------------------------------
// file-invariant
// ---------------------------------------------------------------------------
describe('gate kind: file-invariant', () => {
  test('POSITIVE CONTROL: file-invariant blocks malformed JSON', async () => {
    await put('data/a.json', '{ not json')
    const r = await run({ mode: 'all', config: cfg(gate({
      kind: 'file-invariant', paths: ['data/**/*.json'], parses: 'json',
    })) })
    assert.equal(r.ok, false)
  })

  test('POSITIVE CONTROL: file-invariant blocks a missing trailing newline', async () => {
    await put('data/a.json', '{"a":1}')
    const r = await run({ mode: 'all', config: cfg(gate({
      kind: 'file-invariant', paths: ['data/**/*.json'], endsWithNewline: true,
    })) })
    assert.equal(r.ok, false)
  })

  test('true negative: a well-formed file passes both checks', async () => {
    await put('data/a.json', '{"a":1}\n')
    const r = await run({ mode: 'all', config: cfg(gate({
      kind: 'file-invariant', paths: ['data/**/*.json'], parses: 'json', endsWithNewline: true,
    })) })
    assert.equal(r.ok, true)
  })
})

// ---------------------------------------------------------------------------
// path-scope
// ---------------------------------------------------------------------------
describe('gate kind: path-scope', () => {
  const noGenerated = cfg(gate({ kind: 'path-scope', paths: ['generated/**'] }))

  test('POSITIVE CONTROL: path-scope blocks a write into a protected directory', async () => {
    const r = await run({ mode: 'pre', config: noGenerated, writes: ['generated/api.ts'], proposed: [{ path: 'generated/api.ts', text: 'x' }] })
    assert.equal(r.ok, false, 'writing into a generated directory MUST fail')
  })

  test('true negative: a write elsewhere passes', async () => {
    const r = await run({ mode: 'pre', config: noGenerated, writes: ['src/api.ts'], proposed: [{ path: 'src/api.ts', text: 'x' }] })
    assert.equal(r.ok, true)
  })
})

// ---------------------------------------------------------------------------
// paired-edit
// ---------------------------------------------------------------------------
describe('gate kind: paired-edit', () => {
  const schemaPair = cfg(gate({
    kind: 'paired-edit', paths: ['db/**'],
    when: ['db/schema.sql'], require: ['db/migrations/**'],
  }))

  test('POSITIVE CONTROL: paired-edit blocks a schema change with no migration', async () => {
    const r = await run({ mode: 'staged', config: schemaPair, changeSet: ['db/schema.sql'] })
    assert.equal(r.ok, false, 'a schema edit without its migration MUST fail')
  })

  test('true negative: the pair moving together passes', async () => {
    const r = await run({ mode: 'staged', config: schemaPair, changeSet: ['db/schema.sql', 'db/migrations/003.sql'] })
    assert.equal(r.ok, true)
  })

  test('POSITIVE CONTROL: with no visible change set it SKIPS rather than passing', async () => {
    const r = await run({ mode: 'all', config: schemaPair })
    assert.equal(r.skipped.length, 1, '"I cannot see the change set" is not "the pair was edited"')
    assert.match(r.skipped[0].skipReason, /change set/i)
  })
})

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------
describe('gate kind: shell', () => {
  test('POSITIVE CONTROL: shell blocks on a non-zero exit', async () => {
    await put('src/a.js', 'x')
    const r = await run({ mode: 'all', config: cfg(gate({
      kind: 'shell', paths: ['src/**'], command: 'false',
    })) })
    assert.equal(r.ok, false)
  })

  test('true negative: a zero exit passes', async () => {
    await put('src/a.js', 'x')
    const r = await run({ mode: 'all', config: cfg(gate({
      kind: 'shell', paths: ['src/**'], command: 'true',
    })) })
    assert.equal(r.ok, true)
  })

  test('POSITIVE CONTROL: a missing binary degrades and does NOT block', async () => {
    await put('src/a.js', 'x')
    const r = await run({ mode: 'all', config: cfg(gate({
      kind: 'shell', paths: ['src/**'], command: 'definitely-not-a-real-binary-xyz',
    })) })
    assert.equal(r.ok, true, 'a missing tool must never block the workflow')
    assert.ok(r.degraded.length > 0, 'but it must be loudly reported, never silent')
  })
})

// ---------------------------------------------------------------------------
// Coverage: every kind is actually exercised above
// ---------------------------------------------------------------------------
describe('every declared kind has a positive control', () => {
  test('POSITIVE CONTROL: no gate kind ships untested', async () => {
    const suite = await readFile(new URL(import.meta.url), 'utf8')
    for (const kind of KINDS) {
      assert.match(suite, new RegExp(`describe\\('gate kind: ${kind}'`),
        `"${kind}" is declared but has no test block — a gate kind nobody has watched fail does not exist`)
      assert.match(suite, new RegExp(`POSITIVE CONTROL: ${kind} `),
        `"${kind}" has no positive control`)
    }
  })
})

// ---------------------------------------------------------------------------
// Severity, and never breaking the workflow
// ---------------------------------------------------------------------------
describe('severity and self-failure', () => {
  test('warn reports but does not block', async () => {
    await put('content/a.md', 'Hello — world\n')
    const r = await run({ mode: 'all', config: cfg(gate({
      kind: 'banned-content', severity: 'warn', paths: ['content/**'],
      patterns: [{ literal: '—', label: 'em dash' }],
    })) })
    assert.equal(r.ok, true, 'a warn gate must never fail a run')
    assert.equal(r.warnings.length, 1, 'but it must still be reported')
  })

  test('POSITIVE CONTROL: an unparseable config does not block', async () => {
    await mkdir(join(root, '.harness'), { recursive: true })
    await writeFile(join(root, '.harness/gates.json'), '{ broken', 'utf8')
    const r = await evaluate({ root, mode: 'all', telemetry: false })
    assert.equal(r.ok, true, 'the tool failing must never look like the project failing')
    assert.ok(r.config.degraded, 'and it must say so')
  })

  test('an absent config is fine and silent', async () => {
    const r = await evaluate({ root, mode: 'all', telemetry: false })
    assert.equal(r.ok, true)
    assert.equal(r.config.present, false)
  })

  test('POSITIVE CONTROL: an unknown gate kind skips, and never blocks', async () => {
    const r = await run({ mode: 'all', config: cfg(gate({ kind: 'telepathy' })) })
    assert.equal(r.ok, true)
  })

  test('telemetry failure cannot fail a run', async () => {
    await put('content/a.md', 'Hello — world\n')
    const r = await evaluate({
      root: join(root, 'nonexistent-subdir'), mode: 'all', telemetry: true,
      config: cfg(gate({ kind: 'banned-content', paths: ['**'], patterns: [{ literal: 'zzz' }] })),
    })
    assert.ok(r, 'a failed telemetry write must not throw')
  })
})

// ---------------------------------------------------------------------------
// pre mode: proposed text, before it lands
// ---------------------------------------------------------------------------
describe('pre mode', () => {
  test('POSITIVE CONTROL: supplying proposed text without targets still checks it', async () => {
    // The footgun this defaulting closes: scanning an empty set and reporting
    // clean is indistinguishable from finding nothing.
    const r = await run({
      mode: 'pre',
      config: cfg(gate({ kind: 'banned-content', paths: ['content/**'], patterns: [{ literal: '—', label: 'em dash' }] })),
      writes: ['content/new.md'],
      proposed: [{ path: 'content/new.md', text: 'Hello — world' }],
    })
    assert.equal(r.ok, false, 'proposed text must be checked even when targets is omitted')
  })

  test('POSITIVE CONTROL: pre blocks proposed text that never touched disk', async () => {
    const r = await run({
      mode: 'pre',
      config: cfg(gate({ kind: 'banned-content', paths: ['content/**'], patterns: [{ literal: '—', label: 'em dash' }] })),
      writes: ['content/new.md'],
      targets: ['content/new.md'],
      proposed: [{ path: 'content/new.md', text: 'Hello — world' }],
    })
    assert.equal(r.ok, false, 'the whole point of pre is catching it BEFORE the write lands')
  })

  test('structural kinds skip in pre with a stated reason, rather than passing', async () => {
    const r = await run({
      mode: 'pre',
      config: cfg(gate({ kind: 'file-invariant', paths: ['**'], parses: 'json' })),
      writes: ['a.json'], proposed: [{ path: 'a.json', text: '{bad' }],
    })
    assert.ok(r.skipped.length === 1 && r.skipped[0].skipReason)
  })
})

describe('hook payload extraction', () => {
  test('reads Write, Edit and MultiEdit shapes', () => {
    assert.equal(extractHookInput({ tool_name: 'Write', tool_input: { file_path: '/r/a.md', content: 'X' } }).texts[0], 'X')
    assert.equal(extractHookInput({ tool_name: 'Edit', tool_input: { file_path: '/r/a.md', new_string: 'Y' } }).texts[0], 'Y')
    assert.deepEqual(
      extractHookInput({ tool_name: 'MultiEdit', tool_input: { file_path: '/r/a.md', edits: [{ new_string: 'A' }, { new_string: 'B' }] } }).texts,
      ['A', 'B'],
    )
  })

  test('POSITIVE CONTROL: garbage in never throws and never blocks', () => {
    for (const bad of [null, undefined, 42, 'string', {}, { tool_input: null }]) {
      const r = extractHookInput(bad)
      assert.equal(r.path, null, 'an unrecognised payload must yield nothing to check, not an exception')
    }
  })
})

describe('glob matching', () => {
  test('handles **, *, ? and braces', () => {
    assert.ok(matchGlob('docs/**/*.md', 'docs/a/b/c.md'))
    assert.ok(matchGlob('src/*.js', 'src/a.js'))
    assert.ok(!matchGlob('src/*.js', 'src/a/b.js'), '* must not cross a slash')
    assert.ok(matchGlob('a?.txt', 'ab.txt'))
    assert.ok(matchGlob('src/**/*.{js,ts}', 'src/a/b.ts'))
    assert.ok(!matchGlob('src/**/*.{js,ts}', 'src/a/b.css'))
  })

  test('a leading **/ matches at the root too', () => {
    assert.ok(matchGlob('**/*.md', 'a.md'))
  })
})

describe('exit codes', () => {
  test('the contract the hooks depend on', () => {
    assert.equal(EXIT.OK, 0)
    assert.equal(EXIT.FAILED, 1)
    assert.equal(EXIT.PRE_BLOCK, 2, 'Claude Code reads exit 2 as "block and show stderr"')
  })
})
