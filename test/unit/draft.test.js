/**
 * The agent's draft of the interview (DEF-274's second half). A drafted answer
 * is a claim: it must name its evidence, the evidence must exist, and nothing
 * is generated from a draft no human has confirmed.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { buildDraft, validateDraft, draftPrompt, applyDeclarations, applyNotes, quoteEvidence, draftSheet, DRAFT_PATH, UNKNOWN } from '../../src/interview/draft.js'
import { generate as generateAuthoritySplit } from '../../src/generate/authority-split.js'
import { emptyAnswers, SKIPPED } from '../../src/core/answers.js'
import { scriptedPrompt } from '../../src/interview/prompt.js'
import { runInterview } from '../../src/interview/runner.js'

const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url))

function cli(args, { cwd, input = '' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

let root
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'caselaw-draft-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const [k, v] of [['gc.auto', '0'], ['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false']]) {
    execFileSync('git', ['config', k, v], { cwd: root })
  }
  await writeFile(join(root, 'README.md'), '# Bench rig\n\nDrives the bench oscilloscope over GPIB.\n', 'utf8')
  await writeFile(join(root, 'pyproject.toml'), '[project]\n  name = "benchrig"\n  keywords = ["GPIB", "instrument"]\n', 'utf8')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'x'], { cwd: root })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const exists = async (rel) => { try { await stat(join(root, rel)); return true } catch { return false } }

const DETECTED = { stack: { languages: [{ name: 'Python', pct: 100 }] }, deploySurface: [], signals: { hardware: [{ signal: 'GPIB', source: 'pyproject.toml' }] } }

function fill(draft, answers) {
  for (const q of draft.questions) if (answers[q.id]) Object.assign(q, answers[q.id])
  return draft
}

const GOOD = {
  'authority.cannot': { answer: ['hardware'], evidence: ['README.md:3'] },
  'authority.triage': { answer: { hardware: 'physical' }, evidence: ['README.md:3'] },
  'authority.human_proof': { answer: 'Run the capture against the bench scope and compare the trace.', evidence: ['README.md'] },
  'authority.agent_reach': { answer: UNKNOWN },
}

describe('the draft', () => {
  test('carries every question, with options resolved against what detection found', () => {
    const draft = buildDraft({ doc: emptyAnswers(), detected: DETECTED })
    const cannot = draft.questions.find((q) => q.id === 'authority.cannot')
    assert.ok(cannot.options.some((o) => o.value === 'hardware'), 'the hardware signal reaches the agent as an option')
    assert.ok(draft.howToFill.some((l) => l.includes('Never guess')))
    assert.deepEqual(draft.detected.signals, DETECTED.signals)
  })

  test('an answer a human already gave is marked, and carried without needing evidence', async () => {
    const doc = emptyAnswers()
    doc.answers['authority.human_proof'] = 'by hand'
    const draft = buildDraft({ doc, detected: DETECTED })
    assert.equal(draft.questions.find((q) => q.id === 'authority.human_proof').alreadyAnswered, true)
    assert.deepEqual(await validateDraft(draft, { root, detected: DETECTED, doc }), [])
  })
})

describe('validating a filled draft', () => {
  const check = (answers) => validateDraft(fill(buildDraft({ doc: emptyAnswers(), detected: DETECTED }), answers), { root, detected: DETECTED })

  test('a draft whose every answer names real evidence holds up', async () => {
    assert.deepEqual(await check(GOOD), [])
  })

  test('POSITIVE CONTROL: an answer with no evidence is refused', async () => {
    const errors = await check({ ...GOOD, 'authority.human_proof': { answer: 'trust me', evidence: [] } })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /authority\.human_proof: an answer with no evidence/)
  })

  test('POSITIVE CONTROL: evidence naming a file that does not exist is refused', async () => {
    const errors = await check({ ...GOOD, 'authority.cannot': { answer: ['hardware'], evidence: ['docs/HARDWARE.md:12'] } })
    assert.match(errors.join('\n'), /"docs\/HARDWARE\.md:12" names a file that does not exist here/)
  })

  test('evidence outside the repository is refused; a command is accepted as evidence', async () => {
    const outside = await check({ ...GOOD, 'authority.human_proof': { answer: 'x', evidence: ['../secrets.txt'] } })
    assert.match(outside.join('\n'), /points outside the repository/)
    assert.deepEqual(await check({ ...GOOD, 'authority.human_proof': { answer: 'x', evidence: ['command: pytest -q'] } }), [])
  })

  test('a triage must classify only what was named, with the three known kinds', async () => {
    const errors = await check({ ...GOOD, 'authority.triage': { answer: { hardware: 'probably', deploy: 'chosen' }, evidence: ['README.md'] } })
    assert.match(errors.join('\n'), /hardware: probably, deploy: chosen/)
  })
})

describe('answering from the draft', () => {
  const filled = () => fill(buildDraft({ doc: emptyAnswers(), detected: DETECTED }), GOOD)

  test('POSITIVE CONTROL: with no human and no --yes, a drafted answer is not used', async () => {
    const p = draftPrompt(filled())
    assert.equal(await p.text({ id: 'authority.human_proof', prompt: 'x' }), SKIPPED)
    assert.deepEqual(p.provenance, {})
  })

  test('confirmed in chat (--yes): the drafted answers stand, each with its evidence recorded', async () => {
    const doc = emptyAnswers()
    const p = draftPrompt(filled(), { accept: true })
    await runInterview({ doc, detected: DETECTED, prompt: p, sessions: [1] })
    assert.deepEqual(doc.answers['authority.cannot'], ['hardware'])
    assert.deepEqual(doc.answers['authority.triage'], { hardware: 'physical' })
    assert.equal(p.provenance['authority.cannot'].confirmed, 'in chat (--yes)')
    assert.deepEqual(p.provenance['authority.human_proof'].evidence, ['README.md'])
    assert.ok(doc.unanswered.some((u) => u.id === 'authority.agent_reach'), '"?" becomes a visible gap')
  })

  test('at a terminal, each drafted answer is kept or replaced by the human', async () => {
    const human = scriptedPrompt(['keep', 'keep', 'change', 'Scope trace compared by hand.'])
    const doc = emptyAnswers()
    const p = draftPrompt(filled(), { confirmWith: human })
    await runInterview({ doc, detected: DETECTED, prompt: p, sessions: [1] })
    assert.equal(doc.answers['authority.human_proof'], 'Scope trace compared by hand.')
    assert.equal(p.provenance['authority.human_proof'].by, 'human')
    assert.equal(p.provenance['authority.cannot'].confirmed, 'at a terminal')
  })
})

describe('init --draft, then --from-draft', () => {
  test('POSITIVE CONTROL: without a terminal and without --yes, nothing is generated from the draft', async () => {
    assert.equal((await cli(['init', '--draft'], { cwd: root })).code, 0)
    const path = join(root, DRAFT_PATH)
    await writeFile(path, JSON.stringify(fill(JSON.parse(await readFile(path, 'utf8')), GOOD)), 'utf8')
    const r = await cli(['init', '--from-draft'], { cwd: root })
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /Nothing is generated from a draft no human has confirmed/)
    assert.equal(await exists('docs/authority-split.md'), false)
  })

  test('a draft that does not hold up is refused, and says why', async () => {
    await cli(['init', '--draft'], { cwd: root })
    const path = join(root, DRAFT_PATH)
    await writeFile(path, JSON.stringify(fill(JSON.parse(await readFile(path, 'utf8')), { ...GOOD, 'authority.human_proof': { answer: 'x', evidence: ['nope.md'] } })), 'utf8')
    const r = await cli(['init', '--from-draft', '--yes'], { cwd: root })
    assert.equal(r.code, 1)
    assert.match(r.out, /"nope\.md" names a file that does not exist here/)
    assert.equal(await exists('docs/authority-split.md'), false)
  })

  test('confirmed with --yes: the docs are generated, say where each answer came from, and the draft is removed', async () => {
    await cli(['init', '--draft'], { cwd: root })
    const path = join(root, DRAFT_PATH)
    const draft = JSON.parse(await readFile(path, 'utf8'))
    assert.ok(draft.questions.find((q) => q.id === 'authority.cannot').options.some((o) => o.value === 'hardware'))
    await writeFile(path, JSON.stringify(fill(draft, GOOD)), 'utf8')
    const r = await cli(['init', '--from-draft', '--yes'], { cwd: root })
    assert.equal(r.code, 0, r.out)
    const split = await readFile(join(root, 'docs/authority-split.md'), 'utf8')
    assert.match(split, /# Authority split — benchrig/)
    assert.match(split, /drive or observe the real hardware it talks to/)
    assert.match(split, /## Where these answers came from[\s\S]*\| What the agent cannot do \| agent draft \| `README\.md:3` \| in chat \(--yes\) \|/)
    const answers = JSON.parse(await readFile(join(root, '.caselaw/answers.json'), 'utf8'))
    assert.deepEqual(answers.provenance['authority.cannot'].evidence, ['README.md:3'])
    assert.equal(await exists(DRAFT_PATH), false)
  })

  test('drafted declarations reach the register, each claim with where its truth lives', async () => {
    await cli(['init', '--draft'], { cwd: root })
    const path = join(root, DRAFT_PATH)
    const draft = fill(JSON.parse(await readFile(path, 'utf8')), { ...GOOD, 'outside.claims': { answer: ['readme'], evidence: ['README.md'] } })
    draft.declarations = { readme: [{ claim: 'Drives the bench oscilloscope over GPIB', evidence: ['README.md:3'], truth: 'the instrument driver' }] }
    await writeFile(path, JSON.stringify(draft), 'utf8')
    const r = await cli(['init', '--from-draft', '--yes'], { cwd: root })
    assert.equal(r.code, 0, r.out)
    const register = await readFile(join(root, 'docs/declarations.md'), 'utf8')
    assert.match(register, /\| the README \(`README\.md`\) \| Drives the bench oscilloscope over GPIB \| the instrument driver \| _not recorded_ \| never \|/)
  })
})

describe('drafted declarations', () => {
  const withClaims = (declarations, claimsAnswer = ['readme']) => {
    const draft = fill(buildDraft({ doc: emptyAnswers(), detected: DETECTED }), { ...GOOD, 'outside.claims': { answer: claimsAnswer, evidence: ['README.md'] } })
    draft.declarations = declarations
    return draft
  }

  test('POSITIVE CONTROL: a claim with no line that holds it is refused', async () => {
    const errors = await validateDraft(withClaims({ readme: [{ claim: 'Fast' }] }), { root, detected: DETECTED })
    assert.match(errors.join('\n'), /declarations\.readme\[0\]: name the file and line that holds this claim/)
  })

  test('a declaration for a surface nobody named is refused', async () => {
    const errors = await validateDraft(withClaims({ website: [{ claim: 'x', evidence: ['README.md'] }] }), { root, detected: DETECTED })
    assert.match(errors.join('\n'), /declarations\.website: not one of the surfaces answered in outside\.claims/)
  })

  test('POSITIVE CONTROL: without a terminal or --yes, drafted declarations are not applied', async () => {
    const doc = emptyAnswers()
    const draft = withClaims({ readme: [{ claim: 'x', evidence: ['README.md'] }] })
    assert.equal(await applyDeclarations(draft, doc), null)
    assert.equal(doc.answers.declarations, undefined)
    const applied = await applyDeclarations(draft, doc, { accept: true })
    assert.deepEqual(doc.answers.declarations, { readme: [{ claim: 'x' }] }, 'evidence goes to provenance, not into the claim')
    assert.deepEqual(applied.evidence, ['README.md'])
  })
})

describe('the person confirming reads what an answer rests on', () => {
  test('POSITIVE CONTROL: at a terminal, the drafted answer is shown with the text of the line it cites', async () => {
    const notes = []
    const human = { ...scriptedPrompt(['keep']), note: (m) => notes.push(m) }
    const draft = fill(buildDraft({ doc: emptyAnswers(), detected: DETECTED }), GOOD)
    await draftPrompt(draft, { confirmWith: human, root }).multiselect({ id: 'authority.cannot', prompt: 'cannot?', options: [] })
    assert.match(notes.join('\n'), /README\.md:3  Drives the bench oscilloscope over GPIB\./)
  })

  test('a range is quoted up to three lines; a command or a bare path is shown as written', async () => {
    const lines = await quoteEvidence(root, ['README.md:1-3', 'command: pytest -q', 'pyproject.toml'])
    assert.deepEqual(lines, ['    README.md:1  # Bench rig', '    README.md:2  ', '    README.md:3  Drives the bench oscilloscope over GPIB.', '    command: pytest -q', '    pyproject.toml'])
  })

  test('the review sheet lists every drafted answer and declaration with its lines', async () => {
    const draft = fill(buildDraft({ doc: emptyAnswers(), detected: DETECTED }), GOOD)
    draft.declarations = { readme: [{ claim: 'Drives a scope', evidence: ['README.md:3'] }] }
    const sheet = (await draftSheet(root, draft)).join('\n')
    assert.match(sheet, /What does a human have to DO[\s\S]*Run the capture against the bench scope/)
    assert.match(sheet, /Declaration \(readme\): "Drives a scope"\n    README\.md:3  Drives the bench oscilloscope over GPIB\./)
    assert.match(sheet, /not known \(a visible gap\)/)
  })
})

describe('why an untested boundary is assumed', () => {
  const withNotes = (notes) => {
    const draft = fill(buildDraft({ doc: emptyAnswers(), detected: DETECTED }), { ...GOOD, 'authority.triage': { answer: { hardware: 'untested' }, evidence: ['README.md:3'] } })
    draft.notes = notes
    return draft
  }

  test('POSITIVE CONTROL: a drafted reason becomes the authority split\'s "assumed because", instead of "not recorded"', async () => {
    const doc = emptyAnswers()
    Object.assign(doc.answers, { 'authority.cannot': ['hardware'], 'authority.triage': { hardware: 'untested' } })
    applyNotes(withNotes({ hardware: { reason: 'the bench scope is in the lab, not on this machine', evidence: ['README.md:3'] } }), doc, { confirmed: 'in chat (--yes)' })
    const { content } = await generateAuthoritySplit({ answers: doc.answers, projectName: 'P', now: new Date('2026-10-30') })
    assert.match(content, /\| drive or observe the real hardware it talks to \| the bench scope is in the lab, not on this machine \|/)
  })

  test('a note for a boundary nobody named, or with no reason, is refused; unconfirmed notes are not applied', async () => {
    const errors = await validateDraft(withNotes({ deploy: { reason: 'x' }, hardware: {} }), { root, detected: DETECTED })
    assert.match(errors.join('\n'), /notes\.deploy: not one of the answers to authority\.cannot/)
    assert.match(errors.join('\n'), /notes\.hardware: a note needs its reason/)
    const doc = emptyAnswers()
    assert.equal(applyNotes(withNotes({ hardware: { reason: 'x' } }), doc, { confirmed: null }), null)
    assert.equal(doc.answers['authority.notes'], undefined)
  })
})
