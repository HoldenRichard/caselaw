import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { propose, stageEvolution, ratify, demote, recordCatch, reject, adopt, parseRule } from '../../src/core/rules.js'
import { writeExclusive, withMutationLock } from '../../src/core/safe-write.js'
import { applyProposal } from '../../src/core/optimizer.js'
import { cmdRule } from '../../src/commands/rule.js'
import { hash } from '../../src/core/text.js'

const roots = []
const original = { writeFile: fs.writeFile, link: fs.link, rename: fs.rename }
const human = { interactive: true, ratifiedBy: 'Test Human', resolveRef: () => true }
const make = (name = 'guard', rule = 'Never sweep.') => `# ${name}\n\n**Trigger:** editing source files\n\n**Rule:** ${rule}\n\n**Origin:** issue #123\n\n**Enforcement:** memory\n`
const activePath = root => join(root, 'docs/rules/active/guard.md')
const proposedPath = root => join(root, 'docs/rules/proposed/guard.md')
async function setup(active = true) {
  const root = await fs.mkdtemp(join(tmpdir(), 'caselaw-transition-races-'))
  roots.push(root)
  const text = make()
  if (active) await put(root, 'docs/rules/active/guard.md', text)
  return { root, text, candidate: text.replace('Never sweep.', 'Never sweep; require human review.') }
}
async function put(root, rel, text) {
  const path = join(root, rel)
  await fs.mkdir(dirname(path), { recursive: true })
  await original.writeFile(path, text)
  return path
}
async function absent(path) { await assert.rejects(fs.stat(path), { code: 'ENOENT' }) }
function patch(t, method, fn) {
  fs[method] = fn
  syncBuiltinESMExports()
  t.after(() => { fs[method] = original[method]; syncBuiltinESMExports() })
}
function pause(t, method, matches) {
  let entered, release
  const reached = new Promise(resolve => { entered = resolve })
  const resume = new Promise(resolve => { release = resolve })
  patch(t, method, async (...args) => {
    const result = await original[method](...args)
    if (matches(...args)) { entered(); await resume }
    return result
  })
  t.after(() => release())
  return { reached, release }
}
afterEach(async () => {
  Object.assign(fs, original)
  syncBuiltinESMExports()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

test('demotion excludes ratification until its old source has been removed', { timeout: 5000 }, async t => {
  const { root, text, candidate } = await setup()
  await stageEvolution(root, 'guard', candidate, text)
  const destination = join(root, 'docs/rules/candidates/guard.md')
  const blocked = pause(t, 'link', (_, to) => to === destination)
  const moving = demote(root, 'guard', { interactive: true, reason: 'review old rule' })
  await blocked.reached
  await assert.rejects(ratify(root, 'guard', human), /mutation is in progress/)
  assert.equal(await fs.readFile(activePath(root), 'utf8'), text)
  blocked.release()
  await moving
  await absent(activePath(root))
  assert.equal(parseRule(await fs.readFile(destination, 'utf8')).rule, 'Never sweep.')
  assert.match(await fs.readFile(proposedPath(root), 'utf8'), /require human review/)
})

test('demotion preserves both copies if its source changes before removal', { timeout: 5000 }, async t => {
  const { root, candidate } = await setup()
  const destination = join(root, 'docs/rules/candidates/guard.md')
  const blocked = pause(t, 'link', (_, to) => to === destination)
  const moving = demote(root, 'guard', { interactive: true })
  const rejected = assert.rejects(moving, { code: 'STALE_PROPOSAL' })
  await blocked.reached
  await original.writeFile(activePath(root), candidate)
  blocked.release()
  await rejected
  assert.equal(await fs.readFile(activePath(root), 'utf8'), candidate)
  assert.equal(parseRule(await fs.readFile(destination, 'utf8')).rule, 'Never sweep.')
})

test('ratification excludes catch and demote throughout replacement archival', { timeout: 5000 }, async t => {
  const { root, text, candidate } = await setup()
  await stageEvolution(root, 'guard', candidate, text)
  const blocked = pause(t, 'link', (_, to) => dirname(to) === join(root, 'docs/rules/archive'))
  const changing = ratify(root, 'guard', human)
  await blocked.reached
  await assert.rejects(recordCatch(root, 'guard', { what: 'issue #456: caught' }), /mutation is in progress/)
  await assert.rejects(demote(root, 'guard', { interactive: true }), /mutation is in progress/)
  blocked.release()
  await changing
  assert.match(await fs.readFile(activePath(root), 'utf8'), /require human review/)
  await recordCatch(root, 'guard', { what: 'issue #456: caught' })
  assert.match(await fs.readFile(join(root, '.caselaw/catches.jsonl'), 'utf8'), /#456/)
})

test('first catch holds the shared lock while it adds local Origin', { timeout: 5000 }, async t => {
  const { root, text, candidate } = await setup()
  const defaultText = text.replace('**Origin:** issue #123', '**Precedent:** issue #123')
  await original.writeFile(activePath(root), defaultText)
  await stageEvolution(root, 'guard', candidate, defaultText)
  const blocked = pause(t, 'rename', (_, to) => to === activePath(root))
  const catching = recordCatch(root, 'guard', { what: 'issue #456: first local catch' })
  await blocked.reached
  await assert.rejects(ratify(root, 'guard', human), /mutation is in progress/)
  blocked.release()
  await catching
  await assert.rejects(ratify(root, 'guard', human), { code: 'STALE_PROPOSAL' })
  assert.match(parseRule(await fs.readFile(activePath(root), 'utf8')).origin, /#456/)
  assert.match(await fs.readFile(join(root, '.caselaw/catches.jsonl'), 'utf8'), /#456/)
})

async function promotionFixture(root) {
  const runtime = fileURLToPath(new URL('../../runtime/gate.mjs', import.meta.url))
  await put(root, '.caselaw/bin/gate.mjs', `export * from ${JSON.stringify(new URL('file://' + runtime).href)}\n`)
  return { sub: 'promote', name: 'guard', yes: true, opt: { kind: 'banned-content', paths: 'src/**/*.js', patterns: 'console.log', message: 'Remove console logging.' } }
}
const io = root => ({ root, interactive: true, say() {}, prompt() { throw new Error('Unexpected prompt') } })

test('promotion holds the shared lock while saving enforcement', { timeout: 5000 }, async t => {
  const { root, text, candidate } = await setup()
  const args = await promotionFixture(root)
  await stageEvolution(root, 'guard', candidate, text)
  const blocked = pause(t, 'rename', (_, to) => to === activePath(root))
  const promoting = cmdRule(args, io(root))
  await blocked.reached
  await assert.rejects(ratify(root, 'guard', human), /mutation is in progress/)
  await assert.rejects(recordCatch(root, 'guard', { what: 'issue #456: caught' }), /mutation is in progress/)
  blocked.release()
  assert.equal(await promoting, 0)
  assert.match(parseRule(await fs.readFile(activePath(root), 'utf8')).enforcement, /^machine:/)
  await assert.rejects(ratify(root, 'guard', human), { code: 'STALE_PROPOSAL' })
})

test('promotion refuses a rule changed during human confirmation', async () => {
  const { root, candidate } = await setup()
  const args = await promotionFixture(root)
  args.yes = false
  const messages = []
  const code = await cmdRule(args, { ...io(root), say: text => messages.push(text), prompt: () => ({
    confirm: async () => { await original.writeFile(activePath(root), candidate); return true }, close: async () => {},
  }) })
  assert.equal(code, 1)
  assert.ok(messages.some(text => text.includes('Rule changed during promotion')))
  assert.equal(await fs.readFile(activePath(root), 'utf8'), candidate)
  await absent(join(root, '.caselaw/gates.json'))
})

test('CLI ratification rejects a proposal swapped during confirmation', async () => {
  const { root } = await setup(false)
  const fields = { name: 'guard', trigger: 'editing source files', rule: 'Require review before writes.', origin: 'issue #123', enforcement: 'memory' }
  await propose(root, fields)
  const shown = []
  const code = await cmdRule({ sub: 'ratify', name: 'guard', opt: { by: 'Test Human' } }, {
    ...io(root), say: text => shown.push(text), prompt: () => ({
      confirm: async () => { await propose(root, { ...fields, rule: 'Skip review before writes.' }, { overwrite: true }); return true },
      close: async () => {},
    }),
  })
  assert.equal(code, 1)
  assert.ok(shown.some(text => text.includes('Require review before writes.')))
  assert.ok(shown.some(text => text.includes('proposal changed after it was displayed')))
  await absent(activePath(root))
  assert.equal(parseRule(await fs.readFile(proposedPath(root), 'utf8')).rule, 'Skip review before writes.')
  const archives = await fs.readdir(join(root, 'docs/rules/archive'))
  assert.match(await fs.readFile(join(root, 'docs/rules/archive', archives[0]), 'utf8'), /Require review before writes/)
})

test('matching displayed digest ratifies; a mismatch preserves the proposal', async () => {
  const { root } = await setup(false)
  const draft = await put(root, 'docs/rules/proposed/guard.md', make())
  const text = await fs.readFile(draft, 'utf8')
  await assert.rejects(ratify(root, 'guard', { ...human, expectedHash: hash('other') }), { code: 'STALE_PROPOSAL' })
  assert.equal(await fs.readFile(draft, 'utf8'), text)
  await absent(activePath(root))
  await ratify(root, 'guard', { ...human, expectedHash: hash(text) })
  assert.equal(parseRule(await fs.readFile(activePath(root), 'utf8')).rule, 'Never sweep.')
})

test('short write never publishes partial active law and ratification can retry', async t => {
  const { root } = await setup(false)
  const text = make()
  await put(root, 'docs/rules/proposed/guard.md', text)
  patch(t, 'writeFile', async (path, data, options) => {
    if (dirname(path) === dirname(activePath(root)) && basename(path).startsWith('.caselaw-write-')) {
      await original.writeFile(path, data.slice(0, 40), options)
      throw Object.assign(new Error('injected short write'), { code: 'ENOSPC' })
    }
    return original.writeFile(path, data, options)
  })
  await assert.rejects(ratify(root, 'guard', human), { code: 'ENOSPC' })
  await absent(activePath(root))
  assert.equal(await fs.readFile(proposedPath(root), 'utf8'), text)
  assert.deepEqual(await fs.readdir(dirname(activePath(root))), [])
  fs.writeFile = original.writeFile; syncBuiltinESMExports()
  await ratify(root, 'guard', human)
  assert.equal(parseRule(await fs.readFile(activePath(root), 'utf8')).rule, 'Never sweep.')
})

test('publication failure preserves demotion source and cleans temporary files', async t => {
  const { root, text } = await setup()
  patch(t, 'link', async () => { throw Object.assign(new Error('injected link failure'), { code: 'EIO' }) })
  await assert.rejects(demote(root, 'guard', { interactive: true }), { code: 'EIO' })
  assert.equal(await fs.readFile(activePath(root), 'utf8'), text)
  assert.deepEqual(await fs.readdir(join(root, 'docs/rules/candidates')), [])
  assert.equal(await withMutationLock(root, async () => 'released'), 'released')
})

test('replacement short write preserves active law and pending evidence', async t => {
  const { root, text, candidate } = await setup()
  const staged = await stageEvolution(root, 'guard', candidate, text)
  patch(t, 'writeFile', async (path, data, options) => {
    if (dirname(path) === dirname(activePath(root)) && basename(path).startsWith('.caselaw-write-')) {
      await original.writeFile(path, data.slice(0, 40), options)
      throw Object.assign(new Error('injected short write'), { code: 'ENOSPC' })
    }
    return original.writeFile(path, data, options)
  })
  await assert.rejects(ratify(root, 'guard', human), { code: 'ENOSPC' })
  assert.equal(await fs.readFile(activePath(root), 'utf8'), text)
  assert.equal(await fs.readFile(proposedPath(root), 'utf8'), staged.text)
  fs.writeFile = original.writeFile; syncBuiltinESMExports()
  await ratify(root, 'guard', human)
  assert.match(await fs.readFile(activePath(root), 'utf8'), /require human review/)
})

test('exclusive publication is invisible until complete and preserves conflicting targets', { timeout: 5000 }, async t => {
  const { root } = await setup(false)
  const path = join(root, 'evidence.md')
  const blocked = pause(t, 'writeFile', file => basename(file).startsWith('.caselaw-write-'))
  const writing = writeExclusive(path, 'complete evidence')
  await blocked.reached
  await absent(path)
  blocked.release()
  await writing
  await writeExclusive(path, 'complete evidence')
  await assert.rejects(writeExclusive(path, 'different evidence'), { code: 'EEXIST' })
  assert.equal(await fs.readFile(path, 'utf8'), 'complete evidence')
  assert.deepEqual(await fs.readdir(root), ['evidence.md'])
})

test('exclusive publication permits identical concurrent retries, rejects conflicts', async () => {
  const { root } = await setup(false)
  const path = join(root, 'evidence.md')
  await Promise.all([writeExclusive(path, 'evidence'), writeExclusive(path, 'evidence')])
  const results = await Promise.allSettled([writeExclusive(path, 'evidence'), writeExclusive(path, 'other')])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.equal(await fs.readFile(path, 'utf8'), 'evidence')
})

test('evolution retains historical merge evidence without re-running its parents', async () => {
  const { root } = await setup(false)
  await put(root, 'docs/rules/active/a.md', make('a'))
  await put(root, 'docs/rules/active/b.md', make('b', 'Never expose secrets.'))
  assert.equal((await applyProposal({ root, doc: {}, id: 'merge:a+b', name: 'joined' })).ok, true)
  await ratify(root, 'joined', human)
  const path = join(root, 'docs/rules/active/joined.md')
  const merged = await fs.readFile(path, 'utf8')
  const candidate = merged.replace('Never sweep.', 'Never sweep files.')
  await stageEvolution(root, 'joined', candidate, merged)
  const result = await ratify(root, 'joined', human)
  assert.deepEqual(result.merged, [])
  const parsed = parseRule(await fs.readFile(path, 'utf8'))
  assert.match(parsed.rule, /Never sweep files/)
  assert.equal(parsed.extras.find(x => x.key === 'merges').value, 'a, b')
  for (const parent of ['a', 'b']) {
    await absent(join(root, `docs/rules/active/${parent}.md`))
    assert.equal(parseRule(await fs.readFile(join(root, `docs/rules/archive/${parent}.md`), 'utf8')).name, parent)
  }
})


test('rejection excludes proposal overwrites and preserves an externally revised draft', { timeout: 5000 }, async t => {
  const { root, text, candidate } = await setup(false)
  await put(root, 'docs/rules/proposed/guard.md', text)
  await put(root, 'docs/rules/candidates/guard.md', text)
  const blocked = pause(t, 'link', (_, to) => dirname(to) === join(root, 'docs/rules/archive'))
  const rejecting = reject(root, 'guard', { interactive: true, reason: 'old draft rejected' })
  const rejected = assert.rejects(rejecting, { code: 'STALE_PROPOSAL' })
  await blocked.reached
  await assert.rejects(propose(root, { name: 'guard', trigger: 'editing source files', rule: 'New proposal.', origin: 'issue #456', enforcement: 'memory' }, { overwrite: true }), /mutation is in progress/)
  await assert.rejects(adopt(root, 'guard', { origin: 'issue #456', overwrite: true }), /mutation is in progress/)
  // Editors do not participate in our lock: retain their new revision too.
  await original.writeFile(proposedPath(root), candidate)
  blocked.release()
  await rejected
  assert.equal(await fs.readFile(proposedPath(root), 'utf8'), candidate)
  const archives = await fs.readdir(join(root, 'docs/rules/archive'))
  assert.equal(archives.length, 1)
  assert.equal(parseRule(await fs.readFile(join(root, 'docs/rules/archive', archives[0]), 'utf8')).rule, 'Never sweep.')
  assert.equal(await withMutationLock(root, async () => 'released'), 'released')
})
