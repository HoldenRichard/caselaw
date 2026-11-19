/**
 * The draft's contract (0.5.0). In the 0.4.2 field test an agent had to find the
 * shape of declarations evidence by failing: the file said "evidence" and never
 * that it is an array, the error gave no shape, and a blank line
 * (`README.md:127`) was accepted as the evidence for "312 tests" because
 * evidence was checked only for the file's existence.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { buildDraft, validateDraft, evidenceWarnings, DRAFT_EXAMPLE, HOW_TO_FILL } from '../../src/interview/draft.js'
import { emptyAnswers } from '../../src/core/answers.js'

let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'caselaw-contract-'))
  // Line 3 is blank on purpose; line 4 is the claim's own line.
  await writeFile(join(root, 'README.md'), '# Bench rig\n\n\nThe suite runs 312 tests on every push.\nRequires macOS 14 or later.\n', 'utf8')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const DETECTED = { stack: { languages: [{ name: 'Python', pct: 100 }] }, deploySurface: [], signals: {} }

/** A draft whose outside.claims names `readme`, with the given declarations. */
function withDeclarations(declarations) {
  const draft = buildDraft({ doc: emptyAnswers(), detected: DETECTED })
  Object.assign(draft.questions.find((q) => q.id === 'outside.claims'), { answer: ['readme'], evidence: ['README.md:5'] })
  draft.declarations = declarations
  return draft
}
const claim = (over = {}) => ({ claim: 'The suite runs 312 tests', evidence: ['README.md:4'], truth: 'the suite', ...over })
const validate = (draft) => validateDraft(draft, { root, detected: DETECTED })
const warnings = (draft) => evidenceWarnings(draft, { root })

describe('the contract states its shapes', () => {
  test('howToFill says evidence is an array of path:line strings and shows the declarations shape', () => {
    const text = HOW_TO_FILL.join('\n')
    assert.match(text, /"evidence" is always an ARRAY of strings/)
    assert.match(text, /"evidence": \["README\.md:127"\]/)
    assert.match(text, /"<surface>": \[ \{ "claim"/)
  })

  test('the draft carries a minimal example of each shape, and it is the shape validation reads', async () => {
    const draft = buildDraft({ doc: emptyAnswers(), detected: DETECTED })
    assert.deepEqual(draft.example, DRAFT_EXAMPLE)
    const [entry] = DRAFT_EXAMPLE.declarations.readme
    assert.ok(Array.isArray(entry.evidence) && entry.evidence.every((e) => typeof e === 'string'))
    assert.deepEqual(Object.keys(entry).sort(), ['checked', 'claim', 'evidence', 'rederive', 'truth'])
    // The example's declaration, pointed at a real line, passes validation unchanged.
    const ok = withDeclarations({ readme: [{ ...entry, claim: 'Requires macOS 14 or later', evidence: ['README.md:5'] }] })
    assert.deepEqual(await validate(ok), [])
  })
})

describe('evidence that is the wrong shape says what the shape is', () => {
  test('POSITIVE CONTROL: a string where the array belongs is named as such, with an example', async () => {
    const errors = await validate(withDeclarations({ readme: [claim({ evidence: 'README.md:4' })] }))
    assert.equal(errors.length, 1)
    assert.match(errors[0], /declarations\.readme\[0\]: "evidence" must be an array of strings, for example \["README\.md:127"\]/)
  })

  test('POSITIVE CONTROL: a declaration with no evidence is told to supply an array, not just "name the file"', async () => {
    const errors = await validate(withDeclarations({ readme: [claim({ evidence: undefined })] }))
    assert.match(errors.join('\n'), /name the file and line that holds this claim, as "evidence": \["README\.md:127"\]/)
  })

  test('a string for a question\'s or a note\'s evidence is named the same way', async () => {
    const draft = withDeclarations({})
    Object.assign(draft.questions.find((q) => q.id === 'outside.claims'), { evidence: 'README.md:5' })
    assert.match((await validate(draft)).join('\n'), /outside\.claims: "evidence" must be an array of strings/)
    const noted = withDeclarations({})
    Object.assign(noted.questions.find((q) => q.id === 'authority.cannot'), { answer: ['hardware'], evidence: ['README.md:5'] })
    noted.notes = { hardware: { reason: 'x', evidence: 'README.md:5' } }
    assert.match((await validate(noted)).join('\n'), /notes\.hardware: "evidence" must be an array of strings/)
  })
})

describe('evidence is checked down to the line', () => {
  test('POSITIVE CONTROL: a line past the end of the file is an error that says how long the file is', async () => {
    const errors = await validate(withDeclarations({ readme: [claim({ evidence: ['README.md:400'] })] }))
    assert.match(errors.join('\n'), /evidence "README\.md:400" names line 400, but README\.md has 5 lines/)
  })

  test('POSITIVE CONTROL: a file that does not exist is still an error, and line 0 is impossible', async () => {
    assert.match((await validate(withDeclarations({ readme: [claim({ evidence: ['docs/NOPE.md:3'] })] }))).join('\n'), /names a file that does not exist here/)
    assert.match((await validate(withDeclarations({ readme: [claim({ evidence: ['README.md:0'] })] }))).join('\n'), /impossible line range/)
  })

  test('the last real line is a line; a path alone and a command stay valid', async () => {
    assert.deepEqual(await validate(withDeclarations({ readme: [claim({ claim: 'Requires macOS 14', evidence: ['README.md:5', 'README.md', 'command: head README.md'] })] })), [])
  })
})

describe('evidence that exists but cannot support the claim is a warning, not an error', () => {
  test('POSITIVE CONTROL: a blank cited line is warned about and does not block validation', async () => {
    const draft = withDeclarations({ readme: [claim({ evidence: ['README.md:3'] })] })
    assert.deepEqual(await validate(draft), [], 'a warning is not an error')
    const w = await warnings(draft)
    assert.equal(w.length, 1)
    assert.match(w[0], /declarations\.readme\[0\]: evidence "README\.md:3" is a blank line/)
  })

  test('POSITIVE CONTROL: a line that shares no meaningful word with the claim is warned about, quoting the line', async () => {
    const w = await warnings(withDeclarations({ readme: [claim({ claim: 'Ships a Windows installer', evidence: ['README.md:5'] })] }))
    assert.equal(w.length, 1)
    assert.match(w[0], /shares no meaningful word with the claim "Ships a Windows installer"; the cited line reads "Requires macOS 14 or later\."/)
  })

  test('a line that states the claim, in other words or numbers, raises nothing', async () => {
    assert.deepEqual(await warnings(withDeclarations({ readme: [claim({ evidence: ['README.md:4'] })] })), [])
    assert.deepEqual(await warnings(withDeclarations({ readme: [claim({ claim: 'Needs macOS 14', evidence: ['README.md:5'] })] })), [])
  })

  test('POSITIVE CONTROL: a free-text answer is checked against its cited line too; an option answer is not', async () => {
    const draft = buildDraft({ doc: emptyAnswers(), detected: DETECTED })
    Object.assign(draft.questions.find((q) => q.id === 'authority.human_proof'), { answer: 'A Windows installer is signed by hand', evidence: ['README.md:5'] })
    const w = await warnings(draft)
    assert.equal(w.length, 1)
    assert.match(w[0], /authority\.human_proof: evidence "README\.md:5" shares no meaningful word/)
    Object.assign(draft.questions.find((q) => q.id === 'authority.human_proof'), { answer: 'Runs on macOS 14 by hand', evidence: ['README.md:5'] })
    assert.deepEqual(await warnings(draft), [], 'a line that says it passes')
  })

  test('a range of only blank lines is warned about; a path alone is checked against the whole file', async () => {
    await writeFile(join(root, 'blank.md'), '\n\n\n', 'utf8')
    const w = await warnings(withDeclarations({ readme: [claim({ evidence: ['blank.md:1-3'] }), claim({ claim: 'Ships a Windows installer', evidence: ['README.md'] })] }))
    assert.match(w[0], /evidence "blank\.md:1-3" is only blank lines/)
    assert.match(w[1], /evidence "README\.md" shares no meaningful word/)
  })

  test('a human\'s chat answer and a command are never warned about', async () => {
    const draft = withDeclarations({ readme: [claim({ evidence: ['command: grep -c test README.md'] })] })
    assert.deepEqual(await warnings(draft), [])
  })
})

describe('the warnings reach the person confirming', () => {
  const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: root, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
    child.stdin.end('')
  })

  test('POSITIVE CONTROL: --from-draft --dry-run prints a blank-line citation under "Before confirming, check" and still proceeds', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root })
    const draft = withDeclarations({ readme: [claim({ evidence: ['README.md:3'] })] })
    await mkdir(join(root, '.caselaw'), { recursive: true })
    await writeFile(join(root, '.caselaw/draft.json'), JSON.stringify(draft), 'utf8')
    const r = await run(['init', '--from-draft', '--dry-run'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /Before confirming, check:\n  - declarations\.readme\[0\]: evidence "README\.md:3" is a blank line/)
  })

  test('POSITIVE CONTROL: a citation past the end of the file stops --from-draft, with the file\'s length', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root })
    const draft = withDeclarations({ readme: [claim({ evidence: ['README.md:900'] })] })
    await mkdir(join(root, '.caselaw'), { recursive: true })
    await writeFile(join(root, '.caselaw/draft.json'), JSON.stringify(draft), 'utf8')
    const r = await run(['init', '--from-draft', '--dry-run'])
    assert.equal(r.code, 1)
    assert.match(r.out, /names line 900, but README\.md has 5 lines/)
  })
})

describe('local gates reach the draft', () => {
  const gate = { dir: 'scripts/hooks', hooks: ['pre-push'], files: ['scripts/hooks/pre-push'], wiring: 'git config core.hooksPath scripts/hooks', documentedIn: 'README.md:5', wired: false }

  test('POSITIVE CONTROL: a repo with a documented pre-push hook and no CI still gets an agent_reach suggestion naming the hook and its source', async () => {
    await mkdir(join(root, 'scripts/hooks'), { recursive: true })
    await writeFile(join(root, 'scripts/hooks/pre-push'), '#!/bin/sh\n', 'utf8')
    const detected = { ...DETECTED, hooks: { localGates: [gate] } }
    const draft = buildDraft({ doc: emptyAnswers(), detected })
    const reach = draft.questions.find((q) => q.id === 'authority.agent_reach')
    assert.match(reach.answer, /ships local git hooks: scripts\/hooks\/pre-push \(enabled with `git config core\.hooksPath scripts\/hooks`; not enabled in this clone\)/)
    assert.deepEqual(reach.evidence, ['README.md:5', 'scripts/hooks/pre-push'])
    assert.deepEqual(draft.detected.localGates, [gate])
    assert.deepEqual(await validateDraft(draft, { root, detected }), [])
  })

  test('without local gates the suggestion reads exactly as before', () => {
    const detected = { ...DETECTED, commands: { test: { cmd: 'pytest', source: 'pyproject.toml:[tool.pytest.ini_options]' } } }
    const reach = buildDraft({ doc: emptyAnswers(), detected }).questions.find((q) => q.id === 'authority.agent_reach')
    assert.equal(reach.answer, 'The repository declares these verification commands: pytest. Their execution and coverage still need to be verified locally.')
  })
})
