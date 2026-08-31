/**
 * Draft a `.commandmate/verify.yaml` from what a repository already declares
 * as "passing" (Issue #2061).
 *
 * The single implementation of that drafting step. `commandmate verify init`
 * calls it directly, `POST /api/worktrees/:id/verify/config` calls it for the
 * Verification pane's "draft from CI" button, and the `cmate-verify` Skill's
 * step 1 describes this same priority order in prose for environments that have
 * no CommandMate installed. Two scanners would drift, and a repository whose
 * gates differ depending on *which* surface drafted them is worse than one with
 * no drafter at all.
 *
 * The priority order is `.claude/skills/cmate-verify/SKILL.md` step 1's:
 * the CI workflow definitions first — they are the repository's existing answer
 * to "what has to be green" — then `package.json` scripts as a supplement for
 * the canonical names CI did not happen to run.
 *
 * **What is deliberately NOT drafted.** A gate is a command that may be re-run
 * any number of times with no outward effect, so publish / deploy / audit /
 * install steps are refused rather than emitted commented-out-and-forgotten,
 * and every refusal is reported with its reason: a draft that silently drops
 * half of CI reads as "CI only checks these four things".
 *
 * Output constraints — the rendered YAML has to be readable by BOTH runners:
 * the product loader (`verify-config.ts`, a real YAML parser) and the Skill's
 * standalone `verify-run.sh` (awk over a closed YAML subset: two-space indent,
 * one-line scalars, comments only on their own line). The subset is the
 * narrower of the two, so this renderer targets it.
 *
 * Server-only: reads from disk. Imported by the CLI through a relative path
 * (`tsconfig.cli.json` resets `paths` to `{}`), so it must not reach for
 * anything the CLI bundle cannot carry — `fs` / `path` / `yaml` only.
 *
 * @module lib/verification/verify-draft
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_TIMEOUT_SEC,
  GATE_ID_PATTERN,
  RESERVED_GATE_IDS,
  VERIFY_CONFIG_RELATIVE_PATH,
} from './verify-config';

/** Where a drafted command was read from. */
export type DraftSourceKind = 'workflow' | 'npm-script';

/** Provenance of one drafted (or refused) command. */
export interface DraftSource {
  kind: DraftSourceKind;
  /** Repository-relative file the command was read from. */
  file: string;
  /** Workflow job key (`kind === 'workflow'`). */
  job?: string;
  /** Workflow step `name:`, or `step <n>` when the step declared none. */
  step?: string;
  /** `scripts` key (`kind === 'npm-script'`). */
  script?: string;
}

/**
 * Why a command found in CI is not a gate.
 *
 * Reported rather than dropped. The reader of a draft has to be able to tell
 * "CI runs nothing else" from "CI runs eight more things this tool refuses to
 * turn into gates", and only the second is true of a real repository.
 */
export type DraftExclusionReason =
  /** Dependency / toolchain installation; not a check. */
  | 'setup'
  /** Talks to a registry or the network, so its verdict is not about the tree. */
  | 'network'
  /** Publishes, deploys or pushes — an outward effect a gate must never have. */
  | 'release'
  /** Needs a container runtime the worktree is not guaranteed to have. */
  | 'container'
  /** Rewrites the tree it is supposed to be judging (`lint --fix`, formatters). */
  | 'mutating'
  /** Minutes-long browser suites; declared gates run on every verification. */
  | 'long-running'
  /** A multi-line `run:` block, which the YAML subset cannot carry. */
  | 'multi-line'
  /** Shell composition (`&&`, `|`, `;`, redirection) outside quotes. */
  | 'multi-command'
  /** Uses `${{ }}` or a runner-only variable, so it cannot run in a worktree. */
  | 'runner-specific'
  /** Contains both quote characters, so no one-line scalar can carry it. */
  | 'unquotable'
  /** Its natural id collides with a built-in gate id. */
  | 'reserved-id'
  /** Prints a message; nothing is judged. */
  | 'not-a-check'
  /** A watcher (`vitest`, `--watch`): it never exits, so it can only time out. */
  | 'interactive'
  /** An umbrella script whose narrower suites are already gates. */
  | 'redundant';

/** Coarse kind of check, which decides ordering and the default timeout. */
export type DraftGateCategory = 'guard' | 'lint' | 'typecheck' | 'build' | 'test' | 'other';

/** One gate the draft proposes. */
export interface DraftGate {
  id: string;
  command: string;
  timeoutSec: number;
  category: DraftGateCategory;
  source: DraftSource;
}

/** One command the scan found and refused to turn into a gate. */
export interface DraftExclusion {
  command: string;
  reason: DraftExclusionReason;
  source: DraftSource;
}

/** Everything one scan of a repository produced. */
export interface VerifyDraft {
  gates: DraftGate[];
  excluded: DraftExclusion[];
  /** Repository-relative files that existed and were read. */
  scanned: string[];
}

/**
 * Fast-first, so a failure is readable top to bottom.
 *
 * The runner does not stop at the first failure, so the order is a reading
 * order, not a short-circuit — but a draft that puts a 30-minute suite ahead of
 * a 0.3-second guard makes the guard's whole point (a verdict in seconds)
 * unreachable.
 */
const CATEGORY_RANK: Record<DraftGateCategory, number> = {
  guard: 10,
  lint: 20,
  typecheck: 30,
  build: 40,
  other: 50,
  test: 60,
};

/**
 * Default `timeoutSec` per category.
 *
 * Generous rather than tight. A drafted timeout that fires under parallel load
 * turns a passing tree into `TIMEOUT`, and the reader of a fresh draft has no
 * way to tell that verdict apart from a real regression.
 */
const CATEGORY_TIMEOUT_SEC: Record<DraftGateCategory, number> = {
  guard: 120,
  lint: 900,
  typecheck: 900,
  build: 1800,
  test: 1800,
  other: DEFAULT_TIMEOUT_SEC,
};

/**
 * npm script names whose gate id is fixed rather than derived.
 *
 * `test:unit` becomes `unit`, not `test-unit`: the vocabulary the rest of the
 * product uses for that gate — `docs/design/verification-config.md`, the
 * contract's `verify.gates`, this repository's own verify.yaml — is `unit`.
 */
const NPM_SCRIPT_GATE_IDS: Record<string, string> = {
  lint: 'lint',
  typecheck: 'typecheck',
  'type-check': 'typecheck',
  types: 'typecheck',
  test: 'test',
  'test:unit': 'unit',
  'test:integration': 'integration',
  build: 'build',
};

/**
 * npm script names taken from `package.json` when CI did not run them.
 *
 * A closed list on purpose: `scripts` also holds `dev`, `db:reset` and
 * `prepublishOnly`, and a drafter that turned every script into a gate would
 * propose starting the dev server as a verification step.
 */
const SUPPLEMENTAL_NPM_SCRIPTS = [
  'lint',
  'typecheck',
  'type-check',
  'test',
  'test:unit',
  'test:integration',
  'build',
  'build:cli',
  'build:server',
];

const WORKFLOW_DIR = '.github/workflows';
const PACKAGE_JSON = 'package.json';

/** `${{ … }}`, `$RUNNER_TEMP`, `$GITHUB_OUTPUT`: only a CI runner defines these. */
const RUNNER_ONLY = /\$\{\{|\$\{?(RUNNER|GITHUB)_/;

const CATEGORY_BY_ID: Record<string, DraftGateCategory> = {
  lint: 'lint',
  typecheck: 'typecheck',
  test: 'test',
  unit: 'test',
  integration: 'test',
};

// =============================================================================
// Scanning
// =============================================================================

/**
 * Scan a repository and propose gates.
 *
 * Never throws for a malformed workflow: a repository with one unparseable YAML
 * file still has a usable answer in the others, and a drafter that refuses
 * everything because of one file sends the reader back to writing the config by
 * hand — which is the state this exists to end.
 */
export function draftVerifyGates(repoPath: string): VerifyDraft {
  const gates: DraftGate[] = [];
  const excluded: DraftExclusion[] = [];
  const scanned: string[] = [];
  /** Commands already decided, so a step repeated across jobs is judged once. */
  const seenCommands = new Set<string>();
  const usedIds = new Set<string>();

  const consider = (command: string, source: DraftSource): void => {
    const normalized = command.trim();
    if (normalized === '' || seenCommands.has(normalized)) return;
    seenCommands.add(normalized);

    const reason = refuse(normalized);
    if (reason !== null) {
      excluded.push({ command: normalized, reason, source });
      return;
    }

    const id = uniqueGateId(deriveGateId(normalized), usedIds);
    if (id === null) {
      excluded.push({ command: normalized, reason: 'reserved-id', source });
      return;
    }
    usedIds.add(id);
    const category = categorize(id, normalized);
    gates.push({ id, command: normalized, timeoutSec: CATEGORY_TIMEOUT_SEC[category], category, source });
  };

  for (const file of listWorkflowFiles(repoPath)) {
    const relative = `${WORKFLOW_DIR}/${file}`;
    const document = readYaml(join(repoPath, relative));
    if (document === null) continue;
    scanned.push(relative);
    for (const step of workflowRunSteps(document, relative)) {
      consider(step.command, step.source);
    }
  }

  const pkg = readJson(join(repoPath, PACKAGE_JSON));
  if (pkg !== null) {
    scanned.push(PACKAGE_JSON);
    const scripts = isMapping(pkg.scripts) ? pkg.scripts : {};
    for (const name of SUPPLEMENTAL_NPM_SCRIPTS) {
      const body = scripts[name];
      if (typeof body !== 'string') continue;
      const command = `npm run ${name}`;
      const source: DraftSource = { kind: 'npm-script', file: PACKAGE_JSON, script: name };
      if (seenCommands.has(command)) continue;

      // The two refusals that need the script's *body*, which `refuse()` — which
      // only ever sees `npm run <name>` — cannot reach.
      if (name === 'test' && gates.some((gate) => gate.category === 'test')) {
        seenCommands.add(command);
        excluded.push({ command, reason: 'redundant', source });
        continue;
      }
      if (isWatcher(body)) {
        seenCommands.add(command);
        excluded.push({ command, reason: 'interactive', source });
        continue;
      }
      consider(command, source);
    }
  }

  gates.sort((a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]);
  return { gates, excluded, scanned };
}

/**
 * True when a script starts a watcher rather than running once.
 *
 * `npm test` is `vitest` (watch) in a great many repositories, including this
 * one, while `npm run test:unit` is `vitest run`. Drafted as a gate, the watcher
 * would sit at the prompt until `timeoutSec` elapsed and report TIMEOUT — a red
 * verdict that says nothing at all about the tree.
 */
function isWatcher(script: string): boolean {
  if (/--watch\b/.test(script) || /(^|\s)nodemon(\s|$)/.test(script)) return true;
  if (/(^|\s)vitest(\s|$)/.test(script) && !/(^|\s)vitest\s+(run|related)(\s|$)/.test(script)) {
    return true;
  }
  return false;
}

/** `.github/workflows/*.yml|yaml`, sorted so a scan is reproducible. */
function listWorkflowFiles(repoPath: string): string[] {
  try {
    return readdirSync(join(repoPath, WORKFLOW_DIR))
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .sort();
  } catch {
    return [];
  }
}

interface WorkflowStep {
  command: string;
  source: DraftSource;
}

/** Every `run:` step of every job, in declaration order. */
function workflowRunSteps(document: Record<string, unknown>, file: string): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  const jobs = isMapping(document.jobs) ? document.jobs : {};

  for (const [job, rawJob] of Object.entries(jobs)) {
    if (!isMapping(rawJob) || !Array.isArray(rawJob.steps)) continue;
    rawJob.steps.forEach((rawStep, index) => {
      if (!isMapping(rawStep) || typeof rawStep.run !== 'string') return;
      const step = typeof rawStep.name === 'string' ? rawStep.name : `step ${index + 1}`;
      steps.push({ command: rawStep.run, source: { kind: 'workflow', file, job, step } });
    });
  }
  return steps;
}

// =============================================================================
// Classification
// =============================================================================

/** Refusal reason for a command, or null when it may become a gate. */
export function refuse(command: string): DraftExclusionReason | null {
  if (/\r?\n/.test(command.trim())) return 'multi-line';
  if (RUNNER_ONLY.test(command)) return 'runner-specific';
  // `echo "::warning …"` is how a workflow talks to the runner's log. It exits 0
  // whatever the tree contains, so as a gate it is a green light wired to nothing.
  if (/::(warning|error|notice|group|set-output|add-mask)/.test(command)) return 'runner-specific';
  if (hasShellComposition(command)) return 'multi-command';

  if (/^(echo|printf|true|false|:)(\s|$)/.test(command)) return 'not-a-check';

  if (/(^|\s)(npm|pnpm|yarn|bun)\s+(ci|install|i|add)(\s|$)/.test(command)) return 'setup';
  if (/playwright\s+install/.test(command)) return 'setup';
  if (/(^|\s)(apt-get|apt|brew|pip)\s+install(\s|$)/.test(command)) return 'setup';

  if (/(^|\s)(npm|pnpm|yarn)\s+audit(\s|$)/.test(command)) return 'network';
  if (/(^|\s)(curl|wget)(\s|$)/.test(command)) return 'network';

  if (/(^|\s)(npm|pnpm|yarn)\s+publish(\s|$)/.test(command)) return 'release';
  if (/(^|\s)gh\s+release(\s|$)/.test(command)) return 'release';
  if (/(^|\s)git\s+push(\s|$)/.test(command)) return 'release';
  if (/\bdeploy\b/.test(command)) return 'release';

  if (/(^|\s)docker(\s|$)/.test(command)) return 'container';

  if (/(:|\s|-)fix(\s|$)/.test(command)) return 'mutating';
  if (/(^|\s)(prettier|black|gofmt)(\s|$)/.test(command) && !/--check/.test(command)) {
    return 'mutating';
  }

  if (/playwright\s+test/.test(command)) return 'long-running';
  if (/\be2e\b/.test(command)) return 'long-running';

  if (quoteFor(command) === null) return 'unquotable';
  return null;
}

/**
 * True when the command composes several commands or redirects.
 *
 * Quote-aware: `sh -c 'A && B'` is one command whose *argument* happens to
 * contain `&&`, and refusing it would rule out the one spelling that lets a
 * gate carry an environment variable (`sh -c 'CI=true npm test'`).
 */
function hasShellComposition(command: string): boolean {
  let quote: string | null = null;
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '&' || char === '|' || char === ';' || char === '>' || char === '<') return true;
    if (char === '`') return true;
  }
  return false;
}

/**
 * Gate id for a command.
 *
 * Reads the *command*, not the CI step's `name:`. Step names are prose
 * ("Run ESLint", "Build Next.js") in whatever language the workflow is written
 * in, while `npm run lint` names the same gate in every repository — and the id
 * is what a task contract's `verify.gates` and `commandmate verify --gates`
 * have to spell.
 */
export function deriveGateId(command: string): string {
  const npmRun = /^(?:npm|pnpm|yarn|bun)\s+run\s+([^\s]+)/.exec(command);
  if (npmRun) return NPM_SCRIPT_GATE_IDS[npmRun[1]] ?? sanitizeId(npmRun[1]);

  if (/(^|\s)tsc(\s|$)/.test(command) && /--noEmit/.test(command)) return 'typecheck';
  if (/(^|\s)(mypy|pyright)(\s|$)/.test(command)) return 'typecheck';
  if (/(^|\s)eslint(\s|$)/.test(command)) return 'lint';
  if (/(^|\s)ruff(\s|$)/.test(command)) return 'lint';
  if (/(^|\s)clippy|cargo\s+clippy/.test(command)) return 'lint';

  const script = /(?:^|\s)(?:node|npx\s+tsx|tsx|bash|sh)\s+([^\s]+\.(?:mjs|cjs|js|ts|sh))/.exec(
    command
  );
  if (script) return sanitizeId(basenameStem(script[1]).replace(/^check-/, ''));

  const runner = /^(?:make|cargo|go|poetry|uv|npx)\s+([^\s-][^\s]*)/.exec(command);
  if (runner) return sanitizeId(runner[1]);

  return sanitizeId(command.split(/\s+/)[0] ?? '');
}

/** `scripts/check-foo.mjs` -> `check-foo`. */
function basenameStem(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.[^.]+$/, '');
}

/** Squeeze an arbitrary token into {@link GATE_ID_PATTERN}'s shape. */
function sanitizeId(raw: string): string {
  const id = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return GATE_ID_PATTERN.test(id) ? id : '';
}

/**
 * A free id, or null when none can be formed.
 *
 * Two different commands deriving the same id get `-2`, `-3`, … rather than one
 * overwriting the other: both were in CI, and dropping one silently would make
 * the draft claim CI checks less than it does.
 */
function uniqueGateId(base: string, used: Set<string>): string | null {
  if (base === '' || (RESERVED_GATE_IDS as readonly string[]).includes(base)) return null;
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix <= 9; suffix += 1) {
    const candidate = `${base.slice(0, 30)}-${suffix}`;
    if (!used.has(candidate) && GATE_ID_PATTERN.test(candidate)) return candidate;
  }
  return null;
}

function categorize(id: string, command: string): DraftGateCategory {
  const known = CATEGORY_BY_ID[id];
  if (known) return known;
  if (id.startsWith('build')) return 'build';
  if (id.startsWith('test') || /\btest\b/.test(command)) return 'test';
  if (/(^|\s)(node|bash|sh)\s+\S+\.(mjs|cjs|js|ts|sh)/.test(command)) return 'guard';
  return 'other';
}

// =============================================================================
// Rendering
// =============================================================================

/**
 * Quote character a one-line YAML scalar can carry this command in, or null.
 *
 * `verify-run.sh` strips one pair of outer quotes and performs no unescaping,
 * so the only spellings both parsers agree on are "wrapped in a quote character
 * the command does not itself contain". A backslash rules out double quotes for
 * the same reason: the YAML parser would unescape it and awk would not.
 */
export function quoteFor(command: string): '"' | "'" | null {
  if (!command.includes('"') && !command.includes('\\')) return '"';
  if (!command.includes("'")) return "'";
  return null;
}

const EXCLUSION_NOTE: Record<DraftExclusionReason, string> = {
  setup: 'dependency install, not a check',
  network: 'reaches the network, so its verdict is not about this tree',
  release: 'has an outward effect; a gate must be safe to re-run',
  container: 'needs a container runtime',
  mutating: 'rewrites the tree it would be judging',
  'long-running': 'minutes-long; declared gates run on every verification',
  'multi-line': 'multi-line shell block',
  'multi-command': 'composes several commands',
  'runner-specific': 'uses a CI-runner-only variable',
  unquotable: 'contains both quote characters',
  'reserved-id': 'its id is reserved for a built-in gate',
  'not-a-check': 'prints a message; nothing is judged',
  interactive: 'runs in watch mode and never exits',
  redundant: 'umbrella script; the narrower suites are already gates',
};

/**
 * Render a draft as `.commandmate/verify.yaml` v1.
 *
 * Inside the Skill runner's YAML subset: two-space indent, one-line scalars,
 * comments only on lines of their own. Provenance is a comment above each gate
 * because the first question asked of a generated config is "where did this
 * come from, and may I delete it".
 */
export function renderVerifyYaml(draft: VerifyDraft): string {
  const lines: string[] = [
    `# ${VERIFY_CONFIG_RELATIVE_PATH} — v1`,
    '# Drafted by `commandmate verify init` (Issue #2061) from this repository.',
    '# Spec: docs/design/verification-config.md',
    '#',
    '# Review before relying on it: the draft says what CI already runs, not what',
    '# this repository considers sufficient. Gate order is the reporting order,',
    '# fast checks first.',
  ];

  if (draft.scanned.length > 0) {
    lines.push(`# Scanned: ${draft.scanned.join(', ')}`);
  }
  lines.push('version: 1', 'gates:');

  for (const gate of draft.gates) {
    lines.push(`  # from ${describeSource(gate.source).replace(/\s+/g, ' ')}`);
    lines.push(`  - id: ${gate.id}`);
    lines.push(`    command: ${quoteCommand(gate.command)}`);
    lines.push(`    timeoutSec: ${gate.timeoutSec}`);
  }

  if (draft.excluded.length > 0) {
    lines.push('# Found in CI and NOT drafted as gates:');
    for (const item of draft.excluded) {
      lines.push(`#   ${summarize(item.command)}`);
      lines.push(`#     ${item.reason}: ${EXCLUSION_NOTE[item.reason]}`);
    }
  }

  lines.push(
    'options:',
    '  skipInPrimaryCheckout: true',
    '  maxLogTailBytes: 8192',
    '  # baseRef: origin/main   # uncomment and set the branch work is compared against',
    '  # requireCommit: true    # require a commit, not just a dirty tree'
  );

  return `${lines.join('\n')}\n`;
}

/** Wrap a command in a quote character it does not contain. */
function quoteCommand(command: string): string {
  const quote = quoteFor(command);
  // Unreachable for a drafted gate: `refuse()` rejects an unquotable command
  // before it becomes one. Kept so a hand-built draft cannot emit a broken file.
  if (quote === null) throw new Error(`command cannot be rendered as a one-line scalar: ${command}`);
  return `${quote}${command}${quote}`;
}

/** One line of provenance: which file, which job, which step. */
export function describeSource(source: DraftSource): string {
  if (source.kind === 'npm-script') return `${source.file} (scripts.${source.script})`;
  const job = source.job ? ` (job: ${source.job}` : '';
  const step = source.step ? `, step: ${source.step})` : job ? ')' : '';
  return `${source.file}${job}${step}`;
}

/** Keep a comment line readable when CI holds a very long command. */
function summarize(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 99)}…` : oneLine;
}

// =============================================================================
// Writing
// =============================================================================

/** Why {@link writeVerifyConfigDraft} declined to write. */
export type DraftRefusal = 'exists' | 'no-gates';

export interface DraftWriteResult {
  created: boolean;
  /** Absolute path of the config, whether or not it was written. */
  configPath: string;
  /** The same path, repository-relative, for messages. */
  relativePath: string;
  draft: VerifyDraft;
  /** Rendered YAML — the file's content when created, the proposal otherwise. */
  yaml: string;
  refusedBecause?: DraftRefusal;
}

/**
 * What {@link writeVerifyConfigDraft} would do, without touching the disk.
 *
 * `created` is always false here — nothing was. `refusedBecause` carries the
 * same vocabulary the writer uses, so `commandmate verify init --dry-run` and a
 * real run report the same thing about the same repository instead of the
 * preview growing its own idea of when a draft is refused.
 */
export function planVerifyConfigDraft(repoPath: string): DraftWriteResult {
  const configPath = join(repoPath, VERIFY_CONFIG_RELATIVE_PATH);
  const draft = draftVerifyGates(repoPath);
  const base: DraftWriteResult = {
    created: false,
    configPath,
    relativePath: VERIFY_CONFIG_RELATIVE_PATH,
    draft,
    yaml: draft.gates.length > 0 ? renderVerifyYaml(draft) : '',
  };

  if (existsSync(configPath)) return { ...base, refusedBecause: 'exists' };
  if (draft.gates.length === 0) return { ...base, refusedBecause: 'no-gates' };
  return base;
}

/**
 * Draft and write `<repoPath>/.commandmate/verify.yaml`.
 *
 * **Never overwrites.** An existing config is the repository's own judgement of
 * what passing means, usually with the reasoning for each gate in comments
 * beside it; regenerating over it would replace a considered file with a guess
 * and destroy the reasoning, and no `--force` is offered because "I meant to
 * throw it away" is spelled by deleting the file.
 */
export function writeVerifyConfigDraft(repoPath: string): DraftWriteResult {
  const base = planVerifyConfigDraft(repoPath);
  if (base.refusedBecause !== undefined) return base;
  const { configPath } = base;

  mkdirSync(dirname(configPath), { recursive: true });
  // `wx` rather than a plain write: the `existsSync` in `planVerifyConfigDraft`
  // is a check, this is the guarantee. Two callers racing (the CLI and the
  // pane's button) must not both believe they created the file.
  try {
    writeFileSync(configPath, base.yaml, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ...base, created: false, refusedBecause: 'exists' };
    }
    throw error;
  }
  return { ...base, created: true };
}

// =============================================================================
// Small readers
// =============================================================================

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readYaml(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = parseYaml(readFileSync(path, 'utf8'));
    return isMapping(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isMapping(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
