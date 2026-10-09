/**
 * Release readiness (GO / 要判断 / NO-GO) for `scripts/agent-health/release-report.ts`
 * (Issue #3046).
 *
 * Pure: the script collects facts (gh, git, files) and hands them here; the
 * verdict is decided by rules pinned in unit tests, never by an AI's guess.
 * Every reader tolerates a missing or malformed input as "none" — the report
 * must still be written on a day nothing was dispatched, or when #3044's
 * metrics are not there yet.
 */

import type { DispatchIssueKind, DispatchStatus } from './dispatch-record';
import { PRODUCT_SKIP_STREAK_ALERT_DAYS, type ProductVerdict } from './product-judgement';

// ---------------------------------------------------------------------------
// Dates (JST, like the rest of agent-health)

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** JST `YYYY-MM-DD` of an ISO timestamp; null when it does not parse. */
export function jstDateOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Date(time + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The latest date in `dates` that is on or before `limit` (`inclusive`) or
 * strictly before it. Used to find "the previous day" and "the day of the last
 * release" among the metrics files, which may have gaps.
 */
export function latestDateBefore(
  dates: readonly string[],
  limit: string,
  inclusive: boolean
): string | null {
  const candidates = dates
    .filter((date) => isIsoDate(date))
    .filter((date) => (inclusive ? date <= limit : date < limit))
    .sort();
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

// ---------------------------------------------------------------------------
// CI states

/** `unknown`: could not be read (gh missing, network); `none`: no checks ran. */
export type CiState = 'success' | 'failure' | 'pending' | 'none' | 'unknown';

type CheckOutcome = 'success' | 'failure' | 'pending';

const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function outcomeOf(status: string, conclusion: string | null | undefined): CheckOutcome {
  if (status.toLowerCase() !== 'completed') return 'pending';
  return OK_CONCLUSIONS.has((conclusion ?? '').toLowerCase()) ? 'success' : 'failure';
}

function combine(outcomes: readonly CheckOutcome[]): CiState {
  if (outcomes.length === 0) return 'none';
  if (outcomes.includes('failure')) return 'failure';
  if (outcomes.includes('pending')) return 'pending';
  return 'success';
}

export interface WorkflowRunInfo {
  workflowName: string;
  status: string;
  conclusion: string | null;
  /** ISO; the newest run of a workflow wins (a re-run replaces a failed run). */
  createdAt?: string;
}

/** `gh run list --commit <sha>` → one state for the commit. null input → `unknown`. */
export function summarizeWorkflowRuns(runs: readonly WorkflowRunInfo[] | null): CiState {
  if (runs === null) return 'unknown';
  const latest = new Map<string, WorkflowRunInfo>();
  for (const run of runs) {
    const seen = latest.get(run.workflowName);
    if (!seen || (run.createdAt ?? '') > (seen.createdAt ?? '')) latest.set(run.workflowName, run);
  }
  return combine([...latest.values()].map((run) => outcomeOf(run.status, run.conclusion)));
}

/**
 * A PR's `statusCheckRollup` → one state. The rollup keeps superseded runs
 * (an older push's cancelled run), so per check name only the newest counts.
 */
export function summarizeCheckRollup(
  rollup: readonly unknown[] | null | undefined,
  options: { ignoreCancelled?: boolean } = {}
): CiState {
  return analyzeCheckRollup(rollup, options).state;
}

/**
 * Like {@link summarizeCheckRollup}; with `ignoreCancelled` the newest
 * `cancelled` checks are left out of the verdict and only counted. A merged
 * PR's pull_request runs are cancelled on close (cancel-pr-runs-on-close.yml).
 */
export function analyzeCheckRollup(
  rollup: readonly unknown[] | null | undefined,
  options: { ignoreCancelled?: boolean } = {}
): { state: CiState; cancelled: number } {
  if (!Array.isArray(rollup)) return { state: 'unknown', cancelled: 0 };
  const latest = new Map<string, { at: string; outcome: CheckOutcome; cancelled: boolean }>();
  for (const item of rollup) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    let key: string;
    let outcome: CheckOutcome;
    let cancelled = false;
    if (typeof raw.context === 'string') {
      // StatusContext
      key = `status/${raw.context}`;
      const state = String(raw.state ?? '').toLowerCase();
      outcome = state === 'success' ? 'success' : state === 'pending' || state === 'expected' ? 'pending' : 'failure';
    } else if (typeof raw.name === 'string') {
      key = `${typeof raw.workflowName === 'string' ? raw.workflowName : ''}/${raw.name}`;
      outcome = outcomeOf(String(raw.status ?? ''), typeof raw.conclusion === 'string' ? raw.conclusion : null);
      cancelled =
        outcome === 'failure' &&
        String(raw.status ?? '').toLowerCase() === 'completed' &&
        String(raw.conclusion ?? '').toLowerCase() === 'cancelled';
    } else {
      continue;
    }
    const at = String(raw.startedAt ?? raw.completedAt ?? '');
    const seen = latest.get(key);
    if (!seen || at >= seen.at) latest.set(key, { at, outcome, cancelled });
  }
  const entries = [...latest.values()];
  const skip = options.ignoreCancelled === true;
  return {
    state: combine(entries.filter((entry) => !(skip && entry.cancelled)).map((entry) => entry.outcome)),
    cancelled: skip ? entries.filter((entry) => entry.cancelled).length : 0,
  };
}

export const CI_STATE_LABELS: Record<CiState, string> = {
  success: '緑',
  failure: '赤',
  pending: '実行中',
  none: 'チェックなし',
  unknown: '取得できず',
};

// ---------------------------------------------------------------------------
// Pull requests and dispatched Issues

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefName: string;
  baseRefName: string;
  mergedAt: string | null;
  mergeCommit: string | null;
  headRefOid: string | null;
  body: string;
  checks: CiState;
  /** Merged PRs only: checks cancelled on close, left out of `checks`. */
  cancelledChecks?: number;
}

/** `gh pr list --json …` rows → {@link PullRequestInfo}; malformed rows are dropped. */
export function parsePullRequests(json: unknown): PullRequestInfo[] {
  if (!Array.isArray(json)) return [];
  const result: PullRequestInfo[] = [];
  for (const item of json) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.number !== 'number') continue;
    const state = raw.state === 'MERGED' || raw.state === 'CLOSED' ? raw.state : 'OPEN';
    const mergeCommit =
      typeof raw.mergeCommit === 'object' && raw.mergeCommit !== null
        ? (raw.mergeCommit as { oid?: unknown }).oid
        : null;
    const rollup = analyzeCheckRollup(Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : null, {
      ignoreCancelled: state === 'MERGED',
    });
    result.push({
      number: raw.number,
      title: typeof raw.title === 'string' ? raw.title : '',
      url: typeof raw.url === 'string' ? raw.url : '',
      state,
      headRefName: typeof raw.headRefName === 'string' ? raw.headRefName : '',
      baseRefName: typeof raw.baseRefName === 'string' ? raw.baseRefName : '',
      mergedAt: typeof raw.mergedAt === 'string' && raw.mergedAt !== '' ? raw.mergedAt : null,
      mergeCommit: typeof mergeCommit === 'string' ? mergeCommit : null,
      headRefOid: typeof raw.headRefOid === 'string' ? raw.headRefOid : null,
      body: typeof raw.body === 'string' ? raw.body : '',
      checks: rollup.state,
      cancelledChecks: rollup.cancelled,
    });
  }
  return result;
}

/** PRs merged into develop on the JST `date`. */
export function mergedOnDate(prs: readonly PullRequestInfo[], date: string): PullRequestInfo[] {
  return prs
    .filter((pr) => pr.state === 'MERGED' && pr.baseRefName === 'develop' && jstDateOf(pr.mergedAt) === date)
    .sort((a, b) => a.number - b.number);
}

/**
 * The PR that implements Issue `issue`: head branch `<type>/<issue>-…`, a
 * `(#<issue>)` in the title, or `Closes #<issue>` in the body. Release PRs
 * into main are ignored unless the branch names the Issue. A merged PR wins
 * over an open one, an open one over a closed one, then the newest.
 */
export function findPullRequestForIssue(
  prs: readonly PullRequestInfo[],
  issue: number
): PullRequestInfo | null {
  const branch = new RegExp(`^[a-z]+/${issue}-`);
  const title = new RegExp(`\\(#${issue}\\)`);
  const closes = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issue}\\b`, 'i');
  const matches = prs.filter((pr) => {
    if (branch.test(pr.headRefName)) return true;
    if (pr.baseRefName === 'main') return false;
    return title.test(pr.title) || closes.test(pr.body);
  });
  const rank = (pr: PullRequestInfo) => (pr.state === 'MERGED' ? 2 : pr.state === 'OPEN' ? 1 : 0);
  matches.sort((a, b) => rank(b) - rank(a) || b.number - a.number);
  return matches[0] ?? null;
}

// ---------------------------------------------------------------------------
// orchestrate run files (workspace/orchestration/runs/<date>/)

export interface OrchestrateTask {
  worktree: string;
  agent: string;
  model: string | null;
}

/** `tasks*.tsv`: `<issue>\t<worktree>\t<agent>\t<task id>\t<model>`. Later lines win. */
export function parseTasksTsv(text: string, into = new Map<number, OrchestrateTask>()): Map<number, OrchestrateTask> {
  for (const line of text.split('\n')) {
    const cols = line.split('\t').map((col) => col.trim());
    if (cols.length < 3 || !/^\d+$/.test(cols[0])) continue;
    // Worktrees of other repositories (commandmate-skills) share issue numbers.
    if (!cols[1].startsWith('commandmate-issue-')) continue;
    into.set(Number(cols[0]), { worktree: cols[1], agent: cols[2], model: cols[4] ? cols[4] : null });
  }
  return into;
}

/**
 * The newest `wait-…<issue>[-rN].log` for an Issue among a run dir's file
 * names (the highest `-rN` is the last attempt). Logs of the skills repo are
 * skipped: their issue numbers overlap CommandMate's.
 */
export function pickWaitLog(fileNames: readonly string[], issue: number): string | null {
  let best: { name: string; attempt: number } | null = null;
  for (const name of fileNames) {
    if (name.includes('skills')) continue;
    const match = /^wait-(?:.*-)?(\d+)(?:-r(\d+))?\.log$/.exec(name);
    if (!match || Number(match[1]) !== issue) continue;
    const attempt = match[2] ? Number(match[2]) : 1;
    if (!best || attempt > best.attempt) best = { name, attempt };
  }
  return best?.name ?? null;
}

/**
 * The run dir's files that belong to one orchestrate run (#3045). With the
 * dispatch record's `runSuffix` (`3050-3051`), `tasks*.tsv` / `summary*.md` /
 * `plan*.md` are only the `-<runSuffix>` ones and `wait-*` logs only those of
 * the run's Issues, so another run on the same day does not leak in. Without
 * a suffix (older records) every file is kept.
 */
export function selectRunFiles(fileNames: readonly string[], runSuffix: string | undefined): string[] {
  if (!runSuffix) return [...fileNames];
  const issues = new Set(runSuffix.split('-').map(Number));
  return fileNames.filter((name) => {
    const own = /^(tasks|summary|plan)(.*)\.(tsv|md)$/.exec(name);
    if (own) return own[2] === `-${runSuffix}`;
    const wait = /^wait-(?:.*-)?(\d+)(?:-r\d+)?\.log$/.exec(name);
    if (wait) return issues.has(Number(wait[1]));
    return true;
  });
}

/**
 * The verify exit of a `commandmate wait --verify` log: an explicit `exit=N`
 * line, else `RESULT passed` → 0, `RESULT failed` → 20 (21 when the
 * work-evidence gate failed). null while no verdict is in the log.
 */
export function parseVerifyExit(text: string): number | null {
  const exits = [...text.matchAll(/^exit=(\d+)\s*$/gm)];
  if (exits.length > 0) return Number(exits[exits.length - 1][1]);
  const results = [...text.matchAll(/^RESULT (passed|failed)\s*$/gm)];
  if (results.length === 0) return null;
  if (results[results.length - 1][1] === 'passed') return 0;
  return /^GATE work-evidence FAIL/m.test(text) ? 21 : 20;
}

// ---------------------------------------------------------------------------
// agent-health reports (does a dispatched bug still fail on develop?)

export interface AgentHealthKey {
  tool: string;
  checkId: string;
}

/** `agent-health:<tool>:<checkId>` in an Issue body (the triage prompt's identifier). */
export function extractAgentHealthKey(body: string): AgentHealthKey | null {
  for (const match of body.matchAll(/agent-health:([a-z0-9-]+):([a-z0-9-]+)/g)) {
    const [, tool, checkId] = match;
    if (tool === 'batch' || tool === 'script') continue;
    return { tool, checkId };
  }
  return null;
}

export interface HealthReportDigest {
  name: string;
  completedAt: string | null;
  checks: Array<{ tool: string; checkId: string; status: string }>;
}

/** The parts of an agent-health report this module needs; null when it is not one. */
export function parseHealthReportDigest(name: string, text: string): HealthReportDigest | null {
  try {
    const parsed = JSON.parse(text) as { completedAt?: unknown; tools?: unknown };
    if (!Array.isArray(parsed.tools)) return null;
    const checks: HealthReportDigest['checks'] = [];
    for (const tool of parsed.tools as Array<{ tool?: unknown; checks?: unknown }>) {
      if (typeof tool?.tool !== 'string' || !Array.isArray(tool.checks)) continue;
      for (const check of tool.checks as Array<{ checkId?: unknown; status?: unknown }>) {
        if (typeof check?.checkId === 'string' && typeof check.status === 'string') {
          checks.push({ tool: tool.tool, checkId: check.checkId, status: check.status });
        }
      }
    }
    return {
      name,
      completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : null,
      checks,
    };
  } catch {
    return null;
  }
}

/**
 * Whether the fix reproduces the fail: the newest report completed after the
 * merge that ran the check (not `skip`). `true` still fails, `false` passes,
 * `null` no run has checked it since the merge (not verified yet).
 */
export function reproducesFailAfter(
  reports: readonly HealthReportDigest[],
  key: AgentHealthKey,
  mergedAt: string
): boolean | null {
  const mergedTime = Date.parse(mergedAt);
  if (Number.isNaN(mergedTime)) return null;
  let newest: { time: number; status: string } | null = null;
  for (const report of reports) {
    const time = report.completedAt ? Date.parse(report.completedAt) : NaN;
    if (Number.isNaN(time) || time <= mergedTime) continue;
    const check = report.checks.find(
      (entry) => entry.tool === key.tool && entry.checkId === key.checkId && entry.status !== 'skip'
    );
    if (check && (!newest || time > newest.time)) newest = { time, status: check.status };
  }
  if (!newest) return null;
  return newest.status === 'fail';
}

// ---------------------------------------------------------------------------
// Metrics (#3044's JSON; read only, shape fixed by the Issue contract)

export interface MetricEntry {
  metricId: string;
  category: string;
  status: 'pass' | 'fail' | 'skip';
  value: number | null;
  summary: string;
}

export const NPM_AUDIT_METRIC_ID = 'npm-audit';

/** `metrics` of a #3044 metrics file; null when missing or not schema 1. */
export function parseMetricsFile(text: string | null): MetricEntry[] | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { schemaVersion?: unknown; metrics?: unknown };
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.metrics)) return null;
    const metrics: MetricEntry[] = [];
    for (const item of parsed.metrics as Array<Record<string, unknown>>) {
      if (typeof item?.metricId !== 'string') continue;
      const status = item.status === 'pass' || item.status === 'fail' ? item.status : 'skip';
      metrics.push({
        metricId: item.metricId,
        category: typeof item.category === 'string' ? item.category : '',
        status,
        value: typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : null,
        summary: typeof item.summary === 'string' ? item.summary : '',
      });
    }
    return metrics;
  } catch {
    return null;
  }
}

export function metricValue(metrics: readonly MetricEntry[] | null, metricId: string): number | null {
  const entry = metrics?.find((metric) => metric.metricId === metricId);
  return entry && entry.status !== 'skip' ? entry.value : null;
}

export interface MetricComparison extends MetricEntry {
  previousDay: number | null;
  atLastRelease: number | null;
}

/** Today's metrics with the same metric's value the previous day and at the last release. */
export function compareMetrics(
  today: readonly MetricEntry[],
  previousDay: readonly MetricEntry[] | null,
  atLastRelease: readonly MetricEntry[] | null
): MetricComparison[] {
  return today.map((metric) => ({
    ...metric,
    previousDay: metricValue(previousDay, metric.metricId),
    atLastRelease: metricValue(atLastRelease, metric.metricId),
  }));
}

/** `+3` / `-1` / `±0`; empty when either side is unknown. */
export function formatDelta(current: number | null, base: number | null): string {
  if (current === null || base === null) return '';
  const delta = Math.round((current - base) * 100) / 100;
  if (delta === 0) return '±0';
  return delta > 0 ? `+${delta}` : `${delta}`;
}

/**
 * High-or-above advisories of production dependencies from
 * `npm audit --omit=dev --json` (the fallback when today's metrics file has no
 * `npm-audit`). Counted as unique advisories (`via[].source`), the same unit
 * as #3044's `npm-audit` value. null when the JSON is not an audit report.
 */
export function countHighAdvisories(json: unknown): number | null {
  if (typeof json !== 'object' || json === null) return null;
  const vulnerabilities = (json as { vulnerabilities?: unknown }).vulnerabilities;
  if (typeof vulnerabilities !== 'object' || vulnerabilities === null) return null;
  const advisories = new Set<string>();
  for (const vulnerability of Object.values(vulnerabilities as Record<string, unknown>)) {
    const via = (vulnerability as { via?: unknown })?.via;
    if (!Array.isArray(via)) continue;
    for (const entry of via) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { severity, source, url } = entry as Record<string, unknown>;
      if (severity !== 'high' && severity !== 'critical') continue;
      advisories.add(String(source ?? url ?? JSON.stringify(entry)));
    }
  }
  return advisories.size;
}

// ---------------------------------------------------------------------------
// The verdict

export type ReadinessVerdict = 'go' | 'hold' | 'no-go';

export const VERDICT_LABELS: Record<ReadinessVerdict, string> = {
  go: 'GO',
  hold: '要判断',
  'no-go': 'NO-GO',
};

export interface DispatchedIssueRow {
  number: number;
  kind: DispatchIssueKind;
  title: string;
  /** From the run's `tasks*.tsv`, e.g. `claude (opus)`. */
  agent: string | null;
  pr: { number: number; url: string; state: PullRequestInfo['state'] } | null;
  ci: CiState;
  verifyExit: number | null;
  merged: boolean;
  mergedAt: string | null;
  /** Merge commit when merged, else the PR head. */
  commit: string | null;
  agentHealthKey: string | null;
  /** Bug only: see {@link reproducesFailAfter}. */
  reproducedFail: boolean | null;
}

export interface ReadinessFacts {
  developCi: CiState;
  /** null: the merged-PR list could not be read. */
  mergedToday: Array<{ number: number; title: string; url: string; checks: CiState; cancelledChecks?: number }> | null;
  audit: { current: number | null; atLastRelease: number | null };
  dispatchStatus: DispatchStatus | null;
  dispatched: DispatchedIssueRow[];
  /** false: gh could not list PRs, so "no PR" means "not known". */
  prLookupOk: boolean;
  deferred: number[];
  /**
   * The product-path check's final result for the day (stage 2, Issue #3312;
   * `./product-judgement.ts`). Absent / null while stage 2 is not set up, and
   * then nothing about it changes the verdict.
   */
  product?: ProductReadinessFact | null;
}

export interface ProductReadinessFact {
  status: ProductVerdict;
  reasons: string[];
  /** Days in a row (ending today) whose result is `skip`. */
  skipStreakDays: number;
}

export interface ReadinessDecision {
  verdict: ReadinessVerdict;
  /** Why — always at least one line, whatever the verdict. */
  reasons: string[];
  /** Facts that did not change the verdict but are worth a look. */
  notes: string[];
  nextSteps: string[];
}

function issueList(numbers: readonly number[]): string {
  return numbers.map((n) => `#${n}`).join(', ');
}

interface ReadinessAccumulator {
  noGo: string[];
  hold: string[];
  notes: string[];
  noGoSteps: string[];
  holdSteps: string[];
}

function collectDevelopCi(facts: ReadinessFacts, acc: ReadinessAccumulator): void {
  const { noGo, hold, notes, noGoSteps, holdSteps } = acc;
  if (facts.developCi === 'failure') {
    noGo.push('develop HEAD の CI が赤');
    noGoSteps.push('develop HEAD の CI の失敗を直す（失敗したジョブのログから原因を特定し、fix PR を develop へ）');
  } else if (facts.developCi === 'pending') {
    hold.push('develop HEAD の CI が実行中（結果が出てから判断する）');
    holdSteps.push('develop HEAD の CI の完了を待ってから、このレポートを出し直す');
  } else if (facts.developCi === 'unknown') {
    hold.push('develop HEAD の CI の状態を取得できなかった');
    holdSteps.push('`gh run list --branch develop` で develop HEAD の CI を確かめる');
  } else if (facts.developCi === 'none') {
    notes.push('develop HEAD にはまだ CI の実行が無い');
  }
}

function collectMergedToday(facts: ReadinessFacts, acc: ReadinessAccumulator): void {
  const { noGo, hold, noGoSteps, holdSteps } = acc;
  if (facts.mergedToday === null) {
    hold.push('本日マージされた PR の一覧を取得できなかった');
    holdSteps.push('`gh pr list --state merged --base develop` で本日マージされた PR のチェックを確かめる');
  } else {
    const notGreen = facts.mergedToday.filter((pr) => pr.checks !== 'success');
    if (notGreen.length > 0) {
      noGo.push(
        `本日マージされた PR にチェックが緑でないものがある: ${notGreen
          .map((pr) => `#${pr.number}（${CI_STATE_LABELS[pr.checks]}）`)
          .join(', ')}`
      );
      noGoSteps.push(`${issueList(notGreen.map((pr) => pr.number))} のチェックを確かめ、赤なら develop で直す`);
    }
  }
}

function collectAudit(facts: ReadinessFacts, acc: ReadinessAccumulator): void {
  const { noGo, notes, noGoSteps } = acc;
  const { current, atLastRelease } = facts.audit;
  if (current !== null && atLastRelease !== null && current > atLastRelease) {
    noGo.push(`npm audit --omit=dev の high 以上が前回リリース時より増えた（${atLastRelease} → ${current}）`);
    noGoSteps.push('`npm audit --omit=dev` で増えた high 以上の advisory を解消する（依存の更新または置き換え）');
  } else if (current === null || atLastRelease === null) {
    notes.push(
      current === null
        ? 'npm audit（本番依存の high 以上）の今日の値が無い'
        : 'npm audit の前回リリース時の値が無いため比較していない'
    );
  }
}

function collectDispatchedBugs(facts: ReadinessFacts, acc: ReadinessAccumulator): void {
  const { noGo, notes, noGoSteps } = acc;
  const reproduced = facts.dispatched.filter((row) => row.kind === 'bug' && row.reproducedFail === true);
  if (reproduced.length > 0) {
    noGo.push(
      `dispatch したバグ Issue の修正が develop で agent-health の fail を再現している: ${reproduced
        .map((row) => `#${row.number}（${row.agentHealthKey ?? '?'}）`)
        .join(', ')}`
    );
    noGoSteps.push(`${issueList(reproduced.map((row) => row.number))} の修正を見直す（マージ後の agent-health でまだ fail）`);
  }
  const unverified = facts.dispatched.filter(
    (row) => row.kind === 'bug' && row.merged && row.agentHealthKey !== null && row.reproducedFail === null
  );
  if (unverified.length > 0) {
    notes.push(`マージ後の agent-health がまだ走っていない修正: ${issueList(unverified.map((row) => row.number))}`);
  }
}

function productDetailOf(product: ProductReadinessFact | null): string {
  return product && product.reasons.length > 0 ? `（${product.reasons.join(' ／ ')}）` : '';
}

function collectProductFail(product: ProductReadinessFact | null, acc: ReadinessAccumulator): void {
  const { noGo, noGoSteps } = acc;
  const productDetail = productDetailOf(product);
  if (product?.status === 'fail') {
    noGo.push(`製品の経路の確認（第 2 段）が fail${productDetail}`);
    noGoSteps.push('製品の経路の確認の失敗を確かめ、製品の不具合なら develop で直す（Issue の候補は needs-human）');
  }
}

function collectProductHold(product: ProductReadinessFact | null, acc: ReadinessAccumulator): void {
  const { hold, notes, holdSteps } = acc;
  const productDetail = productDetailOf(product);
  if (product?.status === 'unknown') {
    hold.push(`製品の経路の確認（第 2 段）の結果が unknown${productDetail}`);
    holdSteps.push('製品の経路の確認が unknown になった理由（回収・漏れの判定・段の結果）を確かめる');
  } else if (product?.status === 'not-run') {
    hold.push(`製品の経路の確認（第 2 段）が未実施${productDetail}`);
    holdSteps.push('製品の経路の確認の結果が無い理由（未起動・期限・公開の失敗）を確かめる');
  } else if (product?.status === 'skip') {
    if (product.skipStreakDays >= PRODUCT_SKIP_STREAK_ALERT_DAYS) {
      hold.push(`製品の経路の確認（第 2 段）が ${product.skipStreakDays} 日続けて skip（要対応）${productDetail}`);
      holdSteps.push('製品の経路の確認が skip し続ける条件（認証の期限など）を解消する');
    } else {
      notes.push(`製品の経路の確認（第 2 段）は skip${productDetail}`);
    }
  }
}

function collectDispatchProgress(facts: ReadinessFacts, acc: ReadinessAccumulator): void {
  const { hold, notes, holdSteps } = acc;
  const unfinished: string[] = [];
  for (const row of facts.dispatched) {
    if (row.pr === null) {
      unfinished.push(`#${row.number}（${facts.prLookupOk ? 'PR 未作成' : 'PR を確認できず'}）`);
    } else if (!row.merged) {
      unfinished.push(`#${row.number}（PR #${row.pr.number} 未マージ）`);
    }
    // A merged PR means the orchestrator judged the gates and CI; an older
    // verify exit in the wait log (e.g. an adjudicated exit 20) does not
    // override it. verifyExit stays in the Issue table for reference.
  }
  if (unfinished.length > 0) {
    hold.push(`dispatch した Issue に未完了がある: ${unfinished.join(', ')}`);
    holdSteps.push('未完了の Issue を仕上げるか、今回のリリースに含めないと決める');
  }
  if (facts.deferred.length > 0) {
    hold.push(`持ち越しがある: ${issueList(facts.deferred)}`);
    holdSteps.push(`持ち越し（${issueList(facts.deferred)}）を待たずにリリースしてよいかを決める`);
  }
  if (facts.dispatchStatus === 'skipped-busy') {
    notes.push('本日の依頼は orchestrate の実行中のため見送られた（skipped-busy）');
  }
}

/**
 * NO-GO: develop HEAD CI red / a PR merged today whose checks are not green /
 * more high+ production advisories than at the last release / a dispatched
 * bug's agent-health check still fails on develop after its fix merged.
 * 要判断: a dispatched Issue is unfinished (no PR, not merged, verify failed),
 * something was carried over, or a fact the NO-GO rules need is unreadable
 * (develop CI unknown or still running, the merged-PR list missing).
 * The product-path check (Issue #3312), when it is set up: `fail` is NO-GO;
 * `unknown`, `not-run` and a `skip` that has lasted
 * {@link PRODUCT_SKIP_STREAK_ALERT_DAYS} days are 要判断.
 * GO: none of the above.
 */
export function decideReadiness(facts: ReadinessFacts): ReadinessDecision {
  const acc: ReadinessAccumulator = { noGo: [], hold: [], notes: [], noGoSteps: [], holdSteps: [] };

  // --- NO-GO
  collectDevelopCi(facts, acc);
  collectMergedToday(facts, acc);
  collectAudit(facts, acc);
  collectDispatchedBugs(facts, acc);
  const product = facts.product ?? null;
  collectProductFail(product, acc);

  // --- 要判断
  collectProductHold(product, acc);
  collectDispatchProgress(facts, acc);
  const { noGo, hold, notes, noGoSteps, holdSteps } = acc;
  const { current, atLastRelease } = facts.audit;

  if (noGo.length > 0) {
    return { verdict: 'no-go', reasons: [...noGo, ...hold], notes, nextSteps: [...noGoSteps, ...holdSteps] };
  }
  if (hold.length > 0) {
    return {
      verdict: 'hold',
      reasons: hold,
      notes,
      nextSteps: [...holdSteps, '問題なしと判断したら `/release` を実行する'],
    };
  }
  const reasons = [
    facts.developCi === 'none' ? 'develop HEAD の CI に赤は無い（実行なし）' : 'develop HEAD の CI は緑',
    facts.mergedToday && facts.mergedToday.length > 0
      ? `本日マージされた PR（${facts.mergedToday.length} 件）のチェックはすべて緑`
      : '本日マージされた PR は無い',
    current !== null && atLastRelease !== null
      ? `npm audit の high 以上は前回リリース時から増えていない（${atLastRelease} → ${current}）`
      : 'npm audit の増加は検出されていない（比較できる値が無い）',
    facts.dispatched.length > 0
      ? `dispatch した Issue（${facts.dispatched.length} 件）はすべてマージ済み`
      : 'dispatch した Issue は無い',
    '持ち越しは無い',
    ...(product?.status === 'pass' ? ['製品の経路の確認（第 2 段）は pass'] : []),
  ];
  return { verdict: 'go', reasons, notes, nextSteps: ['`/release` を実行する'] };
}

// ---------------------------------------------------------------------------
// Command line

export interface ReleaseReportOptions {
  date: string;
  /** null → `<main worktree>/workspace/agent-health/<date>/release-readiness.html`. */
  out: string | null;
  /** null → `$AGENT_HEALTH_DIR` or `~/.commandmate/agent-health`. */
  stateDir: string | null;
  /** null → `<main worktree>/workspace/orchestration/runs`. */
  runsDir: string | null;
  findings: string | null;
  repo: string;
  gh: boolean;
  audit: boolean;
}

export const RELEASE_REPORT_USAGE = [
  'Usage: npx tsx scripts/agent-health/release-report.ts [options]',
  '',
  '  --date <YYYY-MM-DD>   the JST day to report (default: today in JST)',
  '  --out <file>          HTML path (default: <main worktree>/workspace/agent-health/<date>/release-readiness.html)',
  '  --state-dir <dir>     agent-health dir with dispatch/ metrics/ reports/ (default: $AGENT_HEALTH_DIR or ~/.commandmate/agent-health)',
  '  --runs-dir <dir>      orchestrate runs dir (default: <main worktree>/workspace/orchestration/runs)',
  '  --findings <file>     optional Markdown with AI findings to include',
  '  --repo <owner/name>   GitHub repository (default: Kewton/CommandMate)',
  '  --no-gh               do not call gh (CI / PR / Issue facts become "unknown")',
  '  --no-audit            do not run `npm audit` when today\'s metrics have no npm-audit value',
  '  -h, --help            show this help',
  '',
  'Exit: 0 the HTML was written (whatever the verdict), 2 bad arguments or the script failed.',
].join('\n');

export type ReleaseReportParseResult =
  | { ok: true; options: ReleaseReportOptions }
  | { ok: false; error: string; help?: boolean };

export function parseReleaseReportArgs(argv: readonly string[], today: string): ReleaseReportParseResult {
  const options: ReleaseReportOptions = {
    date: today,
    out: null,
    stateDir: null,
    runsDir: null,
    findings: null,
    repo: 'Kewton/CommandMate',
    gh: true,
    audit: true,
  };
  const valueFlags: Record<string, (value: string) => string | null> = {
    '--date': (value) => {
      if (!isIsoDate(value)) return `--date must be YYYY-MM-DD: ${value}`;
      options.date = value;
      return null;
    },
    '--out': (value) => ((options.out = value), null),
    '--state-dir': (value) => ((options.stateDir = value), null),
    '--runs-dir': (value) => ((options.runsDir = value), null),
    '--findings': (value) => ((options.findings = value), null),
    '--repo': (value) => {
      if (!/^[\w.-]+\/[\w.-]+$/.test(value)) return `--repo must be owner/name: ${value}`;
      options.repo = value;
      return null;
    },
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { ok: false, error: RELEASE_REPORT_USAGE, help: true };
    if (arg === '--no-gh') {
      options.gh = false;
      continue;
    }
    if (arg === '--no-audit') {
      options.audit = false;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const setter = valueFlags[flag];
    if (!setter) return { ok: false, error: `unknown argument: ${arg}` };
    let value: string | undefined;
    if (eq > 0) {
      value = arg.slice(eq + 1);
    } else {
      value = argv[i + 1];
      i++;
    }
    if (value === undefined || value === '') return { ok: false, error: `${flag} requires a value` };
    const error = setter(value);
    if (error) return { ok: false, error };
  }
  return { ok: true, options };
}
