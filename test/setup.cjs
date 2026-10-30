// Every test, and every CLI a test spawns, gets a throwaway personal layer
// (0.3): a test must never read or write the developer's own ~/.caselaw.
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
if (!process.env.CASELAW_HOME_FOR_TESTS) {
  process.env.CASELAW_HOME_FOR_TESTS = '1'
  process.env.CASELAW_HOME = mkdtempSync(join(tmpdir(), 'caselaw-home-'))
}
