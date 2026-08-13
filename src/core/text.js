/**
 * Text normalization and hashing.
 *
 * Every hash in this tool is taken over NORMALIZED text. A Windows clone
 * rewrites line endings on checkout and some editors prepend a BOM; if either
 * changed a hash we would report drift on files nobody touched. Getting this
 * wrong is the single most common false-positive in drift detection, so it is
 * isolated here and nothing else is allowed to hash raw bytes.
 */

import { createHash } from 'node:crypto'

const BOM = '﻿'

/** Strip a leading BOM and normalize CRLF/CR to LF. */
export function normalize(text) {
  let out = text
  if (out.startsWith(BOM)) out = out.slice(BOM.length)
  return out.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** sha256 of the normalized text, hex. */
export function hash(text) {
  return createHash('sha256').update(normalize(text), 'utf8').digest('hex')
}

/** Short display form of a hash. Never used for comparison. */
export function shortHash(h) {
  return h.slice(0, 12)
}

/**
 * Detect the dominant line ending of an existing file so a rewrite preserves
 * it. We normalize for comparison, not for output — rewriting a CRLF repo's
 * file as LF would show up as a whole-file diff in the user's next commit.
 */
export function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length
  const lf = (text.match(/(?<!\r)\n/g) || []).length
  return crlf > lf ? '\r\n' : '\n'
}

/** Re-apply an EOL style to LF-normalized text. */
export function applyEol(text, eol) {
  return eol === '\n' ? text : text.replace(/\n/g, eol)
}

/** True if the text began with a BOM. */
export function hasBom(text) {
  return text.startsWith(BOM)
}

export { BOM }
