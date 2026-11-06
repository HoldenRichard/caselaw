import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { promote, save, load } from '../../src/core/gates.js'
import { withMutationLock } from '../../src/core/safe-write.js'
import { cmdRule } from '../../src/commands/rule.js'
import { ratify, stageEvolution, propose, reject, parseRule, demote, adopt } from '../../src/core/rules.js'
import { applyProposal } from '../../src/core/optimizer.js'
import { runSteps } from '../../src/detect/ci-gates.js'

const roots = []
async function setup() { const root = await fs.mkdtemp(join(tmpdir(), 'caselaw-astra-')); roots.push(root); return root }
async function put(root, path, text) { await fs.mkdir(join(root,path,'..'), {recursive:true}); await fs.writeFile(join(root,path),text) }
const raw = (name, body = 'Require review.') => `# ${name}\n\n**Trigger:** editing source\n\n**Rule:** ${body}\n\n**Origin:** issue #123\n\n**Enforcement:** memory\n`
const human = {interactive:true, ratifiedBy:'Human', resolveRef:()=>true}
const io = root => ({root, interactive:true, say(){}})
afterEach(async () => { await Promise.all(roots.splice(0).map(p=>fs.rm(p,{recursive:true,force:true}))) })

test('POSITIVE CONTROL: gate promotion excludes competing config writers and preserves later registration', {timeout:5000}, async t => {
  const root=await setup()
  await save(root,{version:1,gates:[{id:'old',severity:'warn'}]})
  const original=fs.readFile
  let entered,release
  const reached=new Promise(r=>{entered=r}), resume=new Promise(r=>{release=r})
  fs.readFile=async (...args)=>{
    if(String(args[0]).endsWith('gate-fires.jsonl')) { entered(); await resume }
    return original(...args)
  }
  syncBuiltinESMExports()
  t.after(()=>{ release();fs.readFile=original;syncBuiltinESMExports() })
  const promoting=promote(root,'old',{force:true})
  await reached
  await assert.rejects(withMutationLock(root,async()=>{throw new Error('must not enter')}),/mutation is in progress/)
  release();await promoting
  fs.readFile=original;syncBuiltinESMExports()
  await withMutationLock(root,async()=>{const c=await load(root);c.gates.push({id:'new',severity:'warn'});await save(root,c)})
  await promote(root,'new',{force:true})
  assert.deepEqual((await load(root)).gates.map(g=>[g.id,g.severity]),[['old','block'],['new','block']])
})

test('POSITIVE CONTROL: demotion confirmation cannot apply to a newly ratified revision', async()=>{
  const root=await setup(), old=raw('guard'), next=raw('guard','Require additional approval.')
  await put(root,'docs/rules/active/guard.md',old)
  await stageEvolution(root,'guard',next,old)
  const code=await cmdRule({sub:'demote',name:'guard',opt:{}},{...io(root),prompt:()=>({confirm:async()=>{await ratify(root,'guard',human);return true},close:async()=>{}})})
  assert.equal(code,1)
  assert.match(await fs.readFile(join(root,'docs/rules/active/guard.md'),'utf8'),/additional approval/)
  await assert.rejects(fs.stat(join(root,'docs/rules/candidates/guard.md')),{code:'ENOENT'})
})

test('POSITIVE CONTROL: rejection confirmation cannot reject a replacement proposal', async()=>{
  const root=await setup(); await put(root,'docs/rules/proposed/guard.md',raw('guard'))
  const code=await cmdRule({sub:'reject',name:'guard',opt:{}},{...io(root),prompt:()=>({confirm:async()=>{await propose(root,{name:'guard',trigger:'editing source',rule:'New revision.',origin:'issue #456',enforcement:'memory'},{overwrite:true});return true},close:async()=>{}})})
  assert.equal(code,1)
  assert.match(await fs.readFile(join(root,'docs/rules/proposed/guard.md'),'utf8'),/New revision/)
})

test('POSITIVE CONTROL: rejecting malformed duplicate sections archives the exact original bytes',async()=>{
  const root=await setup(), text=raw('guard')+'\n**Rule:** Second distinct evidence.\n\n<!-- retained comment -->\n'
  await put(root,'docs/rules/proposed/guard.md',text)
  await reject(root,'guard',human)
  const names=await fs.readdir(join(root,'docs/rules/archive'))
  const archive=await fs.readFile(join(root,'docs/rules/archive',names[0]),'utf8')
  assert.equal(archive.slice(0,text.length),text)
  assert.match(archive,/Disposition/)
})

test('POSITIVE CONTROL: overwriting malformed drafts preserves their exact original bytes',async()=>{
  const root=await setup(), text=raw('guard')+'\n**Rule:** Second evidence.\n'
  await put(root,'docs/rules/proposed/guard.md',text)
  await propose(root,{name:'guard',trigger:'editing source',rule:'Replacement.',origin:'issue #456',enforcement:'memory'},{overwrite:true})
  const names=await fs.readdir(join(root,'docs/rules/archive'))
  assert.equal((await fs.readFile(join(root,'docs/rules/archive',names[0]),'utf8')).slice(0,text.length),text)
})

test('POSITIVE CONTROL: repeated merges preserve historical parents without executing them again',async()=>{
  const root=await setup()
  for(const n of ['alpha','beta','gamma']) await put(root,`docs/rules/active/${n}.md`,raw(n,`Require ${n}.`))
  await applyProposal({root,doc:{},id:'merge:alpha+beta',name:'first'})
  await ratify(root,'first',human)
  const before=await fs.readFile(join(root,'docs/rules/active/first.md'),'utf8')
  await stageEvolution(root,'first',before.replace('Require alpha.', 'Require alpha carefully.'),before)
  await ratify(root,'first',human)
  await applyProposal({root,doc:{},id:'merge:first+gamma',name:'second'})
  await ratify(root,'second',human)
  const parsed=parseRule(await fs.readFile(join(root,'docs/rules/active/second.md'),'utf8'))
  assert.equal(parsed.extras.find(x=>x.key==='merges').value,'first, gamma')
  assert.equal(parsed.extras.find(x=>x.key==='merge-history').value,'alpha, beta')
  const archive=await fs.readdir(join(root,'docs/rules/archive'))
  for(const n of ['alpha.md','beta.md','first.md','gamma.md']) assert.ok(archive.includes(n))
})

test('POSITIVE CONTROL: literal shell continuations preserve token joins, indentation and escaped slashes',()=>{
  const workflow=['jobs:','  test:','    steps:','      - run: |','          printf "%s" test:\\','          unit','          printf "%s" \\','            spaced','          printf "%s" "# inside"'].join('\n')
  const steps=runSteps(workflow)
  assert.equal(steps[0].cmd,'printf "%s" test:unit')
  assert.equal(steps[1].cmd,'printf "%s"   spaced')
  assert.equal(steps[2].cmd,'printf "%s" "# inside"')
  for(const cmd of steps.map(s=>s.cmd)) assert.doesNotThrow(()=>execFileSync('sh',['-c',cmd]))
  const doubled=['jobs:','  test:','    steps:','      - run: |','          printf "%s" \\\\','          printf next'].join('\n')
  assert.equal(runSteps(doubled).length,2)
})


test('POSITIVE CONTROL: merge refuses a parent promoted while approval is pending', async()=>{
  const root=await setup()
  for(const n of ['alpha','beta']) await put(root,`docs/rules/active/${n}.md`,raw(n,`Require ${n}.`))
  await put(root,'.caselaw/bin/gate.mjs',await fs.readFile(new URL('../../runtime/gate.mjs',import.meta.url)))
  await applyProposal({root,doc:{},id:'merge:alpha+beta',name:'joined'})
  const code=await cmdRule({sub:'ratify',name:'joined',opt:{by:'Human'}},{...io(root),prompt:()=>({confirm:async()=>{
    assert.equal(await cmdRule({sub:'promote',name:'beta',yes:true,opt:{kind:'banned-content',paths:'src/**/*.js',patterns:'forbidden',message:'Reject forbidden.'}},io(root)),0)
    return true
  },close:async()=>{}})})
  assert.equal(code,1)
  assert.match(await fs.readFile(join(root,'docs/rules/active/beta.md'),'utf8'),/machine:/)
  await assert.rejects(fs.stat(join(root,'docs/rules/active/joined.md')),{code:'ENOENT'})
})

test('POSITIVE CONTROL: a merged and evolved rule can be demoted, readopted and ratified', async()=>{
  const root=await setup()
  for(const n of ['alpha','beta']) await put(root,`docs/rules/active/${n}.md`,raw(n,`Require ${n}.`))
  await applyProposal({root,doc:{},id:'merge:alpha+beta',name:'joined'});await ratify(root,'joined',human)
  const before=await fs.readFile(join(root,'docs/rules/active/joined.md'),'utf8')
  await stageEvolution(root,'joined',before.replace('Require alpha.','Require alpha carefully.'),before);await ratify(root,'joined',human)
  await demote(root,'joined',{interactive:true})
  await adopt(root,'joined',{origin:'issue #789'})
  await ratify(root,'joined',human)
  const text=await fs.readFile(join(root,'docs/rules/active/joined.md'),'utf8')
  const parsed=parseRule(text)
  assert.ok(!parsed.extras.some(x=>['merges','replaces','base-hash','merge-base-hashes'].includes(x.key)))
  assert.match(text,/Merge-History/)
})

test('POSITIVE CONTROL: generated-rule demotions serialize selection bookkeeping', {timeout:5000}, async t=>{
  const root=await setup(), names=['re-derive-claims','seen-to-fail']
  for(const n of names) await put(root,`docs/rules/active/${n}.md`,raw(n))
  await put(root,'.caselaw/answers.json',JSON.stringify({schemaVersion:1,answers:{'harness.defaults':['D1','D2']}}))
  const original=fs.readFile;let entered,release
  const reached=new Promise(r=>{entered=r}),resume=new Promise(r=>{release=r})
  fs.readFile=async(...args)=>{const result=await original(...args);if(String(args[0]).endsWith('/answers.json')) {entered();await resume};return result};syncBuiltinESMExports()
  t.after(()=>{release();fs.readFile=original;syncBuiltinESMExports()})
  const first=cmdRule({sub:'demote',name:names[0],yes:true,opt:{}},io(root))
  await reached
  await assert.rejects(cmdRule({sub:'demote',name:names[1],yes:true,opt:{}},io(root)),/mutation is in progress/)
  release();assert.equal(await first,0)
  fs.readFile=original;syncBuiltinESMExports()
  assert.equal(await cmdRule({sub:'demote',name:names[1],yes:true,opt:{}},io(root)),0)
  assert.deepEqual(JSON.parse(await fs.readFile(join(root,'.caselaw/answers.json'),'utf8')).answers['harness.defaults'],[])
})

test('POSITIVE CONTROL: a comment ending in backslash cannot hide the next physical shell command',()=>{
  for(const comment of ['# comment', 'printf first # comment']) {
    const lines=['jobs:','  test:','    steps:','      - run: |','          '+comment+String.fromCharCode(92),'          printf "%s" checked']
    const steps=runSteps(lines.join('\n'))
    assert.ok(steps.some(x=>x.cmd==='printf "%s" checked'))
    assert.match(execFileSync('sh',['-c',lines.slice(4).map(x=>x.slice(10)).join('\n')],{encoding:'utf8'}),/checked/)
  }
})

test('POSITIVE CONTROL: invalid UTF-8 drafts are refused without changing original bytes',async()=>{
  const root=await setup(), path=join(root,'docs/rules/proposed/guard.md')
  const bytes=Buffer.concat([Buffer.from(raw('guard')+'caf'),Buffer.from([0xe9,13,10])])
  await put(root,'docs/rules/proposed/guard.md',bytes)
  await assert.rejects(reject(root,'guard',human),/not valid UTF-8/)
  assert.deepEqual(await fs.readFile(path),bytes)
  await assert.rejects(propose(root,{name:'guard',trigger:'editing source',rule:'New.',origin:'issue #456',enforcement:'memory'},{overwrite:true}),/not valid UTF-8/)
  assert.deepEqual(await fs.readFile(path),bytes)
})
