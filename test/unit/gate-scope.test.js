/**
 * Scope is a promise. Three ways the runner used to break it:
 *
 *  - `x/../src/a.js` matched no `src/**` gate, because paths were compared
 *    as raw strings and `..` was never collapsed — a traversal chose its scope.
 *  - a `paths` list whose globs all failed to compile fell back to "every
 *    file", widening a gate its author had scoped; and `modes: ["bogus"]`
 *    filtered to an empty list, which meant "every mode".
 *  - a shell gate's `cwd` was joined onto the root with no containment, so
 *    `../..` ran the command outside the repository.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate, toPosix } from '../../runtime/gate.mjs'

test('toPosix collapses interior segments and keeps an upward escape visible', () => {
  assert.equal(toPosix('x/../src/a.js'), 'src/a.js')
  assert.equal(toPosix('./src/./a.js'), 'src/a.js')
  assert.equal(toPosix('a\\b\\c.js'), 'a/b/c.js')
  assert.equal(toPosix('a/../../x'), '../x')
  assert.equal(toPosix('..'), '..')
  assert.equal(toPosix(''), '')
  assert.equal(toPosix('.'), '')
  assert.equal(toPosix('src/'), 'src/')
})


test('POSITIVE CONTROL: an uncompilable `paths` glob (or a bogus `modes`) must NARROW a gate, never widen it', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'caselaw-c9-'))
  await fs.mkdir(join(root, 'src'), { recursive: true })
  await fs.mkdir(join(root, 'docs'), { recursive: true })
  await fs.writeFile(join(root, 'src/bad.js'), 'const m = "ZZTOPSECRET"\n')
  await fs.writeFile(join(root, 'docs/clean.md'), 'nothing here\n')

  const banned = (id, extra) => ({
    id,
    kind: 'banned-content',
    severity: 'warn',
    origin: 'docs/rules/active/x.md',
    patterns: [{ literal: 'ZZTOPSECRET', label: 'marker' }],
    ...extra,
  })

  const res = await evaluate({
    root,
    mode: 'all',
    telemetry: false,
    targets: ['src/bad.js', 'docs/clean.md'],
    config: {
      version: 1,
      gates: [
        // '' cannot compile (compileGlob: "glob must be a non-empty string"),
        // so gateGlobs drops it and leaves `paths` empty.
        banned('invalid-glob', { paths: [''] }),
        // control: a VALID glob that excludes the violating file.
        banned('control-docs', { paths: ['docs/**'] }),
        // control: a VALID glob that includes it, so the pattern is known good.
        banned('control-src', { paths: ['src/**'] }),
        // every value in `modes` is unknown, so validateGates filters them all out.
        banned('bogus-modes', { paths: ['src/**'], modes: ['bogus'] }),
        // the shell kind length-checks RAW gate.paths but filters with the
        // COMPILED globs, so it hands files to the command anyway.
        {
          id: 'shell-invalid-glob',
          kind: 'shell',
          severity: 'warn',
          origin: 'docs/rules/active/x.md',
          paths: [''],
          command: '/bin/echo',
          args: [],
        },
      ],
    },
  })

  const byId = Object.fromEntries(res.results.map((r) => [r.gate, r]))

  // Controls: the pattern works, and a valid out-of-scope glob keeps it quiet.
  assert.equal(byId['control-src'].fires.length, 1, 'control: valid in-scope glob should fire')
  assert.equal(byId['control-docs'].fires.length, 0, 'control: valid out-of-scope glob should not fire')
  assert.equal(byId['control-docs'].filesChecked, 1, 'control: docs/** should see exactly one file')

  // A gate whose entire `paths` list failed to compile knows nothing about its
  // own scope. It must not fall back to "every file".
  assert.equal(
    byId['invalid-glob'].filesChecked,
    0,
    'banned-content with no usable `paths` scanned files it was never scoped to',
  )
  assert.equal(
    byId['invalid-glob'].fires.length,
    0,
    'banned-content with no usable `paths` fired on a file outside its declared scope',
  )

  // Same defect one layer down: kindShell gates on gate.paths.length but
  // filters with globs.paths, so the command receives the whole change set.
  assert.equal(
    byId['shell-invalid-glob'].filesChecked,
    0,
    'shell gate with no usable `paths` ran its command against every candidate file',
  )

  // An all-unknown `modes` list is a request to run in NO mode. Treating the
  // filtered-empty array as "every mode" widens it instead.
  const bogus = byId['bogus-modes']
  assert.ok(!bogus || bogus.skipped, 'a gate whose `modes` are all unknown must not run in mode "all"')
  assert.equal(bogus ? bogus.fires.length : 0, 0, 'a gate whose `modes` are all unknown fired anyway')

  await fs.rm(root, { recursive: true, force: true })
})


test('POSITIVE CONTROL: a shell gate cwd cannot escape the repo root', async () => {
  const outer = await fs.mkdtemp(join(tmpdir(), 'caselaw-c10-'))
  const root = join(outer, 'repo')
  await fs.mkdir(join(root, '.caselaw'), { recursive: true })

  const escapedMarker = join(outer, 'ESCAPED-OUTSIDE-REPO.txt')
  const insideMarker = join(root, 'ESCAPED-OUTSIDE-REPO.txt')

  const report = await evaluate({
    root,
    mode: 'all',
    telemetry: false,
    config: {
      version: 1,
      gates: [{
        id: 'escape',
        kind: 'shell',
        severity: 'block',
        origin: 'docs/rules/active/x.md',
        why: 'containment probe',
        command: process.execPath,
        args: ['-e', "require('fs').writeFileSync('ESCAPED-OUTSIDE-REPO.txt', process.cwd())"],
        passPaths: 'none',
        cwd: '..',
      }],
    },
  })

  const exists = async (p) => { try { await fs.stat(p); return true } catch { return false } }
  const escaped = await exists(escapedMarker)
  const inside = await exists(insideMarker)
  const where = escaped ? await fs.readFile(escapedMarker, 'utf8') : ''

  await fs.rm(outer, { recursive: true, force: true })

  assert.equal(
    escaped, false,
    `shell gate ran outside the repo root: the child's cwd was ${JSON.stringify(where)} ` +
    `and it wrote ${escapedMarker}. gate.cwd must be contained by ctx.root ` +
    `(or the gate rejected at validation). inside-root marker present: ${inside}. ` +
    `report.ok=${report.ok}`,
  )
})
