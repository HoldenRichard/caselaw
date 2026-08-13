/**
 * Managed blocks — the primitive every idempotency guarantee rests on.
 *
 * A managed block is a region of a file this tool owns, delimited by markers
 * that carry the block id, the template version, and a hash of the interior at
 * the time we wrote it:
 *
 *   <!-- caselaw:begin id=pointer v=1 hash=1c04… -->
 *   ...content we own...
 *   <!-- caselaw:end id=pointer -->
 *
 * Three rules, each of which exists because of a specific failure mode:
 *
 * 1. EXACTLY ONCE. Before replacing anything we assert the marker pair occurs
 *    exactly once. Zero means there is nothing to replace; more than one means
 *    a copy-paste or a bad merge, and a blind replace would silently clobber
 *    one of them. This is the `assertion-before-replace` rule applied to the
 *    tool that ships it.
 *
 * 2. HASH BEFORE WRITE. If the interior no longer hashes to what the marker
 *    declares, the user edited our block. We stop and report rather than
 *    overwrite. A governance tool that eats your edits gets uninstalled.
 *
 * 3. NORMALIZE BEFORE COMPARING. All hashing goes through core/text.js so a
 *    CRLF checkout or a BOM never reads as drift.
 */

import { hash, normalize, detectEol, applyEol, hasBom, BOM } from './text.js'

/** Comment syntaxes we can embed markers in. */
export const STYLES = {
  html: { open: '<!-- ', close: ' -->' }, // markdown, html
  hash: { open: '# ', close: '' }, // gitignore, yaml, toml, shell
  slash: { open: '// ', close: '' }, // js, ts, swift, go, rust
}

const TAG = 'caselaw'

/** Pick a comment style from a file path. */
export function styleFor(filePath) {
  const p = filePath.toLowerCase()
  if (p.endsWith('.md') || p.endsWith('.markdown') || p.endsWith('.html')) return 'html'
  if (p.endsWith('.yml') || p.endsWith('.yaml') || p.endsWith('.toml')) return 'hash'
  if (/(^|\/)\.gitignore$/.test(p) || /(^|\/)\.[a-z]*ignore$/.test(p)) return 'hash'
  if (/\.(js|mjs|cjs|ts|tsx|jsx|swift|go|rs|java|kt|c|h|cpp)$/.test(p)) return 'slash'
  return 'html'
}

function beginMarker(styleName, id, version, interiorHash) {
  const s = STYLES[styleName]
  return `${s.open}${TAG}:begin id=${id} v=${version} hash=${interiorHash}${s.close}`
}

function endMarker(styleName, id) {
  const s = STYLES[styleName]
  return `${s.open}${TAG}:end id=${id}${s.close}`
}

/**
 * Locate every begin/end marker for an id, in any supported comment style.
 * Returns raw match positions; validation is the caller's job via locate().
 */
function scan(text, id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const begins = []
  const ends = []
  // The (?=\s|$) boundary is load-bearing: without it `id=pointer` matches
  // inside `id=pointer-extra` and two unrelated blocks read as duplicates.
  const beginRe = new RegExp(
    `^[^\\n]*${TAG}:begin\\s+id=${esc}(?=\\s|$)(?:\\s+v=(\\S+))?(?:\\s+hash=([0-9a-f]+))?[^\\n]*$`,
    'gm',
  )
  const endRe = new RegExp(`^[^\\n]*${TAG}:end\\s+id=${esc}(?=\\s|$)[^\\n]*$`, 'gm')
  let m
  while ((m = beginRe.exec(text)) !== null) {
    begins.push({ index: m.index, length: m[0].length, version: m[1], hash: m[2] })
  }
  while ((m = endRe.exec(text)) !== null) {
    ends.push({ index: m.index, length: m[0].length })
  }
  return { begins, ends }
}

/**
 * Find the single managed block for `id`.
 *
 * @returns {{present: false}
 *   | {present: true, interior: string, declaredHash: string|undefined,
 *      version: string|undefined, start: number, end: number,
 *      interiorStart: number, interiorEnd: number}}
 * @throws if the markers are malformed or appear more than once.
 */
export function locate(rawText, id) {
  const text = normalize(rawText)
  const { begins, ends } = scan(text, id)

  if (begins.length === 0 && ends.length === 0) return { present: false }

  if (begins.length !== ends.length) {
    throw new BlockError(
      `Unbalanced markers for block "${id}": ${begins.length} begin, ${ends.length} end. ` +
        `Repair the file by hand — refusing to guess which region is ours.`,
      { id, code: 'UNBALANCED' },
    )
  }
  if (begins.length > 1) {
    throw new BlockError(
      `Block "${id}" appears ${begins.length} times. Expected exactly one. ` +
        `A duplicated managed block usually means a bad merge or a copy-paste; ` +
        `delete the stale copy and re-run. Refusing to replace one of several.`,
      { id, code: 'DUPLICATE', count: begins.length },
    )
  }

  const b = begins[0]
  const e = ends[0]
  if (e.index < b.index) {
    throw new BlockError(
      `Block "${id}" has its end marker before its begin marker. Repair by hand.`,
      { id, code: 'INVERTED' },
    )
  }

  const interiorStart = b.index + b.length + 1 // skip the newline after begin
  const interiorEnd = e.index
  // Drop the single newline that separates the interior from the end marker.
  // The hash in the begin marker is taken over the interior WITHOUT it, so if
  // this is left on, every re-run reads as a user edit and refuses to write.
  const interior = text
    .slice(interiorStart, Math.max(interiorStart, interiorEnd))
    .replace(/\n$/, '')

  return {
    present: true,
    interior,
    declaredHash: b.hash,
    version: b.version,
    start: b.index,
    end: e.index + e.length,
    interiorStart,
    interiorEnd,
  }
}

/**
 * Has the user edited inside our block since we wrote it?
 * Unknown (no declared hash) is treated as NOT modified — an older block
 * predating hashing should upgrade cleanly rather than jam.
 */
export function isUserModified(rawText, id) {
  const found = locate(rawText, id)
  if (!found.present) return false
  if (!found.declaredHash) return false
  return hash(found.interior) !== found.declaredHash
}

/**
 * Insert or replace a managed block.
 *
 * @param {string} rawText           current file contents ('' for a new file)
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.body         interior content, without markers
 * @param {number|string} opts.version
 * @param {string} [opts.style]      key of STYLES; inferred from filePath if absent
 * @param {string} [opts.filePath]   used to infer style and EOL
 * @param {boolean} [opts.force]     overwrite even if user-modified
 * @returns {{text: string, action: 'created'|'updated'|'unchanged',
 *            blocked?: 'user-modified', previousInterior?: string, hash: string}}
 */
export function upsert(rawText, opts) {
  const { id, body, version = 1, force = false } = opts
  const styleName = opts.style || (opts.filePath ? styleFor(opts.filePath) : 'html')
  if (!STYLES[styleName]) throw new BlockError(`Unknown comment style "${styleName}"`, { id })

  const original = rawText ?? ''
  const eol = original ? detectEol(original) : '\n'
  const bom = hasBom(original)
  const text = normalize(original)

  const interior = normalize(body).replace(/\s+$/, '')
  const newHash = hash(interior)
  const block =
    `${beginMarker(styleName, id, version, newHash)}\n` +
    `${interior}\n` +
    `${endMarker(styleName, id)}`

  const found = locate(text, id)

  if (!found.present) {
    const sep = text.length === 0 ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
    const next = `${text}${sep}${block}\n`
    return finish(next, 'created', newHash)
  }

  if (hash(found.interior) === newHash && found.version === String(version)) {
    return finish(text, 'unchanged', newHash)
  }

  if (!force && found.declaredHash && hash(found.interior) !== found.declaredHash) {
    return {
      text: original,
      action: 'unchanged',
      blocked: 'user-modified',
      previousInterior: found.interior,
      hash: newHash,
    }
  }

  const next = text.slice(0, found.start) + block + text.slice(found.end)
  return finish(next, 'updated', newHash, found.interior)

  function finish(nextText, action, h, previousInterior) {
    let out = applyEol(nextText, eol)
    if (bom) out = BOM + out
    return { text: out, action, hash: h, previousInterior }
  }
}

/** Remove a managed block. Returns the text unchanged if it is not present. */
export function remove(rawText, id) {
  const original = rawText ?? ''
  const eol = detectEol(original)
  const bom = hasBom(original)
  const text = normalize(original)
  const found = locate(text, id)
  if (!found.present) return { text: original, action: 'absent' }

  let next = text.slice(0, found.start) + text.slice(found.end)
  // Restore the file as closely as possible to how it looked before the block
  // existed: no leading blank, no run of blanks where the block used to be,
  // and exactly one trailing newline. An uninstall that leaves a stray blank
  // line shows up as a diff in someone's next commit for no reason.
  next = next.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n\s*\n+$/, '\n')
  let out = applyEol(next, eol)
  if (bom) out = BOM + out
  return { text: out, action: 'removed', previousInterior: found.interior }
}

export class BlockError extends Error {
  constructor(message, meta = {}) {
    super(message)
    this.name = 'BlockError'
    Object.assign(this, meta)
  }
}
