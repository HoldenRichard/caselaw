/**
 * The self-audit.
 *
 * This is the retention mechanism. `init` runs once; `audit` is the reason to
 * come back next month. It answers one question — **is the governance in this
 * repo still true?** — and every check below maps to a failure observed in a
 * real project rather than to something that sounded plausible.
 *
 * Two design rules, both learned the hard way:
 *
 *  1. **Deterministic first.** Findings come from reading files, not from
 *     asking a model. An audit that is a prompt is a second opinion; an audit
 *     that is a program is a check. The optional `--agent` pass is clearly
 *     separated and never mixed into the counts.
 *
 *  2. **Never prune a rule for being quiet.** A working rule erases its own
 *     evidence: the rules doing their job look exactly like the rules nobody
 *     needs. A rule is retired when the thing it guards is GONE, never because
 *     nothing has failed lately. `dead-rules` is scoped to that, and it is a
 *     warning rather than an error for the same reason.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isOverdue, isoDate, daysBetween } from '../core/dates.js'
import { crossCheck, PROMOTION_THRESHOLD, EVIDENCE_MODES } from '../core/gates.js'
import { scanMachinePaths } from '../core/secrets.js'

export const SEVERITY = { ERROR: 'error', WARN: 'warn', INFO: 'info' }

/**
 * @typedef {{code: string, severity: string, message: string, hint?: string,
 *            path?: string}} Finding
 */

const finding = (code, severity, message, extra = {}) => ({ code, severity, message, ...extra })

/**
 * Every check takes the same gathered context and returns findings. Keeping
 * them pure over a pre-gathered snapshot means the whole audit reads the disk
 * once and each check is trivially testable.
 */
export const CHECKS = [
  // ---- doctrine is present, tracked, and true --------------------------
  {
    id: 'refs-resolve',
    describe: 'doctrine files point at paths that exist',
    run({ docRefs }) {
      return docRefs
        .filter((r) => !r.exists)
        .map((r) =>
          finding('refs-resolve', SEVERITY.ERROR, `${r.from} points at ${r.target}, which does not exist`, {
            path: r.from,
            hint: 'Fix the pointer or restore the file. An agent told to read a missing file reads nothing and says nothing.',
          }),
        )
    },
  },
  {
    id: 'doctrine-tracked',
    describe: 'governance files are in version control',
    run({ untracked }) {
      return untracked.map((p) =>
        finding('doctrine-tracked', SEVERITY.ERROR, `${p} is not tracked by git`, {
          path: p,
          hint: 'Doctrine outside version control survives exactly as long as this machine does.',
        }),
      )
    },
  },
  {
    id: 'commands-live',
    describe: 'commands named in the verification tiers still exist',
    run({ staleCommands }) {
      return staleCommands.map((c) =>
        finding('commands-live', SEVERITY.ERROR, `"${c.cmd}" is named in ${c.from} but no longer exists`, {
          path: c.from,
          hint: 'A verification tier whose first step does not run is a tier nobody can follow.',
        }),
      )
    },
  },

  // ---- the rules⇄gates graph -------------------------------------------
  {
    id: 'origin-resolves',
    describe: 'every active rule cites an incident that can be found',
    run({ rules }) {
      const out = []
      for (const r of rules.active) {
        if (!r.origin || !String(r.origin).trim()) {
          out.push(finding('origin-resolves', SEVERITY.ERROR, `rule "${r.name}" has no Origin`, {
            path: r.file,
            hint: 'A rule with no incident behind it is a superstition with a filename.',
          }))
          continue
        }
        for (const ref of r.unresolvedRefs || []) {
          out.push(finding('origin-resolves', SEVERITY.ERROR,
            `rule "${r.name}" cites ${ref}, which is not in this repository's history`, {
              path: r.file,
              hint: 'Either the reference is wrong or the history was rewritten. Both are worth knowing.',
            }))
        }
      }
      return out
    },
  },
  {
    id: 'enforcement-truth',
    describe: 'a rule claiming a gate has one, and every gate has a rule',
    run({ rules, gatesConfig }) {
      return crossCheck({ rules: rules.active, config: gatesConfig }).map((p) =>
        finding('enforcement-truth', p.severity, p.message, { hint: p.hint }),
      )
    },
  },
  {
    id: 'mechanization-ratio',
    describe: 'how much of the case law is enforced by machine',
    run({ rules }) {
      const total = rules.active.length
      if (total === 0) {
        return [finding('mechanization-ratio', SEVERITY.INFO, 'no active rules yet', {
          hint: 'Expected on a young install. Watch one number: days until the first ratified rule.',
        })]
      }
      const by = { machine: 0, checklist: 0, memory: 0 }
      for (const r of rules.active) {
        const mode = r.enforcement?.mode ?? 'memory'
        by[mode] = (by[mode] ?? 0) + 1
      }
      const pct = (n) => Math.round((n / total) * 100)
      return [finding('mechanization-ratio', SEVERITY.INFO,
        `${total} active rule(s): ${by.machine} machine (${pct(by.machine)}%), ` +
        `${by.checklist} checklist, ${by.memory} memory`, {
          hint: by.memory > 0
            ? `${by.memory} rule(s) rest on model memory, which degrades silently. \`caselaw rule promote <name>\` builds a gate.`
            : undefined,
          data: { total, ...by },
        })]
    },
  },
  {
    id: 'dead-rules',
    describe: 'rules whose subject no longer exists',
    run({ rules }) {
      // Deliberately narrow. Not "has not fired lately" — a working rule
      // erases its own evidence, so quietness is the success case.
      return rules.active
        .filter((r) => (r.missingSubjects || []).length > 0)
        .map((r) =>
          finding('dead-rules', SEVERITY.WARN,
            `rule "${r.name}" triggers on ${r.missingSubjects.join(', ')}, which no longer exists`, {
              path: r.file,
              hint: 'Retire it only if the thing it guards is genuinely gone. Silence alone is not grounds.',
            }),
        )
    },
  },
  {
    id: 'proposed-backlog',
    describe: 'proposals waiting on a human',
    run({ rules, now, backlogDays = 21 }) {
      return rules.proposed
        .filter((r) => r.ageDays != null && r.ageDays > backlogDays)
        .map((r) =>
          finding('proposed-backlog', SEVERITY.WARN,
            `"${r.name}" has been proposed for ${r.ageDays} days`, {
              path: r.file,
              hint: 'Ratify it or reject it. An undecided proposal is a rule nobody is following and nobody has rejected.',
            }),
        )
    },
  },

  // ---- the authority split decays on a clock ---------------------------
  {
    id: 'authority-retest',
    describe: 'unverified boundaries are re-tested before they go stale',
    run({ authority, now }) {
      const out = []
      if (!authority) return out
      if (authority.retestDue && isOverdue(authority.retestDue, now)) {
        out.push(finding('authority-retest', SEVERITY.ERROR,
          `boundary re-check was due ${authority.retestDue} (${daysBetween(new Date(authority.retestDue), now)} days ago)`, {
            path: authority.file,
            hint: 'A boundary nobody has tested since is a belief with a date on it.',
          }))
      }
      for (const b of authority.untested || []) {
        out.push(finding('authority-retest', SEVERITY.WARN,
          `"${b.label}" is still marked untested`, {
            path: authority.file,
            hint: b.settleCommand ? `Settle it: ${b.settleCommand}` : 'Try it once and record what happened.',
          }))
      }
      return out
    },
  },
  {
    id: 'open-questions',
    describe: 'interview questions left unanswered',
    run({ answers }) {
      return (answers?.unanswered || []).map((u) =>
        finding('open-questions', SEVERITY.WARN, `unanswered: ${u.prompt}`, {
          hint: `It is marked as a hole in ${(u.generates || []).join(', ') || 'the generated docs'} rather than guessed at. Answer it with \`caselaw init --reconfigure\`.`,
        }),
      )
    },
  },

  // ---- gates -----------------------------------------------------------
  {
    id: 'grandfather-expiry',
    describe: 'exceptions that have outlived their reason',
    run({ gatesConfig, now }) {
      const out = []
      for (const g of gatesConfig.gates || []) {
        for (const gf of g.grandfather || []) {
          if (gf.expires && isOverdue(gf.expires, now)) {
            out.push(finding('grandfather-expiry', SEVERITY.WARN,
              `gate "${g.id}" has an exception that expired ${gf.expires} (${gf.reason || 'no reason recorded'})`, {
                hint: 'Fix the underlying violation or renew the exception deliberately.',
              }))
          }
        }
      }
      return out
    },
  },
  {
    id: 'gates-earned',
    describe: 'warn-level gates that have earned promotion',
    run({ gatesConfig, earnedFires = {}, threshold = PROMOTION_THRESHOLD }) {
      // Only hook and staged fires count: a whole-tree scan over pre-existing
      // violations is an observation, not a catch.
      return (gatesConfig.gates || [])
        .filter((g) => g.severity === 'warn' && (earnedFires[g.id] || 0) >= threshold)
        .map((g) =>
          finding('gates-earned', SEVERITY.INFO,
            `gate "${g.id}" has caught ${earnedFires[g.id]} real violations (${EVIDENCE_MODES.join('/')}) and is still only warning`, {
              hint: `\`caselaw gate promote ${g.id}\` — it has the evidence.`,
            }),
        )
    },
  },
  {
    id: 'dead-gates',
    describe: 'gates that have never fired',
    run({ gatesConfig, fireCounts, installAgeDays }) {
      // Only meaningful once the install has had time to see real work.
      if (installAgeDays != null && installAgeDays < 30) return []
      return (gatesConfig.gates || [])
        .filter((g) => (fireCounts[g.id] || 0) === 0)
        .map((g) =>
          finding('dead-gates', SEVERITY.INFO,
            `gate "${g.id}" has never fired in ${installAgeDays} days`, {
              hint: 'Either the invariant is safely held — good — or the gate is scoped wrong and is checking nothing. Worth one look.',
            }),
        )
    },
  },

  // ---- decision records ------------------------------------------------
  {
    id: 'adr-numbering',
    describe: 'decision records are uniquely numbered and indexed',
    run({ adrs }) {
      if (!adrs) return []
      const out = []
      const byNumber = new Map()
      for (const r of adrs.records) {
        if (!r.number) continue
        byNumber.set(r.number, [...(byNumber.get(r.number) || []), r.file])
      }
      for (const [number, files] of byNumber) {
        if (files.length > 1) {
          out.push(finding('adr-numbering', SEVERITY.ERROR,
            `decision number ${number} is used by ${files.length} records: ${files.join(', ')}`, {
              hint: 'Renumber one. "See ADR ' + number + '" is ambiguous for as long as both exist.',
            }))
        }
      }
      if (adrs.hasIndex) {
        for (const r of adrs.records.filter((x) => !x.inIndex)) {
          out.push(finding('adr-numbering', SEVERITY.WARN,
            `${r.file} is not listed in the index`, {
              path: r.file,
              hint: 'A decision nobody can find is a decision that gets made again.',
            }))
        }
      }
      return out
    },
  },

  // ---- hygiene ---------------------------------------------------------
  {
    id: 'no-machine-paths',
    describe: 'governance files carry no machine-specific paths',
    run({ docTexts }) {
      const out = []
      for (const [path, text] of Object.entries(docTexts)) {
        for (const hit of scanMachinePaths(text)) {
          out.push(finding('no-machine-paths', SEVERITY.ERROR,
            `${path} contains ${hit.kind} ${hit.redacted}`, {
              path,
              hint: 'It will not resolve on anyone else\'s machine, and it leaks your directory layout when the repo goes public.',
            }))
        }
      }
      return out
    },
  },
  {
    id: 'claims-verifiable',
    describe: 'claims the docs make about the repo are still true',
    run({ gitignoreClaims }) {
      return (gitignoreClaims || [])
        .filter((c) => c.actuallyIgnored === false)
        .map((c) =>
          finding('claims-verifiable', SEVERITY.ERROR,
            `${c.from} says ${c.path} is gitignored, but it is tracked`, {
              path: c.from,
              hint: 'The doc sends a reader to recreate a file that is already committed. Fix the sentence or the ignore rule.',
            }),
        )
    },
  },
  {
    id: 'drift',
    describe: 'generated files still match what the answers would produce',
    run({ drifted }) {
      return drifted.map((d) =>
        finding('drift', d.kind === 'modified' ? SEVERITY.WARN : SEVERITY.ERROR,
          d.kind === 'modified'
            ? `${d.path} has been edited by hand since it was generated`
            : `${d.path} is recorded as generated but is missing`, {
            path: d.path,
            hint: d.kind === 'modified'
              ? 'Fine if deliberate — but `caselaw upgrade` will not touch it, so the change will not survive a template update.'
              : 'Re-run `caselaw init` to restore it, or `caselaw eject` if you meant to remove caselaw.',
          }),
      )
    },
  },
]

/** Run every check over a gathered context. Never throws. */
export function runChecks(ctx, { only = null } = {}) {
  const findings = []
  const ran = []
  const failed = []

  for (const check of CHECKS) {
    if (only && !only.includes(check.id)) continue
    try {
      findings.push(...(check.run(ctx) || []))
      ran.push(check.id)
    } catch (err) {
      // A broken check must not take the audit down with it, and must not
      // quietly look like a clean result either.
      failed.push({ id: check.id, reason: err?.message || String(err) })
    }
  }

  const bySeverity = (s) => findings.filter((f) => f.severity === s)
  return {
    findings,
    ran,
    failed,
    counts: {
      error: bySeverity(SEVERITY.ERROR).length,
      warn: bySeverity(SEVERITY.WARN).length,
      info: bySeverity(SEVERITY.INFO).length,
    },
    ok: bySeverity(SEVERITY.ERROR).length === 0,
  }
}
