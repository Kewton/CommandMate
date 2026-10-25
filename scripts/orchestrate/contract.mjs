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
 *   isolatedLiveCheck: [server, tmux]   # allow an isolated live check (orchestrate.md 2-5 / 2-6)
 *   refactor: { mergesCopies: true }    # kind: refactor only, and required there (orchestrate.md 2-4-3)
 *   routes:                  # optional: the route × interrupt table (orchestrate.md 2-4, #3884)
 *     order: ["…"]           # the interrupt order the change must keep (await points, record → compare)
 *     exclude: { columns: { push: "<reason>" }, rows: { legacy: "<reason>" } }
 *     cells: [{ row: disable, column: poller, tests: ["tests/unit/…test.ts"] },
 *             { row: disable, column: hook, excluded: "<reason>" }]
 *     extraColumns: [tile]   # routes beyond ROUTE_COLUMNS (extraRows likewise)
 *
 * The checks below hold the OUTPUT contract to the limits of the canonical
 * parser (src/lib/tasks/contract-parser.ts `parseTaskContract`), so a config
 * that generates is a contract `send --contract` accepts. A .mjs cannot import
 * the TS parser at run time; the test compares the two verdicts instead.
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
export const REFACTOR_RULES_TEMPLATE = path.join(TEMPLATE_DIR, 'refactor-rules.md');

// Same bounds as src/lib/tasks/contract-parser.ts (and GATE_ID_PATTERN of verify-config.ts).
export const MAX_GOAL_LENGTH = 8000;
export const MAX_TITLE_LENGTH = 200;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_SCOPE_PATTERNS = 200;
export const MAX_GATE_IDS = 32;
export const GATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const ORCHESTRATE_PATH = path.resolve(HERE, '../../.claude/commands/orchestrate.md');
/** isolatedLiveCheck kind → the orchestrate.md section whose rules the goal carries. */
const ISOLATION_SECTIONS = { tmux: '2-5', server: '2-6' };
export const REPO_URL = 'https://github.com/Kewton/CommandMate';
export const SHARED_FILES = ['CHANGELOG.md', 'docs/module-reference.md'];
export const DEFAULT_GATES = ['lint', 'typecheck', 'unit-related'];
/** 2-4-3: a refactor is judged by lint / typecheck locally; the full suite runs in the PR's CI. */
export const REFACTOR_DEFAULT_GATES = ['lint', 'typecheck'];
export const UNIT_RELATED_GATE = {
  id: 'unit-related',
  command: 'node scripts/run-related-unit-tests.mjs --base origin/develop',
  timeoutSec: 5400,
  mutex: 'cpu.heavy',
};

/**
 * The routes table (#3884): columns are the paths that read or publish a shared
 * state, rows the interrupts a change has to survive. Every cell is either tied
 * to a test or excluded with a reason — a table that only exists passes nothing.
 */
export const ROUTE_COLUMNS = {
  poller: 'poller',
  hook: 'hook',
  'prompt-response': 'prompt-response',
  'current-output': 'current-output',
  ws: 'WS',
  push: 'push',
  wait: 'wait',
  observe: '観測',
  pc: 'PC',
  mobile: 'スマホ／タイル',
};
export const ROUTE_ROWS = {
  disable: '無効化',
  'manual-answer': '手動回答',
  'interval-change': '区間変更',
  'generation-change': '世代変更',
  missing: '欠落',
  legacy: '旧形式',
};
const ROUTE_TOKEN = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A test a cell is tied to: a test file under tests/, optionally `<file> > <test name>`. */
const ROUTE_TEST = /^tests\/[^\s]+\.(?:test|spec)\.[cm]?[jt]sx?(?: > .+)?$/;

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

const SECTION_MARK = /^#! (>>>|<<<) ([a-z-]+)$/;

/**
 * A template with its `#!` note lines removed. Lines between `#! >>> <name>` and
 * `#! <<< <name>` are kept only when `<name>` is in `include`.
 *
 * @param {string} file
 * @param {{ include?: string[] }} [options]
 */
export function readTemplate(file, { include = [] } = {}) {
  let skipping = null;
  const kept = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const mark = line.match(SECTION_MARK);
    if (mark) {
      const [, edge, name] = mark;
      if (edge === '>>>' && skipping === null && !include.includes(name)) skipping = name;
      else if (edge === '<<<' && skipping === name) skipping = null;
      continue;
    }
    if (skipping !== null || line.startsWith('#!')) continue;
    kept.push(line);
  }
  if (skipping !== null) throw new Error(`${file}: "#! >>> ${skipping}" has no "#! <<< ${skipping}"`);
  return kept.join('\n');
}

/**
 * Whether a scope pattern names exactly one file. The scope gate
 * (src/lib/verification/scope-gate.ts `globToRegExp`) lets a pattern that
 * matches a directory match everything beneath it, so `tests/unit` and
 * `tests/unit/` mean `tests/unit/**`. A file is a pattern with no glob
 * character (`*`, `?`, `{`; `[` `]` are literal there) whose last segment has an
 * extension, like `tests/unit/x/a.test.ts`.
 */
export function namesOneFile(pattern) {
  if (/[*?{]/.test(pattern) || pattern.endsWith('/')) return false;
  const last = pattern.split('/').pop() ?? '';
  return /^[^.].*\.[A-Za-z0-9]+$/.test(last);
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
  const fullTitle = `Issue #${issue}: ${title}`;
  if (fullTitle.length > MAX_TITLE_LENGTH) {
    problems.push(`title: the contract title "Issue #${issue}: …" is ${fullTitle.length} characters, at most ${MAX_TITLE_LENGTH}`);
  }

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

  const defaultGates = kindName === 'refactor' ? REFACTOR_DEFAULT_GATES : DEFAULT_GATES;
  const gates = raw.gates === undefined ? [...defaultGates] : stringList(raw.gates, 'gates', problems);
  if (raw.gates !== undefined && gates.length === 0) problems.push('gates: at least one gate is required');
  if (gates.length > MAX_GATE_IDS) problems.push(`gates: at most ${MAX_GATE_IDS} (got ${gates.length})`);
  gates.forEach((id, index) => {
    if (!GATE_ID_PATTERN.test(id)) problems.push(`gates[${index}]: "${id}" must match ${GATE_ID_PATTERN.source}`);
    else if (gates.indexOf(id) !== index) problems.push(`gates[${index}]: duplicate gate id "${id}"`);
  });

  const fragment = `changelog.d/${issue}.md`;
  const scope = stringList(raw.scope, 'scope', problems);
  if (scope.length === 0) problems.push('scope: at least one path is required');
  for (const shared of SHARED_FILES) {
    if (scope.includes(shared)) problems.push(`scope: ${shared} is shared — the worker writes a fragment instead (2-4-1)`);
  }
  if (!scope.includes(fragment)) scope.push(fragment);
  if (scope.length > MAX_SCOPE_PATTERNS) problems.push(`scope: at most ${MAX_SCOPE_PATTERNS} patterns (got ${scope.length})`);
  scope.forEach((pattern, index) => {
    const at = `scope[${index}]`;
    if (pattern.length > MAX_PATTERN_LENGTH) problems.push(`${at}: at most ${MAX_PATTERN_LENGTH} characters (got ${pattern.length})`);
    else if (pattern.includes('\0')) problems.push(`${at}: must not contain a NUL byte`);
    else if (pattern.startsWith('/')) problems.push(`${at}: must be relative to the worktree root (got "${pattern}")`);
    else if (pattern.split('/').includes('..')) problems.push(`${at}: must not escape the worktree root with ".." (got "${pattern}")`);
  });

  // 2-4-3: a refactor must not rewrite tests — only the tests the contract names, for their import lines.
  if (kindName === 'refactor') {
    for (const pattern of scope) {
      // `tests`, `tests/…`, and anything that starts with a wildcard (`**/*.test.ts`) can reach tests/.
      const reachesTests = pattern === 'tests' || pattern.startsWith('tests/') || /^[*?{]/.test(pattern);
      if (reachesTests && !namesOneFile(pattern)) {
        problems.push(`scope: a refactor names test files one by one, not "${pattern}" (2-4-3)`);
      }
    }
  }

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

  const isolatedLiveCheck = stringList(raw.isolatedLiveCheck, 'isolatedLiveCheck', problems);
  for (const kind of isolatedLiveCheck) {
    if (!(kind in ISOLATION_SECTIONS)) {
      problems.push(`isolatedLiveCheck: must list ${Object.keys(ISOLATION_SECTIONS).join(' / ')} (got ${kind})`);
    }
  }

  // Whether the `git diff --shortstat` rule applies is the step's own call (2-4-3
  // "採用の基準"), so a refactor config has to say it; nothing else may.
  let mergesCopies = null;
  if (kindName === 'refactor') {
    if (typeof raw.refactor?.mergesCopies !== 'boolean') {
      problems.push('refactor.mergesCopies: required for kind refactor — true merges copies (adds the shortstat rule), false splits a long function');
    } else {
      mergesCopies = raw.refactor.mergesCopies;
    }
  } else if (raw.refactor !== undefined) {
    problems.push(`refactor: only for kind refactor (got kind ${kindName})`);
  }

  const routes = raw.routes === undefined ? null : normalizeRoutes(raw.routes, problems);

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
    isolatedLiveCheck,
    mergesCopies,
    routes,
  };
}

function extraTokens(value, name, known, problems) {
  const tokens = stringList(value, name, problems);
  tokens.forEach((token, index) => {
    if (!ROUTE_TOKEN.test(token)) problems.push(`${name}[${index}]: "${token}" must match ${ROUTE_TOKEN.source}`);
    else if (token in known || tokens.indexOf(token) !== index) problems.push(`${name}[${index}]: "${token}" is already a ${name.endsWith('Columns') ? 'column' : 'row'}`);
  });
  return tokens;
}

function reasonMap(value, name, known, problems) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${name}: must be a mapping of name → reason`);
    return {};
  }
  /** @type {Record<string, string>} */
  const reasons = {};
  for (const [key, reason] of Object.entries(value)) {
    if (!known.includes(key)) problems.push(`${name}: unknown "${key}" (one of ${known.join(' / ')})`);
    else if (typeof reason !== 'string' || reason.trim() === '') problems.push(`${name}.${key}: the reason must be a non-empty string`);
    else reasons[key] = reason.trim();
  }
  return reasons;
}

/**
 * Validate `routes` (#3884). Every row × column is covered by exactly one of:
 * a cell with tests, a cell excluded with a reason, or a whole row / column
 * excluded with a reason. At least one cell must name a test.
 *
 * @returns {{ columns: string[], rows: string[], labels: Record<string, string>, order: string[],
 *   excludedColumns: Record<string, string>, excludedRows: Record<string, string>,
 *   cells: Array<{ row: string, column: string, tests?: string[], excluded?: string }> } | null}
 */
export function normalizeRoutes(raw, problems) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('routes: must be a mapping (order / exclude / cells / extraColumns / extraRows)');
    return null;
  }
  const allowed = ['order', 'exclude', 'cells', 'extraColumns', 'extraRows'];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) problems.push(`routes.${key}: unknown key (one of ${allowed.join(' / ')})`);
  }
  const columns = [...Object.keys(ROUTE_COLUMNS), ...extraTokens(raw.extraColumns, 'routes.extraColumns', ROUTE_COLUMNS, problems)];
  const rows = [...Object.keys(ROUTE_ROWS), ...extraTokens(raw.extraRows, 'routes.extraRows', ROUTE_ROWS, problems)];
  const labels = { ...Object.fromEntries(columns.map((c) => [c, c])), ...Object.fromEntries(rows.map((r) => [r, r])), ...ROUTE_COLUMNS, ...ROUTE_ROWS };
  const order = stringList(raw.order, 'routes.order', problems);

  const exclude = raw.exclude ?? {};
  if (exclude === null || typeof exclude !== 'object' || Array.isArray(exclude)) problems.push('routes.exclude: must be a mapping (columns / rows)');
  const excludedColumns = reasonMap(exclude?.columns, 'routes.exclude.columns', columns, problems);
  const excludedRows = reasonMap(exclude?.rows, 'routes.exclude.rows', rows, problems);

  /** @type {Array<{ row: string, column: string, tests?: string[], excluded?: string }>} */
  const cells = [];
  const seen = new Set();
  const rawCells = raw.cells === undefined ? [] : raw.cells;
  if (!Array.isArray(rawCells)) problems.push('routes.cells: must be a list');
  (Array.isArray(rawCells) ? rawCells : []).forEach((cell, index) => {
    const at = `routes.cells[${index}]`;
    if (cell === null || typeof cell !== 'object' || Array.isArray(cell)) {
      problems.push(`${at}: must be a mapping { row, column, tests | excluded }`);
      return;
    }
    const { row, column } = cell;
    if (!rows.includes(row)) return problems.push(`${at}: unknown row "${row}" (one of ${rows.join(' / ')})`);
    if (!columns.includes(column)) return problems.push(`${at}: unknown column "${column}" (one of ${columns.join(' / ')})`);
    const name = `${row} × ${column}`;
    if (seen.has(name)) return problems.push(`${at}: ${name} is listed twice`);
    seen.add(name);
    if (row in excludedRows) return problems.push(`${at}: ${name} is in row ${row}, already excluded`);
    if (column in excludedColumns) return problems.push(`${at}: ${name} is in column ${column}, already excluded`);
    const hasTests = cell.tests !== undefined;
    const hasReason = cell.excluded !== undefined;
    if (hasTests === hasReason) return problems.push(`${at}: ${name} needs exactly one of tests / excluded`);
    if (hasReason) {
      if (typeof cell.excluded !== 'string' || cell.excluded.trim() === '') return problems.push(`${at}: ${name} excluded needs a reason`);
      cells.push({ row, column, excluded: cell.excluded.trim() });
      return;
    }
    const tests = stringList(cell.tests, `${at}.tests`, problems);
    if (tests.length === 0) return problems.push(`${at}: ${name} needs at least one test`);
    const bad = tests.filter((test) => !ROUTE_TEST.test(test));
    if (bad.length > 0) return problems.push(`${at}: ${name} tests must be test files under tests/ (got ${bad.join(', ')})`);
    cells.push({ row, column, tests });
  });

  const uncovered = [];
  for (const row of rows) {
    if (row in excludedRows) continue;
    for (const column of columns) {
      if (!(column in excludedColumns) && !seen.has(`${row} × ${column}`)) uncovered.push(`${row} × ${column}`);
    }
  }
  if (uncovered.length > 0) {
    problems.push(`routes: ${uncovered.length} cell(s) have neither a test nor a reason: ${uncovered.join(', ')}`);
  }
  if (uncovered.length === 0 && !cells.some((cell) => cell.tests)) {
    problems.push('routes: every cell is excluded — tie at least one cell to a test');
  }
  return { columns, rows, labels, order, excludedColumns, excludedRows, cells };
}

/** The columns of a normalized routes table that have at least one cell tied to a test. */
export function testedColumns(routes) {
  return new Set(routes.cells.filter((cell) => cell.tests).map((cell) => cell.column));
}

/** The routes table as goal / brief lines (a row is an interrupt, a column a route). */
export function routesSection(routes, heading = '## 経路表と割込み表（行＝割込み、列＝経路。この契約で守る）') {
  const label = (name) => routes.labels[name] ?? name;
  const lines = ['', heading];
  if (routes.order.length > 0) lines.push('割込みの順序（変えない）:', ...routes.order.map((item) => `- ${item}`));
  lines.push('必要なセル（結び付けたテストを書く・通す）:');
  for (const cell of routes.cells.filter((c) => c.tests)) {
    lines.push(`- ${label(cell.row)} × ${label(cell.column)}: ${cell.tests.join(', ')}`);
  }
  lines.push('除外したセル（理由）:');
  for (const [column, reason] of Object.entries(routes.excludedColumns)) lines.push(`- 列 ${label(column)}（全行）: ${reason}`);
  for (const [row, reason] of Object.entries(routes.excludedRows)) lines.push(`- 行 ${label(row)}（全列）: ${reason}`);
  for (const cell of routes.cells.filter((c) => c.excluded)) lines.push(`- ${label(cell.row)} × ${label(cell.column)}: ${cell.excluded}`);
  lines.push('必要なセルのテストが無いまま完了しない。除外したセルや表に無い経路に変更が及ぶと分かったら、そこを変更せず「本文に無い指摘」として報告する。');
  return lines.join('\n');
}

/** Replace `{{NAME}}`; a line that is only a placeholder whose value is empty is dropped. */
/**
 * The rules 2-5 / 2-6 tell the orchestrator to transcribe, keyed by section id,
 * read from orchestrate.md (their only owner) with the `> ` stripped.
 */
export function isolationRules(orchestrate = fs.readFileSync(ORCHESTRATE_PATH, 'utf8')) {
  /** @type {Record<string, string>} */
  const rules = {};
  for (const id of Object.values(ISOLATION_SECTIONS)) {
    const lines = orchestrate.split('\n');
    const start = lines.findIndex((line) => line.startsWith(`### ${id}.`));
    if (start === -1) throw new Error(`orchestrate.md has no ### ${id}. section`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.startsWith('### ') || line.startsWith('## '));
    const block = (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.startsWith('>'));
    if (block.length === 0) throw new Error(`orchestrate.md ### ${id}. has no rules to transcribe`);
    rules[id] = block.map((line) => line.replace(/^> ?/, '')).join('\n');
  }
  return rules;
}

const PROCESS_BAN =
  '- tmux セッション、サーバー、バックグラウンドプロセスを起動しない。`$HOME` 配下にファイルを作らない（一時ファイルは `os.tmpdir()` 配下のみ）。';

function processRule(config) {
  if (config.isolatedLiveCheck.length === 0) return PROCESS_BAN;
  const rules = isolationRules();
  const ids = Object.entries(ISOLATION_SECTIONS)
    .filter(([kind]) => config.isolatedLiveCheck.includes(kind))
    .map(([, id]) => id)
    .sort();
  return [
    `- 実機の確認のために tmux セッション・サーバー・プロセスを起動してよいのは、次の隔離の手順（/orchestrate ${ids.join('・')}）に従うときだけ。それ以外では起動しない。` +
      '`$HOME` 配下にファイルを作らない（一時ファイルは `os.tmpdir()` 配下のみ）。',
    ...ids.map((id) => rules[id]),
  ].join('\n');
}

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
  // changelog-fragments.mjs: the entry follows the optional `<!-- bump: … -->` line (#3480).
  const fragmentRules = fill(readTemplate(FRAGMENT_RULES_TEMPLATE).replaceAll('<N>', String(config.issue)), {
    ENTRY_LINE: config.bump ? `3 行目。2 行目は最低の版の宣言 \`<!-- bump: ${config.bump} -->\`` : '2 行目',
    AFTER_ENTRY_LINE: config.bump ? '4 行目' : '3 行目',
  }).trimEnd();
  const sectionLines = [`- この Issue の断片は、1 行目を \`<!-- ### ${config.section} -->\` にする。`];
  if (config.bump) {
    sectionLines.push(`  2 行目は最低の版の宣言 \`<!-- bump: ${config.bump} -->\`、エントリは 3 行目。`);
  }
  const refactorRules =
    config.kind === 'refactor'
      ? readTemplate(REFACTOR_RULES_TEMPLATE, { include: config.mergesCopies ? ['merges-copies-only'] : [] })
          .replaceAll('<N>', String(config.issue))
          .trimEnd()
      : '';
  const prefix = config.commitScope ? `${config.commitType}(${config.commitScope})` : config.commitType;

  const goal = fill(readTemplate(GOAL_TEMPLATE), {
    ISSUE_URL: `${REPO_URL}/issues/${config.issue}`,
    KIND_LABEL: config.kindLabel,
    DECISIONS: decisions,
    ISSUE_BODY: issueBody,
    ROUTES: config.routes ? routesSection(config.routes) : '',
    SCOPE: config.scope.join(', '),
    TIER_RULE: config.model === 'sonnet' ? `- ${SONNET_RULE}` : '',
    PROCESS_RULE: processRule(config),
    REFACTOR_RULES: refactorRules,
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
    title: `Issue #${config.issue}: ${config.title}`, // length checked in normalizeConfig
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
