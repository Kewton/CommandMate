/**
 * The daily slash-command catalog drift check (Issue #3158). Used by
 * `scripts/agent-health/catalog-check.ts`.
 *
 * Pure: the verdict (via the existing `--check` report parser), the opencode
 * 1.x exclusion, the version comparison against today's agent-health report,
 * which way the tracking Issue moves, the Issue text, the record and the final
 * line are decided here and pinned by unit tests. The script only runs npm / gh
 * and writes the record.
 *
 * Read only: nothing here (or in the script) writes a tracked file. `--write`
 * is never run — a dirty worktree would make the next morning's `daily.sh`
 * refuse to pull and stop the whole daily check.
 */

import path from 'path';
import {
  formatTrackingIssueBody,
  parseCatalogCheckOutput,
  TRACKING_ISSUE_LABEL,
  type CatalogCheckReport,
  type CatalogCheckStatus,
} from '@/lib/slash-command-reconcile/check-report';

export const CATALOG_REPO = 'Kewton/CommandMate';
/** Only Issues the owner wrote count (and get written): #3159 dispatches those to Claude 3. */
export const CATALOG_ISSUE_AUTHOR = 'kewton';
export const CATALOG_ISSUE_LABEL = TRACKING_ISSUE_LABEL;

/**
 * opencode 1.x is out of the daily check (2026-10-04, v2 is released): its
 * provider needs a loopback server the schedule does not start, so its skip is
 * a known state here and not a reason for `inconclusive`.
 *
 * Added on this side rather than to IGNORED_WARNING_PREFIXES so the CI
 * workflow's verdict does not change. Prefix match, like the parser: it covers
 * `opencode provider skipped: no loopback port given …` and the runner's bare
 * `opencode provider skipped`, and never `opencode-v2 …` or an opencode fetch
 * failure (`http 4xx …`).
 */
export const CATALOG_CHECK_IGNORED_WARNING_PREFIXES: readonly string[] = ['opencode provider skipped'];

/** Tools left out of the version comparison (opencode 1.x, see above). */
export const VERSION_EXCLUDED_TOOLS: readonly string[] = ['opencode'];

/** `npm run catalog:refresh -- --check` */
export const CATALOG_CHECK_COMMAND = ['run', 'catalog:refresh', '--', '--check'] as const;

// ---------------------------------------------------------------------------
// Arguments

export interface CatalogCheckOptions {
  stateDir: string | null;
  dryRun: boolean;
}

export type CatalogCheckParseResult =
  | { ok: true; options: CatalogCheckOptions }
  | { ok: false; error: string; help?: boolean };

export const CATALOG_CHECK_USAGE = [
  'Usage: npx tsx scripts/agent-health/catalog-check.ts [--state-dir <dir>] [--dry-run]',
  '',
  '  --state-dir <dir>  agent-health state (default: $AGENT_HEALTH_DIR or ~/.commandmate/agent-health)',
  '  --dry-run          judge and compare versions only; no Issue is created, updated or closed, no record is written',
].join('\n');

export function parseCatalogCheckArgs(argv: readonly string[]): CatalogCheckParseResult {
  const options: CatalogCheckOptions = { stateDir: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { ok: false, error: CATALOG_CHECK_USAGE, help: true };
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
    return { ok: false, error: `unknown argument: ${arg}\n\n${CATALOG_CHECK_USAGE}` };
  }
  return { ok: true, options };
}

// ---------------------------------------------------------------------------
// Verdict

/**
 * The `--check` output → verdict. The exit code only ever pushes toward
 * `inconclusive` (the runner died); 0 never means clean on its own.
 */
export function judgeCatalogCheck(output: string, exitCode: number): CatalogCheckReport {
  return parseCatalogCheckOutput(output, {
    exitCode,
    extraIgnoredWarningPrefixes: CATALOG_CHECK_IGNORED_WARNING_PREFIXES,
  });
}

// ---------------------------------------------------------------------------
// Versions

export interface VersionGap {
  tool: string;
  /** Version in src/config/slash-commands-attestations.json. */
  attested: string;
  /** Version in today's agent-health report. */
  local: string;
}

export interface VersionComparison {
  /** False when today's report was missing or unreadable. */
  available: boolean;
  gaps: VersionGap[];
}

/** First dotted number in a `--version` line: `2.1.288 (Claude Code)` → `2.1.288`, `codex-cli 0.159.3` → `0.159.3`. */
export function versionToken(text: string): string | null {
  const match = /\d+(?:\.\d+)+/.exec(text);
  return match ? match[0] : null;
}

/** `slash-commands-attestations.json` → tool → version. */
export function attestedVersionsOf(json: unknown): Map<string, string> {
  const versions = new Map<string, string>();
  const list = typeof json === 'object' && json !== null ? (json as { attestations?: unknown }).attestations : undefined;
  if (!Array.isArray(list)) return versions;
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue;
    const { tool, version } = row as Record<string, unknown>;
    if (typeof tool === 'string' && typeof version === 'string') versions.set(tool, version);
  }
  return versions;
}

/**
 * Today's report `tools[].version` vs the attested version. Only tools in both
 * are compared; opencode 1.x is skipped. A gap is reported, never a verdict:
 * a patch release that renames nothing must not file an Issue.
 */
export function compareVersions(reportJson: unknown, attested: ReadonlyMap<string, string>): VersionComparison {
  const tools =
    typeof reportJson === 'object' && reportJson !== null ? (reportJson as { tools?: unknown }).tools : undefined;
  if (!Array.isArray(tools)) return { available: false, gaps: [] };
  const gaps: VersionGap[] = [];
  for (const row of tools) {
    if (typeof row !== 'object' || row === null) continue;
    const { tool, version } = row as Record<string, unknown>;
    if (typeof tool !== 'string' || typeof version !== 'string') continue;
    if (VERSION_EXCLUDED_TOOLS.includes(tool)) continue;
    const recorded = attested.get(tool);
    const local = versionToken(version);
    if (!recorded || !local) continue;
    if (versionToken(recorded) !== local) gaps.push({ tool, attested: recorded, local });
  }
  return { available: true, gaps };
}

/** `claude:2.1.283->2.1.288,codex:…`, `none`, or `unknown` (no report today). */
export function formatVersionGaps(comparison: VersionComparison): string {
  if (!comparison.available) return 'unknown';
  if (comparison.gaps.length === 0) return 'none';
  return comparison.gaps.map((gap) => `${gap.tool}:${gap.attested}->${gap.local}`).join(',');
}

// ---------------------------------------------------------------------------
// Issue sync

export interface TrackingIssue {
  number: number;
  title: string;
}

/**
 * `gh issue list --label catalog-drift --state open --json number,title,author`
 * → open Issues the owner wrote (author compared case-insensitively), oldest
 * first; null when it is not that shape. An Issue written by anyone else (the
 * CI workflow's bot included) is neither updated nor closed.
 */
export function parseTrackingIssues(json: unknown): TrackingIssue[] | null {
  if (!Array.isArray(json)) return null;
  const issues: TrackingIssue[] = [];
  for (const row of json) {
    if (typeof row !== 'object' || row === null) continue;
    const { number, title, author } = row as Record<string, unknown>;
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) continue;
    const login = typeof author === 'object' && author !== null ? (author as { login?: unknown }).login : undefined;
    if (typeof login !== 'string' || login.toLowerCase() !== CATALOG_ISSUE_AUTHOR) continue;
    issues.push({ number, title: typeof title === 'string' ? title : '' });
  }
  return issues.sort((a, b) => a.number - b.number);
}

export type CatalogIssueAction = 'created' | 'updated' | 'closed' | 'none';
export type CatalogIssuePlan = 'create' | 'update' | 'close' | 'none';

/**
 * The table in Issue #3158 §4. Only an *open* Issue is ever reused: a closed
 * one may still carry `auto-dispatched`, which would keep the next drift from
 * being dispatched, so the next drift gets a new Issue.
 */
export function planIssueSync(status: CatalogCheckStatus, open: TrackingIssue | null): CatalogIssuePlan {
  if (status === 'drift') return open ? 'update' : 'create';
  if (status === 'clean') return open ? 'close' : 'none';
  return 'none';
}

/** Comment left when an update moved the title's count. */
export function countChangedComment(date: string, before: string, after: string): string {
  return [`<!-- agent-health-catalog:${date} -->`, `件数が変わりました（${date} の日次チェック）。`, '', `- 前: ${before}`, `- 今: ${after}`].join('\n');
}

/** Comment the Issue is closed with. */
export function closeComment(date: string): string {
  return [
    `<!-- agent-health-catalog:${date} -->`,
    `${date} の日次チェックで ずれ 0・検査不能なし になったため閉じます（\`scripts/agent-health/catalog-check.ts\`）。`,
    '次にずれが出たときは新しい Issue を立てます（この Issue は再利用しません）。',
  ].join('\n');
}

/** The tracking-issue body of `scripts/catalog-drift-report.ts`, with this run's header and the version gaps. */
export function catalogIssueBody(
  report: CatalogCheckReport,
  versions: VersionComparison,
  meta: { checkedAt: string; exitCode: number }
): string {
  const versionSection: string[] = ['### 版の差（手元の CLI と attestation の記録）', ''];
  if (!versions.available) {
    versionSection.push('当日の agent-health レポートが無いため比べていません。');
  } else if (versions.gaps.length === 0) {
    versionSection.push('差はありません。');
  } else {
    versionSection.push(
      '版の差だけではずれ（drift）と判定しません。集合が変わっていれば上の attestation の陳腐化に出ます。',
      '',
      '| tool | 記録（attestation） | 手元（agent-health レポート） |',
      '| --- | --- | --- |',
      ...versions.gaps.map((gap) => `| ${gap.tool} | ${gap.attested} | ${gap.local} |`)
    );
  }
  versionSection.push('', 'opencode 1.x は日次チェックの対象外です（provider の skip も検査不能に数えません）。');

  return formatTrackingIssueBody(report, {
    checkedAt: meta.checkedAt,
    exitCode: meta.exitCode,
    headerNote: [
      '> 対応は `/catalog-reconcile` の無人実行節に従う。',
      '>',
      '> このIssueは agent-health の日次チェック（`scripts/agent-health/catalog-check.ts`）が自動更新します。',
      '> 本文を手で編集しても次回の実行で上書きされます。',
    ],
    extraSections: versionSection,
  });
}

// ---------------------------------------------------------------------------
// Record and the final line

export interface CatalogCheckRecord {
  schemaVersion: 1;
  date: string;
  checkedAt: string;
  dryRun: boolean;
  status: CatalogCheckStatus;
  newCount: number | null;
  newCommands: string[];
  attestationDrift: string[];
  verifiedAgainstUpdates: string[];
  ignoredWarnings: string[];
  inconclusiveReasons: string[];
  /** Null when today's agent-health report was missing. */
  versionGaps: VersionGap[] | null;
  issue: number | null;
  action: CatalogIssueAction;
  /** What a non-dry run would have done (dry run only). */
  wouldDo?: CatalogIssuePlan | 'unknown';
  /** Why the Issue could not be synced, or why the run is inconclusive. */
  reason?: string;
}

export function catalogRecordPath(stateDir: string, date: string): string {
  return path.join(stateDir, 'catalog', `${date}.json`);
}

export function agentHealthReportPath(stateDir: string, date: string): string {
  return path.join(stateDir, 'reports', `${date}.json`);
}

export function buildCatalogRecord(input: {
  date: string;
  checkedAt: string;
  dryRun: boolean;
  report: CatalogCheckReport;
  versions: VersionComparison;
  issue: number | null;
  action: CatalogIssueAction;
  wouldDo?: CatalogIssuePlan | 'unknown';
  reason?: string;
}): CatalogCheckRecord {
  const { report } = input;
  return {
    schemaVersion: 1,
    date: input.date,
    checkedAt: input.checkedAt,
    dryRun: input.dryRun,
    status: report.status,
    newCount: report.newCount,
    newCommands: report.newCommands,
    attestationDrift: report.attestationDrift,
    verifiedAgainstUpdates: report.verifiedAgainstUpdates,
    ignoredWarnings: report.ignoredWarnings,
    inconclusiveReasons: report.inconclusiveReasons,
    versionGaps: input.versions.available ? input.versions.gaps : null,
    issue: input.issue,
    action: input.action,
    ...(input.wouldDo ? { wouldDo: input.wouldDo } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

/**
 * `AGENT_HEALTH_CATALOG date=… status=… new=… attestation_drift=… version_gaps=… issue=… action=…`
 * plus ` dry_run=would-<plan>` on a dry run and ` reason="…"` when there is one.
 */
export function formatCatalogLine(record: CatalogCheckRecord): string {
  const parts = [
    'AGENT_HEALTH_CATALOG',
    `date=${record.date}`,
    `status=${record.status}`,
    `new=${record.newCount ?? 'unknown'}`,
    `attestation_drift=${record.attestationDrift.length}`,
    `version_gaps=${formatVersionGaps({ available: record.versionGaps !== null, gaps: record.versionGaps ?? [] })}`,
    `issue=${record.issue ?? 'none'}`,
    `action=${record.action}`,
  ];
  if (record.dryRun) parts.push(`dry_run=would-${record.wouldDo ?? 'unknown'}`);
  if (record.reason) parts.push(`reason="${record.reason.replace(/"/g, "'").replace(/\s*\n\s*/g, ' ')}"`);
  return parts.join(' ');
}

/** Why an inconclusive run is inconclusive, for the record and the final line. */
export function inconclusiveReason(report: CatalogCheckReport): string | undefined {
  return report.status === 'inconclusive' ? report.inconclusiveReasons.join('; ') : undefined;
}
