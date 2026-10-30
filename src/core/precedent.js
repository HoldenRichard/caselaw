/**
 * Archiving a rule's precedent (0.3's optimizer): the paragraph of another
 * project's incidents moves, verbatim, to rules/precedent/<name>.md, and the
 * rule keeps a pointer with every id it cited. A loaded rule is then its
 * statement and its trigger; the evidence is one file away, never gone.
 */

const SECTION = /^\*\*Precedent:\*\*[ \t]*(.*(?:\n(?!\*\*[^*:\n]+:\*\*|-{3,}\s*$).*)*)/m
const IDS = /\b[A-Z][A-Z0-9]+-\d+\b/g

/**
 * @param {string} text the rule file
 * @param {{name: string, dir?: string, at: string}} o
 * @returns {{rule: string, archive: string, words: number} | null} null when there is no precedent to move
 */
export function archivePrecedent(text, { name, dir = 'docs', at }) {
  const m = SECTION.exec(text)
  if (!m) return null
  const precedent = m[1].trim()
  if (/^archived in /.test(precedent)) return null
  const ids = [...new Set(precedent.match(IDS) || [])]
  const pointer = `**Precedent:** archived in \`${dir}/rules/precedent/${name}.md\`${ids.length ? ` (${ids.join(', ')})` : ''}.`
  const rule = text.slice(0, m.index) + pointer + text.slice(m.index + m[0].length)
  const archive = `# ${name}: precedent\n\nMoved here verbatim from \`${dir}/rules/active/${name}.md\` by \`caselaw optimize\` on ${at}, so the rule a\nsession loads is its statement and its trigger.\n\n${precedent}\n`
  // Lossless or nothing: the archive must hold the paragraph exactly, and the
  // rule must keep every id it cited.
  if (!archive.includes(precedent) || ids.some((id) => !rule.includes(id))) return null
  return { rule, archive, words: (precedent.match(/\S+/g) || []).length }
}
