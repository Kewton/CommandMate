/**
 * The `bug-flow` metric (Issue #3185): how the `bug` Issues of the last
 * {@link BUG_FLOW_WINDOW_DAYS} days came about, read from the "分類" section at
 * the end of each body.
 *
 * Pure: `gh issue list --json` text in, a {@link MetricMeasurement} out (the
 * command runs in `scripts/agent-health/metrics-runners.ts`). The metric only
 * records numbers — its `candidates` are always empty, so no Issue is filed.
 *
 * The vocabulary below is the single source: `.github/ISSUE_TEMPLATE/bug_report.md`
 * and the filing steps in `.claude/commands/{uat,uat-fix-loop,bug-fix,orchestrate}.md`
 * carry {@link BUG_CLASSIFICATION_TEMPLATE} verbatim (a unit test compares them).
 */

import type { MetricMeasurement } from './metrics-types';

/** Issues created within this many days are counted. */
export const BUG_FLOW_WINDOW_DAYS = 7;
/** The label of bugs no user can see (tests, CI, dev skills, agent-health, orchestrate). */
export const INTERNAL_LABEL = 'internal';

export const BUG_CLASSIFICATION_HEADING = '## 分類';
export const BUG_CAUSE_LABEL = '原因の PR';
export const BUG_DISCOVERY_LABEL = '発見経路';
export const BUG_IMPACT_LABEL = '影響する経路';

export const BUG_DISCOVERY_VALUES = ['uat', 'review', 'orchestrate', 'daily-use', 'automated'] as const;
export type BugDiscovery = (typeof BUG_DISCOVERY_VALUES)[number];

export const BUG_IMPACT_INTERNAL = 'なし（内部）';
export const BUG_IMPACT_VALUES = ['chat', 'terminal', 'cli', 'mobile', 'auto-yes', 'push', BUG_IMPACT_INTERNAL] as const;
export type BugImpact = (typeof BUG_IMPACT_VALUES)[number];

/** The section as the template and the filing steps show it (choices separated by ` / `). */
export const BUG_CLASSIFICATION_TEMPLATE = [
  BUG_CLASSIFICATION_HEADING,
  `- ${BUG_CAUSE_LABEL}: #<番号> / 不明 / なし（以前から）/ 上流（<CLI> <版>）`,
  `- ${BUG_DISCOVERY_LABEL}: ${BUG_DISCOVERY_VALUES.join(' / ')}`,
  `- ${BUG_IMPACT_LABEL}: ${BUG_IMPACT_VALUES.join(' / ')}`,
].join('\n');

export type BugCause =
  | { kind: 'pr'; pr: number }
  | { kind: 'unknown' }
  | { kind: 'none' }
  | { kind: 'upstream'; detail: string };

/**
 * `missing`: no section (or no line for a field); `invalid`: a value outside
 * the vocabulary (e.g. the template left as is). Both count as "未記入".
 */
export type BugClassification =
  | { state: 'missing' }
  | { state: 'invalid'; fields: string[] }
  | { state: 'classified'; cause: BugCause; discovery: BugDiscovery; impact: BugImpact[] };

function normalize(value: string): string {
  return value
    .trim()
    .replace(/\(/g, '（')
    .replace(/\)/g, '）')
    .replace(/`/g, '')
    .trim();
}

export function parseBugCause(raw: string): BugCause | null {
  const value = normalize(raw);
  const pr = /^#(\d+)$/.exec(value);
  if (pr) return { kind: 'pr', pr: Number(pr[1]) };
  if (value === '不明') return { kind: 'unknown' };
  if (value === 'なし' || value === 'なし（以前から）') return { kind: 'none' };
  const upstream = /^上流（(.+)）$/.exec(value);
  if (upstream && !upstream[1].includes('<')) return { kind: 'upstream', detail: upstream[1].trim() };
  return null;
}

export function parseBugDiscovery(raw: string): BugDiscovery | null {
  const value = normalize(raw).toLowerCase();
  return (BUG_DISCOVERY_VALUES as readonly string[]).includes(value) ? (value as BugDiscovery) : null;
}

/** One or more paths separated by `,` / `、`. `なし（内部）` cannot be combined with a path. */
export function parseBugImpact(raw: string): BugImpact[] | null {
  const parts = raw
    .split(/[,、，]/)
    .map((part) => normalize(part))
    .map((part) => (part === 'なし' ? BUG_IMPACT_INTERNAL : part.toLowerCase()));
  if (parts.length === 0 || parts.some((part) => !(BUG_IMPACT_VALUES as readonly string[]).includes(part))) return null;
  const unique = [...new Set(parts)] as BugImpact[];
  if (unique.includes(BUG_IMPACT_INTERNAL) && unique.length > 1) return null;
  return unique;
}

/** The lines of the last `## 分類` section outside code fences (up to the next heading of level 1–2). */
function classificationLines(body: string): string[] | null {
  let inFence = false;
  let section: string[] | null = null;
  let current: string[] | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{1,2}\s/.test(line)) {
      current = line.trim() === BUG_CLASSIFICATION_HEADING ? [] : null;
      if (current) section = current;
      continue;
    }
    current?.push(line);
  }
  return section;
}

/** The "分類" section of a bug Issue body. */
export function parseBugClassification(body: string): BugClassification {
  const lines = classificationLines(body);
  if (lines === null) return { state: 'missing' };
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^\s*[-*]\s*([^:：]+?)\s*[:：]\s*(.*)$/.exec(line);
    if (match && !fields.has(match[1])) fields.set(match[1], match[2]);
  }
  const causeText = fields.get(BUG_CAUSE_LABEL);
  const discoveryText = fields.get(BUG_DISCOVERY_LABEL);
  const impactText = fields.get(BUG_IMPACT_LABEL);
  if (causeText === undefined && discoveryText === undefined && impactText === undefined) return { state: 'missing' };
  const cause = causeText === undefined ? null : parseBugCause(causeText);
  const discovery = discoveryText === undefined ? null : parseBugDiscovery(discoveryText);
  const impact = impactText === undefined ? null : parseBugImpact(impactText);
  if (cause === null || discovery === null || impact === null) {
    const invalid = [
      ...(cause === null ? [BUG_CAUSE_LABEL] : []),
      ...(discovery === null ? [BUG_DISCOVERY_LABEL] : []),
      ...(impact === null ? [BUG_IMPACT_LABEL] : []),
    ];
    return { state: 'invalid', fields: invalid };
  }
  return { state: 'classified', cause, discovery, impact };
}

// ── counting ───────────────────────────────────────────────────────────────

export interface BugIssue {
  number: number;
  body: string;
  labels: string[];
  createdAt: string;
}

/** Counts behind the rates; they go to the state file as the metric's `items`. */
export interface BugFlowCounts {
  /** `bug` Issues created in the window. */
  total: number;
  /** …without the `internal` label. */
  external: number;
  /** With a complete "分類" section (every value in the vocabulary). */
  classified: number;
  /** A "分類" section with a value outside the vocabulary (counted as 未記入). */
  invalid: number;
  /** Classified, and the cause is a PR number. */
  regression: number;
  /** Classified and not `internal`. */
  classifiedExternal: number;
  /** Classified, not `internal`, found in daily use. */
  reachedUsers: number;
}

export interface BugFlowRates {
  /** regression ÷ classified */
  regressionRate: number | null;
  /** reachedUsers ÷ classifiedExternal */
  userReachRate: number | null;
  /** classified ÷ total */
  classifiedRate: number | null;
}

export function countBugFlow(issues: readonly BugIssue[]): BugFlowCounts {
  const counts: BugFlowCounts = {
    total: 0,
    external: 0,
    classified: 0,
    invalid: 0,
    regression: 0,
    classifiedExternal: 0,
    reachedUsers: 0,
  };
  for (const issue of issues) {
    const internal = issue.labels.includes(INTERNAL_LABEL);
    counts.total += 1;
    if (!internal) counts.external += 1;
    const classification = parseBugClassification(issue.body);
    if (classification.state === 'invalid') counts.invalid += 1;
    if (classification.state !== 'classified') continue;
    counts.classified += 1;
    if (classification.cause.kind === 'pr') counts.regression += 1;
    if (internal) continue;
    counts.classifiedExternal += 1;
    if (classification.discovery === 'daily-use') counts.reachedUsers += 1;
  }
  return counts;
}

/** A ratio rounded to 3 places; null (not 0) when the denominator is 0. */
function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : null;
}

export function bugFlowRates(counts: Partial<BugFlowCounts>): BugFlowRates {
  const n = (key: keyof BugFlowCounts) => counts[key] ?? 0;
  return {
    regressionRate: ratio(n('regression'), n('classified')),
    userReachRate: ratio(n('reachedUsers'), n('classifiedExternal')),
    classifiedRate: ratio(n('classified'), n('total')),
  };
}

function percent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 1000) / 10}%`;
}

/** The one-line summary for the report and the HTML view. */
export function bugFlowSummary(counts: Partial<BugFlowCounts>): string {
  const rates = bugFlowRates(counts);
  return (
    `直近 ${BUG_FLOW_WINDOW_DAYS} 日の bug ${counts.total ?? 0} 件（internal 除く ${counts.external ?? 0} 件）、` +
    `回帰 ${percent(rates.regressionRate)}・利用者まで届いた ${percent(rates.userReachRate)}・` +
    `分類節の記入 ${percent(rates.classifiedRate)}（${counts.classified ?? 0}/${counts.total ?? 0}）`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `gh issue list --json number,body,labels,createdAt` → issues; null when the text is not that shape. */
export function parseBugIssues(text: string): BugIssue[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(json)) return null;
  const issues: BugIssue[] = [];
  for (const item of json) {
    if (!isRecord(item) || typeof item.number !== 'number') continue;
    issues.push({
      number: item.number,
      body: typeof item.body === 'string' ? item.body : '',
      labels: Array.isArray(item.labels)
        ? item.labels.flatMap((label) => (isRecord(label) && typeof label.name === 'string' ? [label.name] : []))
        : [],
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    });
  }
  return issues;
}

/** The start of the window (ms) for a run at `now`. */
export function bugFlowWindowStart(now: Date): number {
  return now.getTime() - BUG_FLOW_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The `bug-flow` measurement. `value` is the number of bug Issues in the
 * window; the rates are in `details` (null when the denominator is 0).
 * Nothing is ever a finding, so the rules never make a candidate.
 */
export function measureBugFlow(text: string, now: Date): MetricMeasurement {
  const issues = parseBugIssues(text);
  if (issues === null) return { metricId: 'bug-flow', status: 'skip', reason: 'gh issue list の JSON を読めなかった' };
  const since = bugFlowWindowStart(now);
  const inWindow = issues.filter((issue) => {
    const created = Date.parse(issue.createdAt);
    return Number.isFinite(created) && created >= since && created <= now.getTime();
  });
  const counts = countBugFlow(inWindow);
  const rates = bugFlowRates(counts);
  return {
    metricId: 'bug-flow',
    status: 'ok',
    value: counts.total,
    items: { ...counts },
    findings: {},
    details: { ...counts, unclassified: counts.total - counts.classified, ...rates },
  };
}
