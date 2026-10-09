#!/usr/bin/env node
/**
 * Generate a `/orchestrate` task contract from a per-Issue config (Issue #3477).
 *
 * The 2026-10-06〜07 runs rebuilt this generator in the session scratchpad every
 * time, and the fixes made during a run (contract key separate from the Issue
 * number, the CHANGELOG section override, `requireCommit: true`) were lost with
 * it. The worker-facing rules live in `templates/` — this directory owns them,
 * and `.claude/commands/orchestrate.md` 2-4-1 / 2-4-2 only point here.
 *
 * Config: one YAML or JSON file per Issue.
 *
 *   issue: 3477              # required
 *   key: "3477-opus"         # contract file name issue-<key>.yaml (default: the Issue number)
 *   title: "<Issue title>"   # required
 *   kind: feature            # feature | bug | refactor | docs
 *   agent: claude            # claude | antigravity
 *   model: opus              # opus | sonnet ("-" / omitted for antigravity)
 *   gates: [lint, typecheck, unit-related]
 *   scope: ["scripts/orchestrate/**"]   # changelog.d/<issue>.md is added for you
 *   decisions: ["…"]         # answers to the Issue's open questions
 *   changelog: { section: Added, bump: minor }   # section overrides the kind default
 *   commit: { type: feat, scope: orchestrate }
 *   issueBody: "…"           # or issueBodyFile: <path relative to the config>
 *
 * Usage:
 *   node scripts/orchestrate/contract.mjs generate --config <file> [--worktree <dir>] [--out <file>] [--stdout] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { SECTION_ORDER } from '../changelog-fragments.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = path.join(HERE, 'templates');
export const GOAL_TEMPLATE = path.join(TEMPLATE_DIR, 'goal.md');
export const FRAGMENT_RULES_TEMPLATE = path.join(TEMPLATE_DIR, 'fragment-rules.md');

/** Same bound as `MAX_GOAL_LENGTH` in src/lib/tasks/contract-parser.ts. */
export const MAX_GOAL_LENGTH = 8000;
export const REPO_URL = 'https://github.com/Kewton/CommandMate';
export const SHARED_FILES = ['CHANGELOG.md', 'docs/module-reference.md'];
export const DEFAULT_GATES = ['lint', 'typecheck', 'unit-related'];
export const UNIT_RELATED_GATE = {
  id: 'unit-related',
  command: 'node scripts/run-related-unit-tests.mjs --base origin/develop',
  timeoutSec: 5400,
  mutex: 'cpu.heavy',
};

const KINDS = {
  feature: { label: '機能追加', section: 'Added', type: 'feat' },
  bug: { label: '不具合修正', section: 'Fixed', type: 'fix' },
  refactor: { label: '整理', section: 'Changed', type: 'refactor' },
  docs: { label: 'ドキュメント', section: 'Documentation', type: 'docs' },
};
const AGENTS = ['claude', 'antigravity'];
const MODELS = ['opus', 'sonnet'];
const BUMPS = ['minor', 'major'];

/** The line 2-4-2 requires in every sonnet goal (the escape hatch for the middle tier). */
export const SONNET_RULE =
  'Issue 本文に無い変更が必要に見えたら、そのファイルを変更せず、コミットメッセージ本文に「本文に無い指摘: <file>:<line> <内容>」と書いて報告すること。';

export class ContractConfigError extends Error {
  constructor(problems) {
    super(`contract config is invalid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ContractConfigError';
    this.problems = problems;
  }
}

/** A template with its `#!` note lines removed. */
export function readTemplate(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('#!'))
    .join('\n');
}

function stringList(value, name, problems) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    problems.push(`${name}: must be a list of non-empty strings`);
    return [];
  }
  return value.map((item) => item.trim());
}

/**
 * Validate a parsed config and fill in the defaults.
 *
 * @param {Record<string, unknown>} raw
 * @param {{ baseDir?: string }} [options] where `issueBodyFile` is resolved from
 */
export function normalizeConfig(raw, options = {}) {
  const problems = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ContractConfigError(['the config must be a mapping']);
  }

  const issue = Number(raw.issue);
  if (!Number.isInteger(issue) || issue <= 0) problems.push(`issue: must be a positive integer (got ${raw.issue})`);

  // The contract key names the file; it is NOT the Issue number (a second
  // contract on the same branch is issue-<N>-opus.yaml, its fragment is still <N>).
  const key = raw.key === undefined ? String(issue) : String(raw.key);
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(key)) problems.push(`key: must be a file-name-safe token (got ${raw.key})`);

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) problems.push('title: required');

  const kindName = raw.kind === undefined ? 'feature' : raw.kind;
  const kind = KINDS[kindName];
  if (!kind) problems.push(`kind: must be one of ${Object.keys(KINDS).join(' / ')} (got ${raw.kind})`);

  const agent = raw.agent === undefined ? 'claude' : raw.agent;
  if (!AGENTS.includes(agent)) problems.push(`agent: must be one of ${AGENTS.join(' / ')} (got ${raw.agent})`);

  let model = raw.model === undefined || raw.model === '-' ? null : raw.model;
  if (agent === 'claude') {
    model = model ?? 'opus';
    if (!MODELS.includes(model)) problems.push(`model: must be one of ${MODELS.join(' / ')} (got ${raw.model})`);
  } else if (model !== null) {
    problems.push(`model: only a claude worker has a model (got ${raw.model} for ${agent})`);
  }

  const gates = raw.gates === undefined ? [...DEFAULT_GATES] : stringList(raw.gates, 'gates', problems);
  if (raw.gates !== undefined && gates.length === 0) problems.push('gates: at least one gate is required');

  const fragment = `changelog.d/${issue}.md`;
  const scope = stringList(raw.scope, 'scope', problems);
  if (scope.length === 0) problems.push('scope: at least one path is required');
  for (const shared of SHARED_FILES) {
    if (scope.includes(shared)) problems.push(`scope: ${shared} is shared — the worker writes a fragment instead (2-4-1)`);
  }
  if (!scope.includes(fragment)) scope.push(fragment);

  const decisions = stringList(raw.decisions, 'decisions', problems);

  const changelog = raw.changelog ?? {};
  const section = changelog.section ?? kind?.section;
  if (!SECTION_ORDER.includes(section)) {
    problems.push(`changelog.section: must be one of ${SECTION_ORDER.join(' / ')} (got ${changelog.section})`);
  }
  const bump = changelog.bump ?? null;
  if (bump !== null && !BUMPS.includes(bump)) problems.push(`changelog.bump: must be ${BUMPS.join(' / ')} (got ${bump})`);

  const commit = raw.commit ?? {};
  const commitType = commit.type ?? kind?.type;
  const commitScope = commit.scope ?? null;
  if (commitScope !== null && !/^[a-z0-9,-]+$/.test(commitScope)) problems.push(`commit.scope: must match [a-z0-9,-]+ (got ${commitScope})`);

  let issueBody = typeof raw.issueBody === 'string' ? raw.issueBody : null;
  if (raw.issueBodyFile !== undefined) {
    if (issueBody !== null) problems.push('issueBody and issueBodyFile are exclusive');
    const file = path.resolve(options.baseDir ?? process.cwd(), String(raw.issueBodyFile));
    try {
      issueBody = fs.readFileSync(file, 'utf8');
    } catch {
      problems.push(`issueBodyFile: cannot read ${file}`);
    }
  }

  if (problems.length > 0) throw new ContractConfigError(problems);
  return {
    issue,
    key,
    title,
    kind: kindName,
    kindLabel: kind.label,
    agent,
    model,
    gates,
    scope,
    decisions,
    section,
    bump,
    commitType,
    commitScope,
    issueBody: issueBody === null ? null : issueBody.trim(),
  };
}

/** Replace `{{NAME}}`; a line that is only a placeholder whose value is empty is dropped. */
function fill(template, values) {
  const valueOf = (match, name) => {
    if (!(name in values)) throw new Error(`template placeholder ${match} has no value`);
    return values[name];
  };
  return template
    .split('\n')
    .filter((line) => {
      const only = line.match(/^\{\{([A-Z_]+)\}\}$/);
      return !only || valueOf(only[0], only[1]) !== '';
    })
    .map((line) => line.replace(/\{\{([A-Z_]+)\}\}/g, valueOf))
    .join('\n');
}

/** Render the goal text from the templates. Throws when it exceeds MAX_GOAL_LENGTH. */
export function renderGoal(config) {
  const decisions =
    config.decisions.length === 0
      ? ''
      : `\n## この契約での決定（Issue の「決めること」への答え。これに従う）\n${config.decisions.map((d) => `- ${d}`).join('\n')}`;
  const issueBody = config.issueBody ? `\n## Issue 本文\n${config.issueBody}` : '';
  const fragmentRules = readTemplate(FRAGMENT_RULES_TEMPLATE).replaceAll('<N>', String(config.issue)).trimEnd();
  const sectionLines = [`- この Issue の断片は、1 行目を \`<!-- ### ${config.section} -->\` にする。`];
  if (config.bump) {
    sectionLines.push(`  2 行目に最低の版の宣言 \`<!-- bump: ${config.bump} -->\` を書き、エントリは 3 行目に置く。`);
  }
  const prefix = config.commitScope ? `${config.commitType}(${config.commitScope})` : config.commitType;

  const goal = fill(readTemplate(GOAL_TEMPLATE), {
    ISSUE_URL: `${REPO_URL}/issues/${config.issue}`,
    KIND_LABEL: config.kindLabel,
    DECISIONS: decisions,
    ISSUE_BODY: issueBody,
    SCOPE: config.scope.join(', '),
    TIER_RULE: config.model === 'sonnet' ? `- ${SONNET_RULE}` : '',
    FRAGMENT_RULES: fragmentRules,
    CHANGELOG_SECTION: sectionLines.join('\n'),
    COMMIT_PREFIX: prefix,
    ISSUE: String(config.issue),
  }).trim();

  if (goal.length > MAX_GOAL_LENGTH) {
    throw new ContractConfigError([
      `goal: ${goal.length} characters exceeds ${MAX_GOAL_LENGTH} — shorten issueBody or decisions`,
    ]);
  }
  return `${goal}\n`;
}

/** The contract as a plain object, in the key order of docs/design/task-contract.md. */
export function buildContract(config) {
  /** @type {{ gates: string[], gateDefinitions?: Array<typeof UNIT_RELATED_GATE> }} */
  const verify = { gates: config.gates };
  if (config.gates.includes('unit-related')) verify.gateDefinitions = [{ ...UNIT_RELATED_GATE }];
  return {
    version: 1,
    title: `Issue #${config.issue}: ${config.title}`,
    goal: renderGoal(config),
    scope: { allow: config.scope, deny: [] },
    verify,
    success: {
      requireWorkEvidence: true,
      // Never optional (#3430): without it an uncommitted tree passes `wait --verify`.
      requireCommit: true,
      requireScopeClean: true,
    },
  };
}

export function contractYaml(config) {
  return YAML.stringify(buildContract(config), { blockQuote: 'literal', lineWidth: 0 });
}

/** Read a config file (YAML or JSON — JSON is valid YAML) and normalize it. */
export function loadConfig(file) {
  const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  return normalizeConfig(raw, { baseDir: path.dirname(path.resolve(file)) });
}

export function contractPath(worktree, config) {
  return path.join(worktree, '.commandmate', 'tasks', `issue-${config.key}.yaml`);
}

/**
 * Write the contract. Re-running with the same config is a no-op; a different
 * contract already at the path is kept unless `force` (it may already be sent).
 *
 * @param {{ configFile: string, worktree?: string, out?: string, force?: boolean }} options
 * @returns {{ path: string, status: 'written' | 'unchanged' }}
 */
export function writeContract({ configFile, worktree = process.cwd(), out, force = false }) {
  const config = loadConfig(configFile);
  const text = contractYaml(config);
  const target = out ? path.resolve(out) : contractPath(worktree, config);
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, 'utf8') === text) return { path: target, status: 'unchanged' };
    if (!force) throw new Error(`${target} already exists with a different contract (pass --force to replace it)`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return { path: target, status: 'written' };
}

const USAGE =
  'Usage: node scripts/orchestrate/contract.mjs generate --config <file> [--worktree <dir>] [--out <file>] [--stdout] [--force]';

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'generate') {
    console.error(USAGE);
    return 2;
  }
  const options = { force: false, stdout: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--config') options.configFile = rest[++i];
    else if (arg === '--worktree') options.worktree = rest[++i];
    else if (arg === '--out') options.out = rest[++i];
    else if (arg === '--force') options.force = true;
    else if (arg === '--stdout') options.stdout = true;
    else {
      console.error(`unknown argument: ${arg}\n${USAGE}`);
      return 2;
    }
  }
  if (!options.configFile) {
    console.error(USAGE);
    return 2;
  }
  try {
    if (options.stdout) {
      process.stdout.write(contractYaml(loadConfig(options.configFile)));
      return 0;
    }
    const result = writeContract(options);
    console.log(`contract ${result.status}: ${result.path}`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
