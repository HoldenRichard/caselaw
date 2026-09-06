/**
 * The complete set of artifacts an install owns.
 *
 * One definition, used by every command: `init` writes it, `check` compares
 * against it, `upgrade` re-renders it, `eject` removes it. If this list ever
 * disagreed with itself between commands, `check` would report drift that
 * `upgrade` could not fix — so there is exactly one.
 */

import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { generate as generateAuthoritySplit } from './authority-split.js'
import { generate as generateCloseOut } from './close-out.js'
import { selectAdapters, commandCollisions } from '../adapters/index.js'
import { isoDate } from '../core/dates.js'
import { render } from '../render/engine.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const TEMPLATE_ROOT = join(HERE, '../../templates')
export const RUNTIME_ROOT = join(HERE, '../../runtime')

/** Every .md under templates/<sub>, relative to that directory. */
export async function templateFiles(sub) {
  const base = join(TEMPLATE_ROOT, sub)
  const out = []
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true, recursive: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const abs = join(entry.parentPath ?? entry.path, entry.name)
    out.push(abs.slice(base.length + 1))
  }
  return out.sort()
}

/** Which agent files this project already uses; CLAUDE.md if none. */
export function pointerTargets(detected) {
  return selectAdapters(detected).flatMap((a) => a.artifacts({ detected })).map((x) => x.path)
}

/**
 * PreToolUse blocks a bad write before it lands; PostToolUse runs the checks
 * that need the finished file. Both invoke the VENDORED runner, so the hooks
 * keep working with this CLI uninstalled.
 */
export function claudeHookSettings() {
  // $CLAUDE_PROJECT_DIR is the directory the session STARTED in and stays there
  // across a cd or a worktree (hooks reference) — right for locating the
  // runner, wrong for naming the root, so no --root is passed: the runner
  // finds the install that owns the file being written. The guard makes a
  // missing runner visible; node's own exit 1 on a missing module is shown to
  // no one on a hook, and the harness would be silently inert.
  const runner = '"$CLAUDE_PROJECT_DIR/.caselaw/bin/gate.mjs"'
  const cmd = (mode) =>
    `if [ -f ${runner} ]; then node ${runner} --mode ${mode} --host claude; ` +
    `else echo "{\\"systemMessage\\":\\"caselaw: gate runner not found at $CLAUDE_PROJECT_DIR/.caselaw/bin/gate.mjs; nothing was checked. Run caselaw doctor.\\"}"; fi`
  const entry = (mode) => ({
    // Exact-string list, not a regex (hooks reference): the write tools today
    // are Write, Edit and NotebookEdit. MultiEdit no longer exists.
    matcher: 'Edit|Write|NotebookEdit',
    hooks: [{ type: 'command', command: cmd(mode), timeout: 30 }],
  })
  return { hooks: { PreToolUse: [entry('pre')], PostToolUse: [entry('post')] } }
}

/**
 * Optional modules, off by default and enabled with `--with`.
 *
 * Each is a genuinely useful artifact and none is required for the harness to
 * work. Installing all of them by default would be the curated-corpus mistake:
 * volume standing in for fit, and four files nobody asked for teaching the
 * reader that this tool does not know what their project needs.
 */
export const MODULES = {
  decisions: {
    label: 'decision records (ADRs)',
    files: [
      { from: 'decisions/README.md', to: 'docs/decisions/README.md' },
      { from: 'decisions/_template.md', to: 'docs/decisions/_template.md' },
      { from: 'decisions/0001-adopt-caselaw.md', to: 'docs/decisions/0001-adopt-caselaw.md', templated: true },
    ],
  },
  glossary: {
    label: 'a project glossary',
    files: [{ from: 'glossary.md', to: 'docs/glossary.md' }],
  },
  'known-issues': {
    label: 'a tracked-debt list',
    files: [{ from: 'known-issues.md', to: 'docs/known-issues.md' }],
  },
}

export const EMPTY_GATES = {
  version: 1,
  $comment:
    'Empty on purpose. Gates are created by `caselaw rule promote <name>`, from a rule that earned one. See docs/rules/README.md.',
  gates: [],
}

/**
 * @param {{doc: object, detected: object}} input
 * @returns {Promise<Array<{path:string, kind:'file'|'block', body:string, blockId?:string, version?:number}>>}
 */
export async function buildArtifacts({ doc, detected, adapterIds = null, modules = doc.modules ?? [] }) {
  const out = []

  const authority = await generateAuthoritySplit({
    answers: doc.answers,
    detected,
    projectName: doc.project?.name,
    now: doc.generatedAt ? new Date(doc.generatedAt) : undefined,
  })
  out.push({ path: 'docs/authority-split.md', kind: 'file', body: authority.content })

  const closeOut = await generateCloseOut({
    answers: doc.answers, detected, projectName: doc.project?.name,
  })
  out.push({ path: 'docs/close-out.md', kind: 'file', body: closeOut.content })

  // Case-law scaffolding ships verbatim: machinery, never content.
  for (const rel of await templateFiles('rules')) {
    out.push({
      path: join('docs/rules', rel),
      kind: 'file',
      body: await readFile(join(TEMPLATE_ROOT, 'rules', rel), 'utf8'),
    })
  }

  // Each detected agent tool gets a pointer in its own idiom. The doctrine
  // itself is never duplicated into them — only the instruction to read it.
  const adapters = selectAdapters(detected, { only: adapterIds })
  for (const adapter of adapters) {
    out.push(...adapter.artifacts({ detected }))
  }
  const usesClaude = adapters.some((a) => a.id === 'claude-code')

  out.push({
    path: '.caselaw/bin/gate.mjs', kind: 'file',
    body: await readFile(join(RUNTIME_ROOT, 'gate.mjs'), 'utf8'),
  })
  out.push({
    path: '.caselaw/schema/gates.schema.json', kind: 'file',
    body: await readFile(join(RUNTIME_ROOT, 'schema/gates.schema.json'), 'utf8'),
  })
  out.push({
    path: '.caselaw/gates.json', kind: 'file',
    body: JSON.stringify(EMPTY_GATES, null, 2) + '\n',
  })

  if (usesClaude) {
    out.push({
      path: '.claude/settings.json', kind: 'file',
      body: JSON.stringify(claudeHookSettings(), null, 2) + '\n',
    })
    const commandFiles = await templateFiles('adapters/claude/commands')
    // A generated command that shadows a host built-in changes behaviour the
    // user never asked to change, and gives no clue why.
    const clashes = commandCollisions('claude-code', commandFiles)
    if (clashes.length) {
      throw new Error(
        `Generated command(s) would shadow Claude Code built-ins: ${clashes.join(', ')}. Rename them.`,
      )
    }
    for (const rel of commandFiles) {
      out.push({
        path: join('.claude/commands', rel), kind: 'file',
        body: await readFile(join(TEMPLATE_ROOT, 'adapters/claude/commands', rel), 'utf8'),
      })
    }
  }

  for (const id of modules) {
    const mod = MODULES[id]
    if (!mod) throw new Error(`Unknown module "${id}". Known: ${Object.keys(MODULES).join(', ')}`)
    for (const f of mod.files) {
      let body = await readFile(join(TEMPLATE_ROOT, 'modules', f.from), 'utf8')
      if (f.templated) {
        body = render(body, { today: isoDate(doc.generatedAt ? new Date(doc.generatedAt) : new Date()) })
      }
      out.push({ path: f.to, kind: 'file', body })
    }
  }

  out.push({
    path: '.gitignore', kind: 'block', blockId: 'caselaw', version: 1,
    body: ['# Local gate telemetry — per-machine, never committed.', '.caselaw/gate-fires.jsonl'].join('\n'),
  })

  return out
}
