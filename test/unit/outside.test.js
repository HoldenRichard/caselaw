/**
 * Session 2: who outside the repository can rule on it, and where it makes
 * public claims. Born from the study behind this tool: an app reviewer's
 * rulings did not state their basis and only the ones that did became rules;
 * and every public-claim failure (DEF-216, DEF-217, DEF-748) was caught only
 * by going back to the product.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { claimSurfaces } from '../../src/detect/signals.js'
import { gatekeeperCandidates, claimCandidates, SESSIONS } from '../../src/interview/questions.js'
import { buildModel as declarationsModel, generate as generateDeclarations, CLAIM_LABELS } from '../../src/generate/declarations.js'
import { generate as generateAuthoritySplit, OUTSIDE_LABELS } from '../../src/generate/authority-split.js'
import { buildArtifacts } from '../../src/generate/artifacts.js'
import { emptyAnswers } from '../../src/core/answers.js'

const docWith = (answers) => {
  const doc = emptyAnswers({ templateVersion: '1.1', project: { name: 'P' } })
  doc.generatedAt = '2026-10-30T00:00:00.000Z'
  Object.assign(doc.answers, answers)
  return doc
}

describe('where a project makes claims, from its files', () => {
  test('a README, a privacy policy, terms, a store listing and a docs site are found', () => {
    const found = claimSurfaces(['README.md', 'docs/PRIVACY.md', 'legal/terms-of-service.html', 'fastlane/metadata/en-US/description.txt', 'mkdocs.yml', 'src/terminal.md'])
    assert.deepEqual(found.map((c) => c.kind).sort(), ['docs-site', 'privacy-policy', 'readme', 'store-listing', 'terms'])
    assert.equal(found.find((c) => c.kind === 'privacy-policy').source, 'docs/PRIVACY.md', 'each surface names its file')
  })

  test('a README in a subproject, or a privacy file in an example, is not the project\'s own', () => {
    assert.deepEqual(claimSurfaces(['packages/a/README.md', 'examples/app/privacy.md']), [])
  })
})

describe('session 2 offers what detection supports', () => {
  test('POSITIVE CONTROL: an iOS app is offered app review, and a library with a registry the registry\'s policies', () => {
    assert.ok(gatekeeperCandidates({ stack: { languages: [{ name: 'Swift' }] } }).some((o) => o.value === 'app-review'))
    const lib = gatekeeperCandidates({ signals: { registries: [{ kind: 'npm' }] } }).map((o) => o.value)
    assert.ok(lib.includes('registry-policy'))
    assert.ok(!lib.includes('app-review'))
  })

  test('a person outside the team is always offered: judges, a client, a grader', () => {
    assert.ok(gatekeeperCandidates({}).some((o) => o.value === 'external-reviewer'))
  })

  test('a release pipeline alone is not a registry with policies', () => {
    assert.ok(!gatekeeperCandidates({ signals: { registries: [{ kind: 'goreleaser' }] } }).some((o) => o.value === 'registry-policy'))
  })

  test('claim surfaces are offered only where a file or a platform holds them', () => {
    assert.deepEqual(claimCandidates({}).map((o) => o.value), [])
    const v = claimCandidates({ signals: { claims: [{ kind: 'readme' }, { kind: 'privacy-policy' }] }, deploySurface: [{ kind: 'vercel' }] }).map((o) => o.value)
    assert.deepEqual(v, ['readme', 'privacy-policy', 'website'])
  })

  test('every value either list can offer has a label to render', () => {
    const everything = { stack: { languages: [{ name: 'Swift' }] }, deploySurface: [{ kind: 'fly' }],
      signals: { registries: [{ kind: 'npm' }], stores: [{ kind: 'extension-store' }, { kind: 'vscode-marketplace' }],
        claims: ['readme', 'privacy-policy', 'terms', 'store-listing', 'docs-site'].map((kind) => ({ kind })) } }
    for (const o of gatekeeperCandidates(everything)) assert.ok(OUTSIDE_LABELS[o.value], o.value)
    for (const o of claimCandidates(everything)) assert.ok(CLAIM_LABELS[o.value], o.value)
  })

  test('the session stays inside its budget', () => {
    assert.deepEqual(SESSIONS.find((s) => s.n === 2), { n: 2, key: 'outside', title: 'Outside authority', budget: 2, minutes: 1 })
  })
})

describe('what session 2 generates', () => {
  test('POSITIVE CONTROL: the authority split names the outside authorities and says what their rulings can and cannot become', async () => {
    const { content } = await generateAuthoritySplit({ answers: { 'outside.authority': ['app-review', 'hackathon judges'], 'outside.claims': ['readme'] }, projectName: 'P', now: new Date('2026-10-30') })
    assert.match(content, /## Outside authority/)
    assert.match(content, /\*\*an app store's review \(Apple App Review, Google Play\)\*\*/)
    assert.match(content, /\*\*hackathon judges\*\*/, 'free text is rendered as written')
    assert.match(content, /A ruling\s+that names its basis can become a rule/)
    assert.match(content, /docs\/declarations\.md/)
  })

  test('no outside authority named, no section', async () => {
    const { content } = await generateAuthoritySplit({ answers: {}, projectName: 'P', now: new Date('2026-10-30') })
    assert.doesNotMatch(content, /Outside authority/)
  })

  test('POSITIVE CONTROL: an unfilled declaration is a visible hole, never an invented claim', async () => {
    const { content } = await generateDeclarations({ answers: { 'outside.claims': ['readme'] }, detected: { signals: { claims: [{ kind: 'readme', source: 'README.md' }] } }, projectName: 'P' })
    assert.match(content, /\| the README \(`README\.md`\) \| _not recorded_ \| _not recorded_ \| _not recorded_ \| _not recorded_ \|/)
  })

  test('filled declarations become rows, one per claim, with pipes escaped', () => {
    const model = declarationsModel({
      answers: {
        'outside.claims': ['readme'],
        declarations: { readme: [
          { claim: 'Supports 12 instruments', truth: 'src/drivers/', rederive: 'ls src/drivers | wc -l', checked: '2026-10-30' },
          { claim: 'Free | no account', truth: 'pricing page', rederive: 'open the site', checked: '2026-10-01' },
        ] },
      },
    })
    assert.equal(model.rows.length, 2)
    assert.equal(model.rows[1].claim, 'Free \\| no account')
    assert.equal(model.rows[0].rederive, '`ls src/drivers \\| wc -l`')
  })

  test('the register exists only once someone has named where the project makes claims', async () => {
    const without = await buildArtifacts({ doc: docWith({}), detected: { agentConfig: { claudeMd: true }, commands: {}, deploySurface: [] } })
    assert.ok(!without.some((a) => a.path === 'docs/declarations.md'))
    const withClaims = await buildArtifacts({ doc: docWith({ 'outside.claims': ['readme'] }), detected: { agentConfig: { claudeMd: true }, commands: {}, deploySurface: [] } })
    assert.ok(withClaims.some((a) => a.path === 'docs/declarations.md'))
  })
})
