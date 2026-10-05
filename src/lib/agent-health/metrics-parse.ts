/**
 * Turning each measuring tool's raw output into a {@link MetricMeasurement}
 * (Issue #3044). Pure: text in, values out. The commands themselves run in
 * `scripts/agent-health/metrics-runners.ts`.
 *
 * Unreadable output becomes `status: 'skip'` with the reason — a tool that
 * could not answer is not a finding.
 */

import {
  AUDIT_MIN_SEVERITY,
  COMPLEXITY_ALERT,
  FILE_SIZE_LIMIT,
  FILE_SIZE_REPORT_LINES,
  OUTDATED_MAJOR_LAG,
  type MetricFinding,
  type MetricId,
  type MetricMeasurement,
} from './metrics-types';

/** npm's severity ladder, lowest first (same as scripts/check-npm-audit.mjs). */
export const AUDIT_LEVELS = ['info', 'low', 'moderate', 'high', 'critical'] as const;

export function severityRank(severity: string | undefined): number {
  const index = (AUDIT_LEVELS as readonly string[]).indexOf(severity ?? '');
  return index < 0 ? 0 : index;
}

function skip(metricId: MetricId, reason: string): MetricMeasurement {
  return { metricId, status: 'skip', reason };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Two decimals, the precision every percentage in the report uses. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ── npm-audit ──────────────────────────────────────────────────────────────

export type NpmAuditVerdict =
  | { kind: 'report'; json: Record<string, unknown> }
  | { kind: 'unreachable'; message: string }
  | { kind: 'unreadable'; message: string };

/**
 * The same three-way split as `classifyAuditOutput` in scripts/check-npm-audit.mjs
 * (Issue #2313): a report carries `auditReportVersion`; npm's error envelope
 * (`{ message, error }`) means the registry did not answer and nothing was audited.
 */
export function classifyNpmAudit(text: string): NpmAuditVerdict {
  const json = parseJson(text);
  if (json === undefined) return { kind: 'unreadable', message: 'stdout is not JSON' };
  if (!isRecord(json)) return { kind: 'unreadable', message: 'stdout is JSON but not an object' };
  if (typeof json.auditReportVersion === 'number') return { kind: 'report', json };
  if ('error' in json) {
    const err = json.error;
    const message =
      str(json.message) ??
      (isRecord(err) ? str(err.summary) ?? str(err.code) ?? str(err.detail) : undefined) ??
      (typeof err === 'string' ? err : JSON.stringify(err));
    return { kind: 'unreachable', message: message || 'npm reported an error without a message' };
  }
  return { kind: 'unreadable', message: 'JSON has neither auditReportVersion nor an error envelope' };
}

/** `fixAvailable` of a vulnerability entry, in words. */
export function describeAuditFix(fixAvailable: unknown): string {
  if (fixAvailable === true) return '修正版あり（`npm audit fix` でメジャー更新なしに直る）';
  if (isRecord(fixAvailable)) {
    const target = `${str(fixAvailable.name) ?? '?'}@${str(fixAvailable.version) ?? '?'}`;
    return fixAvailable.isSemVerMajor === true
      ? `修正には ${target} への**メジャー更新**が必要`
      : `${target} への更新で直る（メジャー更新なし）`;
  }
  return '修正版なし（上流の対応待ち）';
}

/** The version an advisory's `range` stops at (`>=8.0.0 <8.21.0` → `8.21.0`); null when open-ended. */
export function fixedVersionOf(range: string | undefined): string | null {
  const bounds = [...(range ?? '').matchAll(/<\s*(\d+\.\d+\.\d+)(?![\d.])/g)].map((m) => m[1]);
  return bounds.length > 0 ? bounds.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b)) : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function advisoryId(url: string | undefined, source: unknown): string {
  const ghsa = url?.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i)?.[0];
  if (ghsa) return ghsa;
  const id = num(source);
  return id !== undefined ? `advisory-${id}` : 'advisory-unknown';
}

/**
 * High-and-above advisories of an `npm audit --omit=dev --json` run.
 *
 * Detection is per advisory (`items` holds `<package>:<GHSA id>`, and
 * `value` counts them), but a finding is per **package**: one version bump
 * fixes every advisory of a package (15 of the 33 on 2026-10-01 were
 * `@xmldom/xmldom`), so one Issue per package. A package becomes a candidate
 * again when it gains an advisory the previous run did not have
 * (`itemKeys`).
 */
export function measureNpmAudit(text: string): MetricMeasurement {
  const verdict = classifyNpmAudit(text);
  if (verdict.kind === 'unreachable') {
    return skip('npm-audit', `registry が応答しなかった（監査していない）: ${verdict.message}`);
  }
  if (verdict.kind === 'unreadable') return skip('npm-audit', `npm audit の出力を読めない: ${verdict.message}`);

  const vulnerabilities = isRecord(verdict.json.vulnerabilities) ? verdict.json.vulnerabilities : {};
  const minRank = severityRank(AUDIT_MIN_SEVERITY);
  const items: Record<string, number> = {};
  const byPackage = new Map<
    string,
    { rank: number; lines: string[]; itemKeys: string[]; owner: Record<string, unknown>; fixedIn: string | null; open: boolean }
  >();

  for (const entry of Object.values(vulnerabilities)) {
    if (!isRecord(entry) || !Array.isArray(entry.via)) continue;
    for (const via of entry.via) {
      if (!isRecord(via)) continue; // a string names another vulnerable package, not an advisory
      const severity = str(via.severity);
      if (severityRank(severity) < minRank) continue;
      const pkg = str(via.name) ?? str(entry.name) ?? 'unknown';
      const url = str(via.url);
      const itemKey = `${pkg}:${advisoryId(url, via.source)}`;
      if (itemKey in items) continue;
      items[itemKey] = severityRank(severity);
      const owner = vulnerabilities[pkg];
      const group = byPackage.get(pkg) ?? {
        rank: 0,
        lines: [],
        itemKeys: [],
        owner: isRecord(owner) ? owner : entry,
        fixedIn: null,
        open: false,
      };
      group.rank = Math.max(group.rank, severityRank(severity));
      const fixedIn = fixedVersionOf(str(via.range));
      if (fixedIn === null) group.open = true;
      else if (group.fixedIn === null || compareVersions(fixedIn, group.fixedIn) > 0) group.fixedIn = fixedIn;
      group.itemKeys.push(itemKey);
      group.lines.push(`- ${severity} ${str(via.range) ?? ''} ${str(via.title) ?? 'advisory'}${url ? ` (${url})` : ''}`);
      byPackage.set(pkg, group);
    }
  }

  const findings: Record<string, MetricFinding> = {};
  for (const [pkg, group] of byPackage) {
    const severity = AUDIT_LEVELS[group.rank];
    const direct = group.owner.isDirect === true ? '直接依存' : '間接依存';
    findings[pkg] = {
      target: pkg,
      title: `security: ${pkg} の脆弱性 ${group.itemKeys.length} 件（${severity}）を解消する`,
      severity,
      itemKeys: group.itemKeys,
      evidence: [
        `${pkg}（${direct}）の ${AUDIT_MIN_SEVERITY} 以上の advisory ${group.itemKeys.length} 件:`,
        ...group.lines,
        ...(group.fixedIn !== null && !group.open
          ? [`目標: ${pkg} を ${group.fixedIn} 以上にし、\`npm audit --omit=dev\` で上の advisory が消える`]
          : []),
        `修正: ${describeAuditFix(group.owner.fixAvailable)}`,
      ].join('\n'),
    };
  }

  const metadata = isRecord(verdict.json.metadata) ? verdict.json.metadata : {};
  const counts = isRecord(metadata.vulnerabilities) ? metadata.vulnerabilities : {};
  const details: Record<string, number> = { packages: byPackage.size };
  for (const level of AUDIT_LEVELS) details[level] = num(counts[level]) ?? 0;

  return {
    metricId: 'npm-audit',
    status: 'ok',
    value: Object.keys(items).length,
    items,
    findings,
    details,
  };
}

// ── semgrep ────────────────────────────────────────────────────────────────

/** ERROR results of `semgrep --json`, one finding per rule × file. */
export function measureSemgrep(text: string): MetricMeasurement {
  const json = parseJson(text);
  if (!isRecord(json) || !Array.isArray(json.results)) {
    return skip('semgrep', 'semgrep の出力に results が無い');
  }
  const findings: Record<string, MetricFinding> = {};
  const items: Record<string, number> = {};
  let errors = 0;
  let warnings = 0;
  for (const result of json.results) {
    if (!isRecord(result)) continue;
    const extra = isRecord(result.extra) ? result.extra : {};
    const severity = str(extra.severity);
    if (severity === 'WARNING') warnings++;
    if (severity !== 'ERROR') continue;
    errors++;
    const rule = str(result.check_id) ?? 'unknown-rule';
    const file = str(result.path) ?? 'unknown-file';
    const line = isRecord(result.start) ? num(result.start.line) : undefined;
    const target = `${rule}:${file}`;
    items[target] = (items[target] ?? 0) + 1;
    const where = `${file}${line !== undefined ? `:${line}` : ''}`;
    const previous = findings[target];
    findings[target] = {
      target,
      title: `security: semgrep ${rule.split('.').pop()} が ${file} で検出された`,
      severity: 'high',
      evidence: previous
        ? `${previous.evidence}\n${where}`
        : `${rule}\n${str(extra.message) ?? ''}\n${where}`,
    };
  }
  return {
    metricId: 'semgrep',
    status: 'ok',
    value: errors,
    items,
    findings,
    details: { error: errors, warning: warnings, toolErrors: Array.isArray(json.errors) ? json.errors.length : 0 },
  };
}

// ── secrets (gitleaks) ─────────────────────────────────────────────────────

/** A gitleaks JSON report (an array of leaks, secrets redacted). */
export function measureGitleaks(text: string): MetricMeasurement {
  const trimmed = text.trim();
  const json = trimmed === '' ? [] : parseJson(trimmed);
  if (!Array.isArray(json)) return skip('secrets', 'gitleaks のレポートを読めない');
  const findings: Record<string, MetricFinding> = {};
  const items: Record<string, number> = {};
  for (const leak of json) {
    if (!isRecord(leak)) continue;
    const rule = str(leak.RuleID) ?? 'unknown-rule';
    const file = str(leak.File) ?? 'unknown-file';
    const line = num(leak.StartLine);
    const commit = str(leak.Commit);
    const target = str(leak.Fingerprint) ?? `${file}:${rule}:${line ?? '?'}`;
    items[target] = 1;
    findings[target] = {
      target,
      title: `security: 秘密情報らしき文字列（${rule}）が ${file} にある`,
      severity: 'critical',
      evidence: `${rule} ${file}${line !== undefined ? `:${line}` : ''}${commit ? ` (commit ${commit.slice(0, 12)})` : ''}`,
    };
  }
  return { metricId: 'secrets', status: 'ok', value: json.length, items, findings };
}

// ── file-size ──────────────────────────────────────────────────────────────

/** Lines of a file's text, as `wc -l` counts them for a file ending in a newline. */
export function countLines(text: string): number {
  if (text === '') return 0;
  const newlines = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

/** `lines` maps repo-relative path → line count for every source file under src/. */
export function measureFileSize(lines: Record<string, number>): MetricMeasurement {
  const findings: Record<string, MetricFinding> = {};
  let overReport = 0;
  let maxPath = '';
  let max = 0;
  for (const [file, count] of Object.entries(lines)) {
    if (count > FILE_SIZE_REPORT_LINES) overReport++;
    if (count > max) {
      max = count;
      maxPath = file;
    }
    if (count > FILE_SIZE_LIMIT) {
      findings[file] = { target: file, title: `refactor: ${file} を分割する（${count} 行）` };
    }
  }
  return {
    metricId: 'file-size',
    status: 'ok',
    value: Object.keys(findings).length,
    items: { ...lines },
    findings,
    details: {
      files: Object.keys(lines).length,
      [`over${FILE_SIZE_REPORT_LINES}`]: overReport,
      [`over${FILE_SIZE_LIMIT}`]: Object.keys(findings).length,
      maxLines: max,
      maxPath,
    },
  };
}

// ── complexity (ESLint) ────────────────────────────────────────────────────

const COMPLEXITY_MESSAGE = /^(.*?) has a complexity of (\d+)/;

/**
 * `eslint --format json` output where the only rule is `complexity`. `items`
 * is each file's most complex function; a file whose maximum reaches
 * {@link COMPLEXITY_ALERT} is a finding.
 */
export function measureComplexity(text: string, repoRoot: string): MetricMeasurement {
  const json = parseJson(text);
  if (!Array.isArray(json)) return skip('complexity', 'ESLint の JSON 出力を読めない');
  const items: Record<string, number> = {};
  const worst: Record<string, { name: string; line: number | undefined; value: number }> = {};
  let measured = 0;
  let alert = 0;
  const prefix = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  for (const file of json) {
    if (!isRecord(file) || !Array.isArray(file.messages)) continue;
    const filePath = str(file.filePath) ?? 'unknown-file';
    const rel = filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
    for (const message of file.messages) {
      if (!isRecord(message) || message.ruleId !== 'complexity') continue;
      const match = str(message.message)?.match(COMPLEXITY_MESSAGE);
      if (!match) continue;
      const value = Number(match[2]);
      measured++;
      if (value >= COMPLEXITY_ALERT) alert++;
      if (value > (items[rel] ?? 0)) {
        items[rel] = value;
        worst[rel] = { name: match[1], line: num(message.line), value };
      }
    }
  }
  const findings: Record<string, MetricFinding> = {};
  for (const [file, value] of Object.entries(items)) {
    if (value < COMPLEXITY_ALERT) continue;
    const { name, line } = worst[file];
    findings[file] = {
      target: file,
      title: `refactor: ${file} の ${name} の複雑度を下げる（${value}）`,
      evidence: `${file}${line !== undefined ? `:${line}` : ''} ${name} — complexity ${value}`,
    };
  }
  const top = Object.entries(items).sort((a, b) => b[1] - a[1])[0];
  return {
    metricId: 'complexity',
    status: 'ok',
    value: alert,
    items,
    findings,
    details: { functionsMeasured: measured, functionsOverAlert: alert, max: top?.[1] ?? 0, maxPath: top?.[0] ?? '' },
  };
}

// ── duplication (jscpd) ────────────────────────────────────────────────────

/** jscpd's `jscpd-report.json`: the duplicated-lines percentage of the whole scan. */
export function measureDuplication(text: string): MetricMeasurement {
  const json = parseJson(text);
  const total =
    isRecord(json) && isRecord(json.statistics) && isRecord(json.statistics.total) ? json.statistics.total : null;
  const percentage = total ? num(total.percentage) : undefined;
  if (!total || percentage === undefined) return skip('duplication', 'jscpd のレポートに statistics.total.percentage が無い');
  const value = round2(percentage);
  return {
    metricId: 'duplication',
    status: 'ok',
    value,
    items: { percentage: value },
    findings: {},
    details: {
      clones: num(total.clones) ?? 0,
      duplicatedLines: num(total.duplicatedLines) ?? 0,
      lines: num(total.lines) ?? 0,
    },
  };
}

// ── unused (knip) ──────────────────────────────────────────────────────────

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (isRecord(entry) ? str(entry.name) : str(entry)))
    .filter((name): name is string => name !== undefined);
}

/** `knip --reporter json`: unused dependencies and files are findings (files keyed by repo-relative path); unused exports are counted. */
export function measureKnip(text: string): MetricMeasurement {
  const json = parseJson(text);
  if (!isRecord(json) || !Array.isArray(json.issues)) return skip('unused', 'knip の JSON 出力に issues が無い');
  const findings: Record<string, MetricFinding> = {};
  const items: Record<string, number> = {};
  let exports = 0;
  const unusedFiles = new Set<string>(names(json.files));
  for (const issue of json.issues) {
    if (!isRecord(issue)) continue;
    for (const file of names(issue.files)) unusedFiles.add(file);
    exports += names(issue.exports).length + names(issue.types).length;
    for (const [field, label] of [
      ['dependencies', 'dependencies'],
      ['devDependencies', 'devDependencies'],
    ] as const) {
      for (const name of names(issue[field])) {
        items[name] = 1;
        findings[name] = {
          target: name,
          title: `chore: 未使用の依存 ${name} を外す`,
          evidence: `knip: ${name} は ${label} にあるが import されていない（${str(issue.file) ?? 'package.json'}）`,
        };
      }
    }
  }
  const dependencies = Object.keys(findings).length;
  for (const file of unusedFiles) {
    items[file] = 1;
    findings[file] = {
      target: file,
      title: `chore: 未使用のファイル ${file} を確認する`,
      evidence: `knip: ${file} はどこからも import されていない（消して安全かは別途確認する）`,
    };
  }
  return {
    metricId: 'unused',
    status: 'ok',
    value: dependencies,
    items,
    findings,
    details: { unusedExports: exports, unusedFiles: unusedFiles.size },
  };
}

// ── outdated ───────────────────────────────────────────────────────────────

export function majorOf(version: unknown): number | undefined {
  const match = typeof version === 'string' ? version.match(/^v?(\d+)\./) : null;
  return match ? Number(match[1]) : undefined;
}

/**
 * `npm outdated --json` limited to the direct dependencies. `items` maps each
 * to how many majors it is behind `latest`; {@link OUTDATED_MAJOR_LAG} or more
 * is a finding.
 */
export function measureOutdated(text: string, directDependencies: readonly string[]): MetricMeasurement {
  const json = text.trim() === '' ? {} : parseJson(text);
  if (!isRecord(json)) return skip('outdated', 'npm outdated の出力を読めない');
  if ('error' in json && !Object.values(json).some((entry) => isRecord(entry) && 'latest' in entry)) {
    return skip('outdated', `npm outdated が失敗した: ${JSON.stringify(json.error).slice(0, 200)}`);
  }
  const direct = new Set(directDependencies);
  const items: Record<string, number> = {};
  const findings: Record<string, MetricFinding> = {};
  for (const [name, entry] of Object.entries(json)) {
    if (!direct.has(name) || !isRecord(entry)) continue;
    const current = majorOf(entry.current);
    const latest = majorOf(entry.latest);
    if (current === undefined || latest === undefined) continue;
    const lag = latest - current;
    items[name] = lag;
    if (lag >= OUTDATED_MAJOR_LAG) {
      findings[name] = {
        target: name,
        title: `chore: ${name} を ${str(entry.current)} から ${str(entry.latest)} へ上げる（メジャー ${lag} 版遅れ）`,
        evidence: `${name}: current ${str(entry.current)} / wanted ${str(entry.wanted) ?? '?'} / latest ${str(entry.latest)}`,
      };
    }
  }
  return {
    metricId: 'outdated',
    status: 'ok',
    value: Object.keys(findings).length,
    items,
    findings,
    details: { directOutdated: Object.keys(items).length },
  };
}

// ── type-safety ────────────────────────────────────────────────────────────

export interface TypeSafetyCounts {
  any: number;
  eslintDisable: number;
  tsIgnore: number;
}

const ANY_TYPE = /(?:[:<,|&(]\s*|\bas\s+)any\b(?![\w$-])/g;
const ESLINT_DISABLE = /eslint-disable(?:-next-line|-line)?(?![\w-])/g;
const TS_IGNORE = /@ts-ignore\b/g;

/** Occurrences in one file's text. `any` counts type positions (`: any`, `as any`, `<any>`, `| any` …). */
export function countTypeSafety(text: string): TypeSafetyCounts {
  return {
    any: text.match(ANY_TYPE)?.length ?? 0,
    eslintDisable: text.match(ESLINT_DISABLE)?.length ?? 0,
    tsIgnore: text.match(TS_IGNORE)?.length ?? 0,
  };
}

export function measureTypeSafety(counts: TypeSafetyCounts): MetricMeasurement {
  return {
    metricId: 'type-safety',
    status: 'ok',
    value: counts.any + counts.eslintDisable + counts.tsIgnore,
    items: { any: counts.any, 'eslint-disable': counts.eslintDisable, 'ts-ignore': counts.tsIgnore },
    findings: {},
  };
}

// ── coverage ───────────────────────────────────────────────────────────────

/** vitest's `coverage-summary.json` (reporter `json-summary`). `value` is the lines percentage. */
export function measureCoverage(text: string): MetricMeasurement {
  const json = parseJson(text);
  const total = isRecord(json) && isRecord(json.total) ? json.total : null;
  const pct = (key: string) => (total && isRecord(total[key]) ? num(total[key].pct) : undefined);
  const lines = pct('lines');
  if (lines === undefined) return skip('coverage', 'coverage-summary.json に total.lines.pct が無い');
  const items: Record<string, number> = { lines: round2(lines) };
  for (const key of ['statements', 'branches', 'functions']) {
    const value = pct(key);
    if (value !== undefined) items[key] = round2(value);
  }
  return { metricId: 'coverage', status: 'ok', value: round2(lines), items, findings: {} };
}
