/**
 * Everything around the code: CI, hooks, existing agent config, what this
 * project deploys to, what secrets sit in the tree, and whether the world can
 * see the repo.
 *
 * `deploySurface` is the one to get right. It seeds the authority-split
 * question — "what can the agent not observe?" — and the honest answer is
 * usually "everything past the build". An agent can run the tests; it cannot
 * see whether the Fly machine came back up, whether the Firestore rules it
 * edited actually deployed, or whether the k8s rollout wedged. A missed deploy
 * target means the generated authority split claims the agent can verify
 * something it structurally cannot, which is the exact failure this whole tool
 * exists to prevent. Over-reporting here costs one "no" in the interview;
 * under-reporting costs a false promise in a governance document.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from './exec.js'
import { walk } from './stack.js'

/** gh is a network call. Four seconds or we move on. */
export const DEFAULT_GH_TIMEOUT_MS = 4000
/** argv has a length limit; check-ignore gets its paths in chunks. */
const CHECK_IGNORE_BATCH = 200

const CI_PROVIDERS = [
  { name: 'github-actions', dir: '.github/workflows', exts: ['.yml', '.yaml'] },
  { name: 'gitlab-ci', files: ['.gitlab-ci.yml', '.gitlab-ci.yaml'] },
  { name: 'circleci', dir: '.circleci', exts: ['.yml', '.yaml'] },
  { name: 'jenkins', files: ['Jenkinsfile'] },
  { name: 'azure-pipelines', files: ['azure-pipelines.yml', 'azure-pipelines.yaml'] },
  { name: 'travis', files: ['.travis.yml'] },
  { name: 'drone', files: ['.drone.yml'] },
  { name: 'bitbucket', files: ['bitbucket-pipelines.yml'] },
]

/**
 * Deploy targets, matched on basename anywhere in the tree.
 * `dirs` entries match a directory that contains at least one YAML file.
 */
const DEPLOY_RULES = [
  { kind: 'docker', test: (b) => b === 'Dockerfile' || b.startsWith('Dockerfile.') },
  { kind: 'docker-compose', test: (b) => /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(b) },
  { kind: 'fly', test: (b) => b === 'fly.toml' },
  { kind: 'vercel', test: (b) => b === 'vercel.json' },
  { kind: 'netlify', test: (b) => b === 'netlify.toml' },
  { kind: 'firebase', test: (b) => b === 'firebase.json' },
  { kind: 'serverless', test: (b) => /^serverless\.(ya?ml|ts|js|json)$/.test(b) },
  { kind: 'terraform', test: (b) => b.endsWith('.tf') || b === '.terraform.lock.hcl' },
  { kind: 'kubernetes', test: (b) => /^kustomization\.ya?ml$/.test(b) || b === 'Chart.yaml' },
  { kind: 'heroku', test: (b) => b === 'Procfile' },
  { kind: 'app-engine', test: (b) => b === 'app.yaml' },
  { kind: 'render', test: (b) => b === 'render.yaml' },
  { kind: 'railway', test: (b) => b === 'railway.json' || b === 'railway.toml' },
  { kind: 'cloudflare', test: (b) => b === 'wrangler.toml' || b === 'wrangler.jsonc' },
]

/** Directory names that, when they hold YAML, mean Kubernetes. */
const K8S_DIRS = new Set(['k8s', 'kubernetes', 'manifests', 'helm', 'charts'])

/**
 * Files that hold, or conventionally hold, credentials.
 *
 * `.env.example` and friends are deliberately NOT matched. They exist to be
 * committed, they contain no secrets, and flagging them trains the human to
 * dismiss this list — at which point the real `.env` gets dismissed with it.
 */
const SECRET_RULES = [
  { test: (b) => /^\.env($|\.)/.test(b) && !/\.(example|sample|template|dist|defaults)$/.test(b) },
  { test: (b) => b.endsWith('.pem') },
  { test: (b) => b.endsWith('.p12') || b.endsWith('.pfx') },
  { test: (b) => b.endsWith('.keystore') || b.endsWith('.jks') },
  { test: (b) => b.endsWith('.mobileprovision') },
  { test: (b) => b === 'GoogleService-Info.plist' },
  { test: (b) => b === 'google-services.json' },
  { test: (b) => b === 'credentials.json' || /^service-?account.*\.json$/i.test(b) },
  { test: (b) => b === '.netrc' || b === '.npmrc' },
  { test: (b) => b === 'id_rsa' || b === 'id_ed25519' },
]

export function emptyEnvironment() {
  return {
    ci: { present: false, provider: null, files: [], providers: [] },
    hooks: { framework: null, files: [] },
    agentConfig: {
      claudeMd: false,
      agentsMd: false,
      claudeDir: false,
      cursorRules: false,
      copilot: false,
      existingHarness: false,
      windsurfRules: false,
      files: [],
    },
    deploySurface: [],
    secretSurface: [],
    visibility: 'unknown',
  }
}

/**
 * @param {string} root
 * @param {object} [opts]
 * @param {{walked?: object, vcs?: object}} [ctx]
 * @returns {Promise<{environment: object, warnings: object[]}>}
 */
export async function detectEnvironment(root, opts = {}, ctx = {}) {
  const warnings = []
  const env = emptyEnvironment()
  const w = ctx.walked || (await walk(root, opts))

  const dirSet = new Set(w.dirs)
  const fileSet = new Set(w.files)

  // --- CI ------------------------------------------------------------------
  for (const p of CI_PROVIDERS) {
    const hits = []
    if (p.files) for (const f of p.files) if (fileSet.has(f)) hits.push(f)
    if (p.dir && dirSet.has(p.dir)) {
      for (const f of w.files) {
        if (!f.startsWith(`${p.dir}/`)) continue
        if (p.exts.some((e) => f.endsWith(e))) hits.push(f)
      }
    }
    if (hits.length > 0) {
      env.ci.providers.push(p.name)
      env.ci.files.push(...hits.sort())
    }
  }
  env.ci.present = env.ci.files.length > 0
  env.ci.provider = env.ci.providers[0] ?? null

  // --- hooks ---------------------------------------------------------------
  if (dirSet.has('.husky')) {
    env.hooks.framework = 'husky'
    env.hooks.files.push(...w.files.filter((f) => f.startsWith('.husky/') && !f.includes('/_/')))
  }
  for (const f of ['.pre-commit-config.yaml', '.pre-commit-config.yml']) {
    if (!fileSet.has(f)) continue
    env.hooks.framework = env.hooks.framework || 'pre-commit'
    env.hooks.files.push(f)
  }
  for (const f of ['lefthook.yml', 'lefthook.yaml', 'lefthook.toml', '.lefthook.yml']) {
    if (!fileSet.has(f)) continue
    env.hooks.framework = env.hooks.framework || 'lefthook'
    env.hooks.files.push(f)
  }
  // Hand-written hooks are invisible to every framework check but are still a
  // gate this repo already enforces, so the interview must know about them.
  // .git is excluded from the walk, so this needs its own readdir.
  for (const h of await listNativeHooks(root)) env.hooks.files.push(h)

  // --- agent config --------------------------------------------------------
  const ac = env.agentConfig
  const mark = (cond, path) => {
    if (cond) ac.files.push(path)
    return cond
  }
  ac.claudeMd = mark(fileSet.has('CLAUDE.md'), 'CLAUDE.md')
  ac.agentsMd = mark(fileSet.has('AGENTS.md'), 'AGENTS.md')
  ac.claudeDir = mark(dirSet.has('.claude'), '.claude/')
  ac.cursorRules =
    mark(dirSet.has('.cursor/rules'), '.cursor/rules/') || mark(fileSet.has('.cursorrules'), '.cursorrules')
  ac.copilot = mark(fileSet.has('.github/copilot-instructions.md'), '.github/copilot-instructions.md')
  ac.windsurfRules = mark(fileSet.has('.windsurfrules'), '.windsurfrules')
  // Fresh install vs upgrade. This one changes what the CLI does next, so it
  // is checked on disk rather than inferred from a possibly truncated walk.
  ac.existingHarness = mark(await isFile(join(root, '.caselaw/manifest.json')), '.caselaw/manifest.json')

  // --- deploy surface ------------------------------------------------------
  const byKind = new Map()
  const add = (kind, path) => {
    if (!byKind.has(kind)) byKind.set(kind, [])
    const list = byKind.get(kind)
    if (list.length < 20 && !list.includes(path)) list.push(path)
  }
  for (const f of w.files) {
    const base = f.slice(f.lastIndexOf('/') + 1)
    for (const rule of DEPLOY_RULES) if (rule.test(base)) add(rule.kind, f)
    // A YAML file inside k8s/ or kubernetes/ is a manifest often enough that
    // the false-positive cost (one "no") beats the false-negative cost.
    if (/\.ya?ml$/.test(base)) {
      const parts = f.split('/')
      if (parts.length > 1 && K8S_DIRS.has(parts[parts.length - 2])) add('kubernetes', f)
    }
  }
  env.deploySurface = [...byKind.entries()]
    .map(([kind, files]) => ({ kind, evidence: files[0], files }))
    .sort((a, b) => a.kind.localeCompare(b.kind))

  if (w.truncated && env.deploySurface.length > 0) {
    warnings.push({
      code: 'deploy-surface-partial',
      message: 'The tree scan stopped early, so the deploy surface may be incomplete.',
      hint: 'Confirm every deploy target during the authority-split question — a missed one becomes a false promise.',
    })
  }

  // --- secret surface ------------------------------------------------------
  const secretPaths = []
  for (const f of w.files) {
    const base = f.slice(f.lastIndexOf('/') + 1)
    if (SECRET_RULES.some((r) => r.test(base))) secretPaths.push(f)
  }
  const ignored = await checkIgnored(root, secretPaths, opts)
  if (ignored.degraded && secretPaths.length > 0) {
    warnings.push({
      code: 'check-ignore-unavailable',
      message: `Could not ask git which secret files are ignored: ${ignored.reason}`,
      hint: 'Every candidate is reported as not-ignored, which is the safe direction to be wrong in.',
    })
  }
  env.secretSurface = secretPaths.sort().map((p) => ({ path: p, gitignored: ignored.map.get(p) ?? null }))

  // --- visibility ----------------------------------------------------------
  const vis = await detectVisibility(root, opts, ctx.vcs)
  env.visibility = vis.visibility
  if (vis.warning) warnings.push(vis.warning)

  return { environment: env, warnings }
}

/**
 * Public or private, via the gh CLI.
 *
 * gh is optional and networked, so this is the single most likely thing in
 * stage 0 to be slow or missing. 'unknown' is a perfectly good answer — it
 * costs one interview question — and is always preferred to a hang.
 */
export async function detectVisibility(root, opts = {}, vcs = null) {
  if (opts.gh === false) return { visibility: 'unknown', warning: null }
  // Only ask gh about repos gh can answer for. Skipping the spawn entirely on
  // a GitLab or remote-less repo keeps a guaranteed-useless network call out
  // of the interview budget.
  const host = vcs?.remoteHost || ''
  if (!vcs?.isRepo || !host || !/github/i.test(host)) return { visibility: 'unknown', warning: null }

  const res = await run(opts.ghBin || 'gh', ['repo', 'view', '--json', 'visibility'], {
    cwd: root,
    timeoutMs: opts.ghTimeoutMs ?? DEFAULT_GH_TIMEOUT_MS,
  })
  if (!res.ok) {
    return {
      visibility: 'unknown',
      warning: {
        code: 'gh-unavailable',
        message: `Could not determine repository visibility: ${res.reason}`,
        hint: 'Answer the public/private question during the interview. It decides how much the generated docs may say.',
      },
    }
  }
  let raw
  try {
    raw = String(JSON.parse(res.stdout)?.visibility || '').toUpperCase()
  } catch {
    return {
      visibility: 'unknown',
      warning: { code: 'gh-unparseable', message: 'gh returned output that was not JSON.', hint: 'Confirm visibility by hand.' },
    }
  }
  if (raw === 'PUBLIC') return { visibility: 'public', warning: null }
  if (raw === 'PRIVATE') return { visibility: 'private', warning: null }
  if (raw === 'INTERNAL') {
    // Not public, but not private either. Treated as private because the
    // question this answers is "can a stranger read this?".
    return {
      visibility: 'private',
      warning: {
        code: 'visibility-internal',
        message: 'The repository is org-internal; treating it as private.',
        hint: 'Internal repos are readable by everyone in the org. Say so if that changes what the docs may contain.',
      },
    }
  }
  return { visibility: 'unknown', warning: null }
}

/**
 * Which of these paths does git ignore?
 *
 * A TRACKED file is reported as not-ignored even if .gitignore would match it,
 * which is the answer we want: a committed .env is the dangerous case, and
 * calling it "ignored" would hide exactly the finding worth surfacing.
 *
 * @returns {Promise<{map: Map<string, boolean>, degraded: boolean, reason: string|null}>}
 */
async function checkIgnored(root, paths, opts = {}) {
  const map = new Map()
  if (paths.length === 0) return { map, degraded: false, reason: null }
  const gitBin = opts.gitBin || 'git'

  for (let i = 0; i < paths.length; i += CHECK_IGNORE_BATCH) {
    const batch = paths.slice(i, i + CHECK_IGNORE_BATCH)
    const res = await run(gitBin, ['--no-pager', 'check-ignore', '--', ...batch], {
      cwd: root,
      timeoutMs: opts.timeoutMs,
    })
    // Exit 1 means "none of these are ignored" — a real answer, not a failure.
    // Exit 128 or a spawn failure means git could not answer at all.
    if (!res.ok && res.code !== 1) return { map, degraded: true, reason: res.reason }
    const hit = new Set(res.stdout.split('\n').map((l) => l.trim()).filter(Boolean))
    for (const p of batch) map.set(p, hit.has(p))
  }
  return { map, degraded: false, reason: null }
}

async function listNativeHooks(root) {
  try {
    const entries = await readdir(join(root, '.git', 'hooks'), { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && !e.name.endsWith('.sample'))
      .map((e) => `.git/hooks/${e.name}`)
      .sort()
  } catch {
    return [] // no .git, no hooks dir, or a worktree pointing elsewhere
  }
}

async function isFile(p) {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}
