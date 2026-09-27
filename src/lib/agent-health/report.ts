/**
 * Assembling the agent-health report and deciding the exit code (Issue #2878).
 *
 * Pure: everything here takes values and returns values, so the rules the
 * scheduled AI (#2879) depends on — when `versionChanged` is true, which exit
 * code a run ends with — are pinned by unit tests rather than by a live run.
 */

import { stripAnsi } from '@/lib/detection/ansi';
import {
  AGENT_HEALTH_CHECK_IDS,
  EVIDENCE_PANE_LINES,
  MAX_EVIDENCE_CHARS,
  type AgentHealthCheck,
  type AgentHealthReport,
  type AgentHealthState,
  type AgentHealthTool,
  type AgentHealthToolResult,
} from './types';

/** `0` all pass/skip, `1` at least one fail, `2` the script itself went wrong. */
export type AgentHealthExitCode = 0 | 1 | 2;

const TRUNCATION_MARKER = '…(truncated)\n';

/**
 * Cut evidence to {@link MAX_EVIDENCE_CHARS}, keeping the END — the end of a
 * pane is where the prompt, the dialog and the error are.
 */
export function truncateEvidence(text: string, max: number = MAX_EVIDENCE_CHARS): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - TRUNCATION_MARKER.length);
  return `${TRUNCATION_MARKER}${text.slice(text.length - keep)}`;
}

/**
 * The last {@link EVIDENCE_PANE_LINES} lines of a frame, ANSI stripped, with
 * runs of blank rows collapsed to one — a 1000-row pane (or opencode's
 * centred home screen) is otherwise mostly empty rows.
 */
export function paneEvidence(frame: string, lines: number = EVIDENCE_PANE_LINES): string {
  const rows: string[] = [];
  for (const row of stripAnsi(frame).split('\n')) {
    const trimmed = row.replace(/\s+$/, '');
    if (trimmed === '' && (rows.length === 0 || rows[rows.length - 1] === '')) continue;
    rows.push(trimmed);
  }
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return truncateEvidence(rows.slice(Math.max(0, rows.length - lines)).join('\n'));
}

/**
 * True only when both versions are known and differ. The first run (no
 * previous version) and a run whose `--version` failed are not "changes".
 */
export function isVersionChanged(version: string | null, previousVersion: string | null): boolean {
  return version !== null && previousVersion !== null && version !== previousVersion;
}

/** Checks in the canonical order, whatever order they were produced in. */
export function sortChecks(checks: readonly AgentHealthCheck[]): AgentHealthCheck[] {
  const rank = (check: AgentHealthCheck) => AGENT_HEALTH_CHECK_IDS.indexOf(check.checkId);
  return [...checks].sort((a, b) => rank(a) - rank(b));
}

export function buildToolResult(input: {
  tool: AgentHealthTool;
  version: string | null;
  previousVersion: string | null;
  checks: readonly AgentHealthCheck[];
}): AgentHealthToolResult {
  return {
    tool: input.tool,
    version: input.version,
    previousVersion: input.previousVersion,
    versionChanged: isVersionChanged(input.version, input.previousVersion),
    checks: sortChecks(input.checks).map((check) => ({
      ...check,
      ...(check.evidence !== undefined ? { evidence: truncateEvidence(check.evidence) } : {}),
    })),
  };
}

/** The previous version of `tool`, or null when the state has none. */
export function previousVersionOf(
  state: AgentHealthState | null,
  tool: AgentHealthTool
): string | null {
  const value = state?.versions?.[tool];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The state to write after this run: every version this run read replaces the
 * old one; tools this run did not read (not selected, `--version` failed) keep
 * what the previous run recorded, so one bad day does not erase the baseline.
 */
export function nextState(
  previous: AgentHealthState | null,
  tools: readonly AgentHealthToolResult[]
): AgentHealthState {
  const versions: Partial<Record<AgentHealthTool, string>> = { ...(previous?.versions ?? {}) };
  for (const result of tools) {
    if (result.version !== null) versions[result.tool] = result.version;
  }
  return { versions };
}

/** Read a state file's text, tolerating anything malformed as "no previous run". */
export function parseState(text: string | null): AgentHealthState | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const versions = (parsed as { versions?: unknown }).versions;
    if (typeof versions !== 'object' || versions === null || Array.isArray(versions)) return null;
    const clean: Partial<Record<AgentHealthTool, string>> = {};
    for (const [key, value] of Object.entries(versions)) {
      if (typeof value === 'string') clean[key as AgentHealthTool] = value;
    }
    return { versions: clean };
  } catch {
    return null;
  }
}

export function decideExitCode(report: AgentHealthReport): AgentHealthExitCode {
  if ((report.scriptErrors?.length ?? 0) > 0) return 2;
  const unrestored = report.safety.globalConfigRestored.some(
    (entry) => !entry.restored && entry.kind !== 'trust-state'
  );
  if (unrestored) return 2;
  const failed = report.tools.some((tool) => tool.checks.some((check) => check.status === 'fail'));
  return failed ? 1 : 0;
}

/** `YYYY-MM-DD` of `now` in JST (the report's file name). */
export function reportDateJst(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** First non-empty line of `--version` output, trimmed; null when there is none. */
export function firstVersionLine(output: string): string | null {
  const line = stripAnsi(output)
    .split('\n')
    .map((row) => row.trim())
    .find((row) => row.length > 0);
  return line ?? null;
}
