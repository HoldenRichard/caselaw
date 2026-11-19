/**
 * The install manifest — what we generated, and what it hashed to at the time.
 *
 * Three of the largest tools in this space (spec-kit's manifest.py, ECC's
 * install-state.json, BMAD's files-manifest.csv) independently converged on
 * this same primitive, which is a strong signal it is the right one.
 *
 * It answers three questions that are otherwise guesswork:
 *   - "Did the user edit our output?"  -> hash lookup, not a diff heuristic
 *   - "What should upgrade touch?"     -> only files still matching their hash
 *   - "What does eject remove?"        -> exactly what we own and nothing else
 *
 * Two ownership kinds, because they eject differently:
 *   'file'  — we created the whole file; eject deletes it
 *   'block' — we own a managed block inside a file the user also owns;
 *             eject strips the block and leaves the file
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { hash, normalize } from './text.js'
import { parseSettings, extractOurs, hashOurs } from './jsonmerge.js'
import { kindAt, refusal } from './fsguard.js'

export const MANIFEST_PATH = '.caselaw/manifest.json'
export const SCHEMA_VERSION = 1

export function emptyManifest({ cliVersion = '0.0.0', templateVersion = '0' } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    cliVersion,
    templateVersion,
    generatedAt: null,
    entries: {},
  }
}

export async function load(root) {
  const p = join(root, MANIFEST_PATH)
  try {
    const raw = await readFile(p, 'utf8')
    const parsed = JSON.parse(normalize(raw))
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      throw new ManifestError(
        `Manifest schema v${parsed.schemaVersion} is not v${SCHEMA_VERSION}. ` +
          `Run \`caselaw upgrade\` — refusing to act on a manifest shape I do not understand.`,
        { code: 'SCHEMA_MISMATCH', found: parsed.schemaVersion },
      )
    }
    return parsed
  } catch (err) {
    if (err.code === 'ENOENT') return null
    if (err instanceof ManifestError) throw err
    throw new ManifestError(`Manifest at ${MANIFEST_PATH} is unreadable: ${err.message}`, {
      code: 'UNREADABLE',
    })
  }
}

export async function save(root, manifest, { now = new Date().toISOString() } = {}) {
  const p = join(root, MANIFEST_PATH)
  await mkdir(dirname(p), { recursive: true })
  const out = { ...manifest, generatedAt: now }
  await writeFile(p, JSON.stringify(out, null, 2) + '\n', 'utf8')
  return out
}

/**
 * Record one artifact we just wrote.
 * `contentHash` is the hash of the whole file for kind 'file', or of the
 * block interior for kind 'block'.
 */
export function record(manifest, { path, kind, contentHash, blockId, templateId }) {
  if (kind !== 'file' && kind !== 'block' && kind !== 'json-merge') {
    throw new ManifestError(`Unknown ownership kind "${kind}"`, { code: 'BAD_KIND' })
  }
  if ((kind === 'block' || kind === 'json-merge') && !blockId) {
    throw new ManifestError(`A 'block' entry for ${path} must name its blockId`, {
      code: 'MISSING_BLOCK_ID',
    })
  }
  const key = toPosix(path)
  // A file a caselaw command edited since generation (see adoptEdit) is already
  // recorded at the hash it has now; re-recording the same bytes as a fresh
  // generation would drop the mark and let the next upgrade overwrite the edit.
  const prev = manifest.entries[key]
  if (kind === 'file' && prev?.toolHash && prev.toolHash === contentHash) return manifest
  manifest.entries[key] = {
    kind,
    hash: contentHash,
    ...(blockId ? { blockId } : {}),
    ...(templateId ? { templateId } : {}),
  }
  return manifest
}

/**
 * A caselaw command (`rule catch`, `rule promote`, `gate promote`) just rewrote
 * a file we generated. That is not a hand edit, so it must not be reported as
 * one: the new hash is recorded beside the generated one (`toolHash`), and
 * reconcile() and buildPlan() treat either as ours. Without this the tool's own
 * workflow turned `check --strict` red.
 *
 * Only a file that was clean before the write is adopted. If a person had
 * already edited it, their edit rides into the new bytes and stays reported.
 *
 * @param {string} root
 * @param {string} path  repo-relative
 * @param {{before: string|null, after: string}} texts  the file around the write
 * @returns {Promise<boolean>} whether the manifest changed
 */
export async function adoptEdit(root, path, { before, after }) {
  let manifest
  try { manifest = await load(root) } catch { return false }
  const entry = manifest?.entries?.[toPosix(path)]
  if (!entry || entry.kind !== 'file' || before === null) return false
  const was = hash(before)
  if (was !== entry.hash && was !== entry.toolHash) return false
  const now = hash(after)
  if (now === entry.hash) {
    if (!entry.toolHash) return false
    delete entry.toolHash
  } else if (entry.toolHash === now) return false
  else entry.toolHash = now
  await save(root, manifest, { now: manifest.generatedAt || new Date().toISOString() })
  return true
}

/**
 * Drop entries for files a command moved out of generated ground on purpose
 * (`rule demote`, a merge's retired sources). The answers no longer ask for
 * them, so an upgrade will not recreate them; left in the manifest they read
 * as "recorded as generated but missing".
 */
export async function forgetFiles(root, paths) {
  let manifest
  try { manifest = await load(root) } catch { return false }
  if (!manifest) return false
  const gone = paths.map(toPosix).filter((p) => manifest.entries[p])
  if (!gone.length) return false
  for (const p of gone) forget(manifest, p)
  await save(root, manifest, { now: manifest.generatedAt || new Date().toISOString() })
  return true
}

export function forget(manifest, path) {
  delete manifest.entries[toPosix(path)]
  return manifest
}

/**
 * Compare the manifest against what is actually on disk.
 *
 * @returns {Promise<{clean: string[], modified: string[], missing: string[],
 *                    unreadable: {path: string, reason: string}[], toolEdited: string[]}>}
 *
 * 'modified' means the user edited content we own — upgrade must not touch
 * those without --force, and the audit reports them. 'toolEdited' is the
 * subset of 'clean' a caselaw command rewrote (adoptEdit): not drift, but not
 * ours to delete on eject either.
 */
export async function reconcile(root, manifest, { locate } = {}) {
  const clean = []
  const modified = []
  const missing = []
  const unreadable = []
  const toolEdited = []

  for (const [path, entry] of Object.entries(manifest.entries)) {
    const abs = join(root, path)
    const kind = await kindAt(abs)
    if (kind === 'missing') { missing.push(path); continue }
    const refused = refusal(kind)
    if (refused) { unreadable.push({ path, reason: refused }); continue }
    let text
    try {
      text = await readFile(abs, 'utf8')
    } catch (err) {
      unreadable.push({ path, reason: err.code || err.message })
      continue
    }

    if (entry.kind === 'file') {
      const h = hash(text)
      if (h === entry.hash) clean.push(path)
      else if (entry.toolHash && h === entry.toolHash) { clean.push(path); toolEdited.push(path) }
      else modified.push(path)
      continue
    }

    if (entry.kind === 'json-merge') {
      // Only our entries are ours to judge; the rest of the file is the
      // project's and may change freely.
      const p = parseSettings(text)
      if (!p.ok) { unreadable.push({ path, reason: p.reason }); continue }
      const ours = extractOurs(p.settings)
      if (!Object.values(ours).some((list) => list.length)) missing.push(path)
      else if (hashOurs(ours) === entry.hash) clean.push(path)
      else modified.push(path)
      continue
    }

    // kind === 'block'
    if (!locate) {
      throw new ManifestError(
        'reconcile() needs a `locate` implementation to check block entries',
        { code: 'NO_LOCATOR' },
      )
    }
    let found
    try {
      found = locate(text, entry.blockId)
    } catch (err) {
      unreadable.push({ path, reason: err.message })
      continue
    }
    if (!found.present) missing.push(path)
    else if (hash(found.interior) === entry.hash) clean.push(path)
    else modified.push(path)
  }

  return { clean, modified, missing, unreadable, toolEdited }
}

/**
 * Files the manifest claims but that no longer appear in the current write
 * plan — i.e. artifacts a config change orphaned. Reported as drift too,
 * because a stale generated file is a doctrine file that lies.
 */
export function orphans(manifest, plannedPaths) {
  const planned = new Set(plannedPaths.map(toPosix))
  return Object.keys(manifest.entries).filter((p) => !planned.has(p))
}

/** Everything eject would touch, split by how it must be removed. */
export function ejectPlan(manifest, reconciliation) {
  const modified = new Set(reconciliation.modified)
  const toolEdited = new Set(reconciliation.toolEdited || [])
  const unreadable = new Map((reconciliation.unreadable || []).map((u) => [u.path, u.reason]))
  const deleteFiles = []
  const stripBlocks = []
  const leaveAlone = []

  for (const [path, entry] of Object.entries(manifest.entries)) {
    if (modified.has(path)) {
      leaveAlone.push({ path, reason: 'you edited it' })
      continue
    }
    if (toolEdited.has(path)) {
      // A command rewrote it with content the project now depends on (a gate
      // list, a first-catch Origin): same protection as a hand edit.
      leaveAlone.push({ path, reason: 'a caselaw command wrote into it (a gate or an Origin)' })
      continue
    }
    if (unreadable.has(path)) {
      // Cannot tell what is there, so cannot delete it. It used to fall out of
      // every list and disappear from the plan.
      leaveAlone.push({ path, reason: unreadable.get(path) })
      continue
    }
    if (entry.kind === 'file') deleteFiles.push(path)
    else stripBlocks.push({ path, blockId: entry.blockId, kind: entry.kind })
  }
  return { deleteFiles, stripBlocks, leaveAlone }
}

function toPosix(p) {
  return p.split(sep).join('/')
}

export { toPosix, relative, stat }

export class ManifestError extends Error {
  constructor(message, meta = {}) {
    super(message)
    this.name = 'ManifestError'
    Object.assign(this, meta)
  }
}
