/**
 * The constitution (0.3): what always needs the human, under any autonomy
 * setting. The harness may tune itself; it may never use that to loosen its
 * own hold, take more for the agent, erase what happened, or make an
 * outward-facing action automatic. No setting changes this list: it changes
 * only in a caselaw release.
 */

export const CONSTITUTION = [
  { id: 'A1', text: 'Any change that weakens enforcement or widens what the agent may do needs a human.' },
  { id: 'A2', text: 'The evidence trail is append-only: catches, the harness log, and every Origin are added to, never rewritten.' },
  { id: 'A3', text: 'Nothing is deleted: a rule is demoted, retired or archived, and can come back.' },
  { id: 'A4', text: 'An outward-facing, irreversible or spending action (D5) never becomes automatic.' },
  { id: 'A5', text: 'The constitution itself is not a setting.' },
]

export const constitutionLine = (id) => CONSTITUTION.find((c) => c.id === id)?.text ?? id
