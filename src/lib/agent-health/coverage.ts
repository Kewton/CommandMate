/**
 * The tool × check table of an agent-health report, and the summary the
 * watcher reads (Issue #3313).
 *
 * 2026-10-05's run was 35 pass and 7 skip out of 6 × 7 checks, and was read as
 * "every check passed". The table therefore has a row for every tool
 * CommandMate supports (the probed six and the version-only three) and a cell
 * for every check, a `skip` cell always says which kind of skip it is, and the
 * summary's first line always puts the three counts side by side.
 *
 * Pure: values in, values out.
 */

import {
  AGENT_HEALTH_CHECK_IDS,
  AGENT_HEALTH_LIMITED_TOOLS,
  AGENT_HEALTH_REPORT_TOOLS,
  AGENT_HEALTH_SKIP_KIND_LABELS,
  AGENT_HEALTH_SKIP_KINDS,
  AGENT_HEALTH_TOOLS,
  type AgentHealthCheck,
  type AgentHealthCheckId,
  type AgentHealthCoverage,
  type AgentHealthCoverageCell,
  type AgentHealthCoverageRow,
  type AgentHealthReportTool,
  type AgentHealthSkipKind,
  type AgentHealthToolResult,
} from './types';
import { launchedModelLabel } from './launched-model';

/** A `skip` check. Every place that skips goes through this, so the kind is never left out. */
export function skipCheck(
  checkId: AgentHealthCheckId,
  skipKind: AgentHealthSkipKind,
  summary: string,
  skipReason: string = summary
): AgentHealthCheck {
  return { checkId, status: 'skip', summary, skipReason, skipKind };
}

/**
 * The version-only tools are read when every probed tool is selected — the
 * daily run — and left out of a `--tools <tool>` retry, where they would only
 * add noise (and a fail of their own) to a one-check rerun.
 */
export function checksLimitedTools(selectedTools: readonly AgentHealthReportTool[]): boolean {
  return AGENT_HEALTH_TOOLS.every((tool) => selectedTools.includes(tool));
}

export function isLimitedTool(tool: AgentHealthReportTool): boolean {
  return (AGENT_HEALTH_LIMITED_TOOLS as readonly string[]).includes(tool);
}

export interface CoverageInput {
  results: readonly AgentHealthToolResult[];
  /** The tools this run was asked to check (probed and version-only). */
  selectedTools: readonly AgentHealthReportTool[];
  /** The checks this run was asked to do. */
  selectedChecks: readonly AgentHealthCheckId[];
}

function cellOf(check: AgentHealthCheck | undefined, selected: boolean): AgentHealthCoverageCell {
  if (check) {
    return check.status === 'skip'
      ? { status: 'skip', skipKind: check.skipKind ?? 'not-recorded' }
      : { status: check.status };
  }
  return { status: 'skip', skipKind: selected ? 'not-recorded' : 'not-selected' };
}

/** Every report tool × every check, in report order. */
export function buildCoverage(input: CoverageInput): AgentHealthCoverage {
  const checkIds = [...AGENT_HEALTH_CHECK_IDS];
  const rows: AgentHealthCoverageRow[] = AGENT_HEALTH_REPORT_TOOLS.map((tool) => {
    const result = input.results.find((entry) => entry.tool === tool);
    const toolSelected = input.selectedTools.includes(tool);
    const cells = Object.fromEntries(
      checkIds.map((checkId) => {
        const check = result?.checks.find((entry) => entry.checkId === checkId);
        const selected = toolSelected && input.selectedChecks.includes(checkId);
        return [checkId, cellOf(check, selected)];
      })
    ) as Record<AgentHealthCheckId, AgentHealthCoverageCell>;
    return { tool, coverage: isLimitedTool(tool) ? 'version-only' : 'probed', cells };
  });

  const counts: AgentHealthCoverage['counts'] = { pass: 0, fail: 0, skip: 0, skipByKind: {} };
  for (const row of rows) {
    for (const checkId of checkIds) {
      const cell = row.cells[checkId];
      counts[cell.status]++;
      if (cell.status === 'skip' && cell.skipKind) {
        counts.skipByKind[cell.skipKind] = (counts.skipByKind[cell.skipKind] ?? 0) + 1;
      }
    }
  }
  return { checkIds, rows, counts };
}

/**
 * `pass N・fail N・skip N（<kind> N・…）`. The breakdown follows
 * {@link AGENT_HEALTH_SKIP_KINDS}' order and is left out only when nothing was skipped.
 */
export function coverageHeadline(counts: AgentHealthCoverage['counts']): string {
  const head = `pass ${counts.pass}・fail ${counts.fail}・skip ${counts.skip}`;
  const parts = AGENT_HEALTH_SKIP_KINDS.filter((kind) => (counts.skipByKind[kind] ?? 0) > 0).map(
    (kind) => `${AGENT_HEALTH_SKIP_KIND_LABELS[kind]} ${counts.skipByKind[kind]}`
  );
  return parts.length > 0 ? `${head}（${parts.join('・')}）` : head;
}

function cellText(cell: AgentHealthCoverageCell): string {
  if (cell.status !== 'skip') return cell.status;
  return `skip（${AGENT_HEALTH_SKIP_KIND_LABELS[cell.skipKind ?? 'not-recorded']}）`;
}

/**
 * The summary: the headline, the table (Markdown), then why each skip was
 * skipped — one line per tool and kind, with the check's own summary. Skips
 * of what this run was not asked to do are counted but not explained.
 */
export function summarizeCoverage(
  coverage: AgentHealthCoverage,
  results: readonly AgentHealthToolResult[]
): string[] {
  const lines = [coverageHeadline(coverage.counts), ''];
  lines.push(`| ツール | ${coverage.checkIds.join(' | ')} |`);
  lines.push(`|---|${coverage.checkIds.map(() => '---').join('|')}|`);
  for (const row of coverage.rows) {
    const name = row.coverage === 'version-only' ? `${row.tool}（version のみ）` : row.tool;
    lines.push(`| ${name} | ${coverage.checkIds.map((checkId) => cellText(row.cells[checkId])).join(' | ')} |`);
  }

  const reasons: string[] = [];
  for (const row of coverage.rows) {
    const result = results.find((entry) => entry.tool === row.tool);
    const groups = new Map<string, { kind: AgentHealthSkipKind; checkIds: string[]; detail: string }>();
    for (const checkId of coverage.checkIds) {
      const cell = row.cells[checkId];
      if (cell.status !== 'skip' || cell.skipKind === 'not-selected') continue;
      const kind = cell.skipKind ?? 'not-recorded';
      const check = result?.checks.find((entry) => entry.checkId === checkId);
      const detail = check?.skipReason ?? check?.summary ?? '';
      const key = `${kind}\u0000${detail}`;
      const group = groups.get(key) ?? { kind, checkIds: [], detail };
      group.checkIds.push(checkId);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const detail = group.detail === '' ? '' : ` — ${group.detail}`;
      reasons.push(`- ${row.tool} ${group.checkIds.join(', ')}: ${AGENT_HEALTH_SKIP_KIND_LABELS[group.kind]}${detail}`);
    }
  }
  if (reasons.length > 0) lines.push('', '未実施の理由:', ...reasons);

  // Issue #3438: a pass keeps no evidence, so this is where the model a tool
  // ran on is told. Version-only rows are never launched.
  const models = coverage.rows
    .filter((row) => row.coverage === 'probed' && results.some((entry) => entry.tool === row.tool))
    .map((row) => `- ${row.tool}: ${launchedModelLabel(results.find((entry) => entry.tool === row.tool)?.launchedModel)}`);
  if (models.length > 0) lines.push('', '起動したモデル:', ...models);
  return lines;
}
