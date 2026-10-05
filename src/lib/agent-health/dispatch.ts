/**
 * The daily hand-off of agent-health / catalog-drift / metrics Issues to `/orchestrate` on
 * develop's Claude 3 (Issue #3045). Used by `scripts/agent-health/dispatch.ts`.
 *
 * Pure: which Issues go (author, labels, caps, order), whether Claude 3 is
 * free, the request text, the record and the final line are decided here and
 * pinned by unit tests — never left to the scheduled AI's reading. The script
 * only runs gh / commandmate and writes the record.
 *
 * The destination is fixed ({@link DISPATCH_WORKTREE_ID} / {@link DISPATCH_INSTANCE_ID}):
 * no argument can point the send anywhere else.
 */

import path from 'path';
import type { DispatchIssue, DispatchIssueKind, DispatchRecord, DispatchStatus } from './dispatch-record';

export const DISPATCH_REPO = 'Kewton/CommandMate';
/** develop's worktree in CommandMate (the main checkout). */
export const DISPATCH_WORKTREE_ID = 'mycodebranchdesk';
/** Claude 3 — dedicated to this hand-off, so it may be `/clear`ed first. */
export const DISPATCH_INSTANCE_ID = 'claude-3';
export const DISPATCH_CLI_TOOL = 'claude';
/** Only Issues written by the owner: the repository is public, and an Issue body is read as instructions. */
export const DISPATCH_AUTHOR = 'kewton';

export const BUG_LABEL = 'agent-health';
export const METRICS_LABEL = 'metrics';
/** Slash-command catalog drift, filed by the daily check (#3158) and fixed per `/catalog-reconcile`'s unattended section (#3159). */
export const CATALOG_LABEL = 'catalog-drift';
/** Performance Issues are filed automatically but fixed by a person, so dispatch skips them. */
export const PERF_LABEL = 'perf';

/** Issues a person must judge (e.g. unused files: "reported" is not "safe to delete"), so dispatch skips them. */
export const NEEDS_HUMAN_LABEL = 'needs-human';
export const SECURITY_LABEL = 'security';
export const DISPATCHED_LABEL = 'auto-dispatched';
/** Labels the run relies on; the script never creates them (docs/user-guide/agent-health.md「自動依頼」). */
export const REQUIRED_LABELS = [BUG_LABEL, METRICS_LABEL, SECURITY_LABEL, CATALOG_LABEL, DISPATCHED_LABEL] as const;

/** Every bug goes, within the total cap. */
export const MAX_CATALOG_ISSUES = 1;
export const MAX_METRICS_ISSUES = 2;
export const MAX_TOTAL_ISSUES = 5;

/** Auto-Yes window for the run (a `commandmate send --duration` value). */
export const DISPATCH_AUTO_YES_DURATION = '8h';

// ---------------------------------------------------------------------------
// Target selection

export interface CandidateIssue {
  number: number;
  title: string;
  author: string;
  labels: string[];
  createdAt: string;
}

/** `gh issue list --json number,title,author,labels,createdAt` → candidates. Malformed rows are dropped. */
export function parseIssueList(json: unknown): CandidateIssue[] | null {
  if (!Array.isArray(json)) return null;
  const issues: CandidateIssue[] = [];
  for (const row of json) {
    if (typeof row !== 'object' || row === null) continue;
    const { number, title, author, labels, createdAt } = row as Record<string, unknown>;
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) continue;
    const login = typeof author === 'object' && author !== null ? (author as { login?: unknown }).login : undefined;
    issues.push({
      number,
      title: typeof title === 'string' ? title : '',
      author: typeof login === 'string' ? login : '',
      labels: Array.isArray(labels)
        ? labels
            .map((label) => (typeof label === 'object' && label !== null ? (label as { name?: unknown }).name : undefined))
            .filter((name): name is string => typeof name === 'string')
        : [],
      createdAt: typeof createdAt === 'string' ? createdAt : '',
    });
  }
  return issues;
}

/** `gh label list --json name` → names; null when it is not that shape. */
export function parseLabelNames(json: unknown): string[] | null {
  if (!Array.isArray(json)) return null;
  return json
    .map((row) => (typeof row === 'object' && row !== null ? (row as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string');
}

export function missingLabels(existing: readonly string[]): string[] {
  return REQUIRED_LABELS.filter((label) => !existing.includes(label));
}

/** The kind of a candidate, or null when it is not one (wrong author / label, or already dispatched). */
export function issueKind(issue: CandidateIssue): DispatchIssueKind | null {
  if (issue.author.toLowerCase() !== DISPATCH_AUTHOR) return null;
  if (issue.labels.includes(DISPATCHED_LABEL)) return null;
  if (issue.labels.includes(PERF_LABEL)) return null;
  if (issue.labels.includes(NEEDS_HUMAN_LABEL)) return null;
  if (issue.labels.includes(BUG_LABEL)) return 'bug';
  if (issue.labels.includes(CATALOG_LABEL)) return 'catalog';
  if (issue.labels.includes(METRICS_LABEL)) return 'metrics';
  return null;
}

function olderFirst(a: CandidateIssue, b: CandidateIssue): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.number - b.number;
}

export interface DispatchSelection {
  /** In the order they are handed to orchestrate. */
  issues: DispatchIssue[];
  /** Candidates over a cap, carried over to a later day (bugs, then catalog, then metrics, in priority order). */
  deferred: number[];
}

/**
 * Bugs (oldest first) → catalog drift (oldest first) → metrics (security first,
 * then the rest; oldest first within each). Bugs are all taken up to
 * {@link MAX_TOTAL_ISSUES}; catalog up to {@link MAX_CATALOG_ISSUES} and metrics up to
 * {@link MAX_METRICS_ISSUES}, each within what the total leaves. Anything over a cap is deferred.
 */
export function selectDispatchTargets(candidates: readonly CandidateIssue[]): DispatchSelection {
  const bugs = candidates.filter((issue) => issueKind(issue) === 'bug').sort(olderFirst);
  const catalog = candidates.filter((issue) => issueKind(issue) === 'catalog').sort(olderFirst);
  const metrics = candidates
    .filter((issue) => issueKind(issue) === 'metrics')
    .sort((a, b) => {
      const security = Number(b.labels.includes(SECURITY_LABEL)) - Number(a.labels.includes(SECURITY_LABEL));
      return security !== 0 ? security : olderFirst(a, b);
    });
  const takenBugs = bugs.slice(0, MAX_TOTAL_ISSUES);
  const takenCatalog = catalog.slice(0, Math.min(MAX_CATALOG_ISSUES, MAX_TOTAL_ISSUES - takenBugs.length));
  const metricsRoom = Math.min(MAX_METRICS_ISSUES, MAX_TOTAL_ISSUES - takenBugs.length - takenCatalog.length);
  const takenMetrics = metrics.slice(0, metricsRoom);
  const toIssue = (kind: DispatchIssueKind) => (issue: CandidateIssue): DispatchIssue => ({
    number: issue.number,
    kind,
    title: issue.title,
  });
  return {
    issues: [...takenBugs.map(toIssue('bug')), ...takenCatalog.map(toIssue('catalog')), ...takenMetrics.map(toIssue('metrics'))],
    deferred: [
      ...bugs.slice(takenBugs.length),
      ...catalog.slice(takenCatalog.length),
      ...metrics.slice(takenMetrics.length),
    ].map((issue) => issue.number),
  };
}

/** `3050-3051`: the run-file suffix orchestrate is asked to use (see DispatchRecord.runSuffix). */
export function runSuffixOf(issues: readonly DispatchIssue[]): string {
  return issues.map((issue) => issue.number).join('-');
}

// ---------------------------------------------------------------------------
// Claude 3's state (from `commandmate ls --json`)

export type AgentState =
  /** At its input prompt: may be sent to. */
  | { kind: 'ready' }
  /** No session: `commandmate send` starts one. */
  | { kind: 'not-running' }
  /** Working or at a prompt/dialog: do not send. */
  | { kind: 'busy'; detail: string }
  /** The worktree / instance is not what this script expects: do not send. */
  | { kind: 'unknown'; detail: string };

interface InstanceStatus {
  isRunning?: unknown;
  isProcessing?: unknown;
  isWaitingForResponse?: unknown;
  sessionStatusReason?: unknown;
}

/**
 * Claude 3's state in `commandmate ls --json` output. Ready means running,
 * not processing and not waiting on a prompt — what `ls` prints as `ready`.
 */
export function judgeAgentState(json: unknown): AgentState {
  if (!Array.isArray(json)) return { kind: 'unknown', detail: 'commandmate ls --json の出力が一覧でない' };
  const worktree = json.find(
    (row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null && (row as { id?: unknown }).id === DISPATCH_WORKTREE_ID
  );
  if (!worktree) return { kind: 'unknown', detail: `worktree ${DISPATCH_WORKTREE_ID} が無い` };
  const roster = Array.isArray(worktree.agentInstances) ? worktree.agentInstances : [];
  const instance = roster.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id === DISPATCH_INSTANCE_ID
  );
  if (!instance) return { kind: 'unknown', detail: `instance ${DISPATCH_INSTANCE_ID} が roster に無い` };
  if (instance.cliTool !== DISPATCH_CLI_TOOL) {
    return { kind: 'unknown', detail: `instance ${DISPATCH_INSTANCE_ID} の cliTool が ${String(instance.cliTool)}（${DISPATCH_CLI_TOOL} でない）` };
  }
  const byInstance = worktree.sessionStatusByInstance;
  const status =
    typeof byInstance === 'object' && byInstance !== null
      ? ((byInstance as Record<string, unknown>)[DISPATCH_INSTANCE_ID] as InstanceStatus | undefined)
      : undefined;
  if (!status || status.isRunning !== true) return { kind: 'not-running' };
  if (status.isWaitingForResponse === true) {
    return { kind: 'busy', detail: `プロンプト待ち（${String(status.sessionStatusReason ?? '-')}）` };
  }
  if (status.isProcessing !== false) {
    return { kind: 'busy', detail: `作業中（${String(status.sessionStatusReason ?? '-')}）` };
  }
  return { kind: 'ready' };
}

// ---------------------------------------------------------------------------
// What is sent

/** argv of `commandmate send` to Claude 3. Nothing but the message is variable. */
export function sendArgv(message: string, withAutoYes: boolean): string[] {
  return [
    'send',
    DISPATCH_WORKTREE_ID,
    message,
    '--instance',
    DISPATCH_INSTANCE_ID,
    ...(withAutoYes ? ['--auto-yes', '--duration', DISPATCH_AUTO_YES_DURATION] : []),
  ];
}

/**
 * Where the run's terms are written: `workspace/agent-health/<date>/dispatch-terms-<runSuffix>.md`
 * under the repository this runs in (absolute, so Claude 3 in another worktree can read it).
 */
export function dispatchTermsPath(repoRoot: string, date: string, issues: readonly DispatchIssue[]): string {
  return path.join(repoRoot, 'workspace', 'agent-health', date, `dispatch-terms-${runSuffixOf(issues)}.md`);
}

/**
 * The request for Claude 3: one line (a multi-line send arrives as a paste and
 * is not run as a slash command). It is the `/orchestrate` call (no `--full`:
 * UAT must not run in the main checkout) and the file holding the run's terms.
 */
export function buildRequest(issues: readonly DispatchIssue[], termsPath: string): string {
  return `/orchestrate ${issues.map((issue) => issue.number).join(' ')} ${termsPath} の条件に従うこと`;
}

/** Where a catalog-drift worker is pointed: the skill file, so a worker other than Claude Code can read it too. */
export const CATALOG_SKILL_PATH = '.claude/skills/catalog-reconcile/SKILL.md';

/** The run's terms, written to the file `buildRequest` points at. */
export function buildTerms(date: string, issues: readonly DispatchIssue[]): string {
  const numbers = issues.map((issue) => issue.number);
  const suffix = runSuffixOf(issues);
  const catalog = issues.filter((issue) => issue.kind === 'catalog').map((issue) => `#${issue.number}`);
  return [
    `（agent-health の自動依頼 ${date}。以下は利用者が事前に決めた、この run の条件）`,
    '- 本 run では PR の develop へのマージを進めてよい（利用者の明示的な許可）。main へはマージしない',
    numbers.length === 1
      ? '- 対象は 1 件だが、そのまま 1 件で実行する（1 件で動くことは確認済み）'
      : `- 対象は ${numbers.length} 件（${issues.map((issue) => `#${issue.number} ${issue.kind}`).join('、')}）`,
    '- `--full` は付けない（UAT を main の作業ディレクトリで走らせない）',
    ...(catalog.length > 0
      ? [
          `- catalog の Issue（${catalog.join('、')}）は \`/catalog-reconcile\` の無人実行節に従う。worker への契約に「\`${CATALOG_SKILL_PATH}\` を読み、無人実行の節に従う」と書く（除外の追加・変更・削除はしない。判断が要る候補は外して Issue にコメントする）。その PR の本文には「無人実行」と書き、Issue を参照する`,
        ]
      : []),
    `- run のファイルは workspace/orchestration/runs/${date}/ に plan-${suffix}.md・summary-${suffix}.md・tasks-${suffix}.tsv の名前で書く（同じ日の別の run と上書きし合わないため）`,
    `- 完了後（途中で止まったときも）に \`npx tsx scripts/agent-health/release-report.ts --date ${date}\` を実行し、HTML を workspace/agent-health/${date}/release-readiness.html に書く`,
    '- 失敗した Issue を今日のうちに再依頼・再実行しない（翌日の日次に回す）',
    '- kill 系の API・コマンドを使わない。他のインスタンス・worktree に send しない',
    '',
  ].join('\n');
}

/** Comment left on each dispatched Issue (the label is what keeps it from being picked again). */
export function dispatchComment(date: string, issue: DispatchIssue, all: readonly DispatchIssue[]): string {
  const others = all.filter((other) => other.number !== issue.number).map((other) => `#${other.number}`);
  return [
    `<!-- agent-health-dispatch:${date} -->`,
    `${date}（JST）に develop の Claude 3 へ \`/orchestrate\` を自動依頼した${others.length > 0 ? `（同時に依頼: ${others.join(', ')}）` : ''}。`,
    `ラベル \`${DISPATCHED_LABEL}\` が付いている間は翌日以降の自動依頼の対象にならない。`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Record and final line

export function buildDispatchRecord(input: {
  date: string;
  status: DispatchStatus;
  issues: readonly DispatchIssue[];
  deferred: readonly number[];
  sentAt?: string;
  reason?: string;
}): DispatchRecord {
  return {
    schemaVersion: 1,
    date: input.date,
    status: input.status,
    ...(input.status === 'sent' && input.sentAt ? { sentAt: input.sentAt } : {}),
    issues: [...input.issues],
    deferred: [...input.deferred],
    ...(input.status === 'sent' && input.issues.length > 0 ? { runSuffix: runSuffixOf(input.issues) } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

/** `AGENT_HEALTH_DISPATCH date=… status=… issues=… deferred=…[ reason=…]` */
export function formatDispatchLine(record: Pick<DispatchRecord, 'date' | 'status' | 'issues' | 'deferred' | 'reason'>): string {
  const list = (numbers: readonly number[]) => (numbers.length > 0 ? numbers.join(',') : '-');
  return [
    'AGENT_HEALTH_DISPATCH',
    `date=${record.date}`,
    `status=${record.status}`,
    `issues=${list(record.issues.map((issue) => issue.number))}`,
    `deferred=${list(record.deferred)}`,
    ...(record.reason ? [`reason=${JSON.stringify(record.reason)}`] : []),
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Arguments

export interface DispatchOptions {
  /** null → `$AGENT_HEALTH_DIR` or `~/.commandmate/agent-health`. */
  stateDir: string | null;
  /** Select and check only: no send, no label, no comment, no record. */
  dryRun: boolean;
}

export const DISPATCH_USAGE = [
  'Usage: npx tsx scripts/agent-health/dispatch.ts [--state-dir <dir>] [--dry-run]',
  '',
  `  Hands today's agent-health / catalog-drift / metrics Issues to /orchestrate on ${DISPATCH_WORKTREE_ID} (${DISPATCH_INSTANCE_ID}).`,
  '  --state-dir <dir>  where dispatch/<JST date>.json is written (default: $AGENT_HEALTH_DIR or ~/.commandmate/agent-health)',
  '  --dry-run          select and check only; print the request, send nothing and write nothing',
  '  -h, --help         show this help',
  '',
  'Exit: 0 sent / skipped-busy / no-target, 1 sent but labelling or the record failed,',
  '      2 not sent because something failed (missing label, gh / commandmate error, bad arguments).',
].join('\n');

export type DispatchParseResult = { ok: true; options: DispatchOptions } | { ok: false; error: string; help?: boolean };

export function parseDispatchArgs(argv: readonly string[]): DispatchParseResult {
  const options: DispatchOptions = { stateDir: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { ok: false, error: DISPATCH_USAGE, help: true };
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--state-dir' || arg.startsWith('--state-dir=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!value || value.startsWith('--')) return { ok: false, error: '--state-dir needs a directory' };
      options.stateDir = value;
      continue;
    }
    return { ok: false, error: `unknown argument: ${arg}\n\n${DISPATCH_USAGE}` };
  }
  return { ok: true, options };
}
