/**
 * Issue #3313: the report's tool × check table and the summary the watcher
 * reads. 2026-10-05 was 35 pass / 7 skip over 6 tools and was read as "every
 * check passed"; the table has all nine tools, every skip cell carries its
 * kind, and the summary's first line always lists pass, fail and skip.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCoverage,
  checksLimitedTools,
  coverageHeadline,
  skipCheck,
  summarizeCoverage,
} from '@/lib/agent-health/coverage';
import { buildToolResult, decideExitCode } from '@/lib/agent-health/report';
import {
  AGENT_HEALTH_CHECK_IDS,
  AGENT_HEALTH_LIMITED_TOOLS,
  AGENT_HEALTH_REPORT_TOOLS,
  AGENT_HEALTH_TOOLS,
  type AgentHealthCheck,
  type AgentHealthCheckId,
  type AgentHealthReport,
  type AgentHealthReportTool,
  type AgentHealthToolResult,
} from '@/lib/agent-health/types';

const pass = (checkId: AgentHealthCheckId): AgentHealthCheck => ({ checkId, status: 'pass', summary: 'ok' });

/** Every check passes except the ones listed. */
function toolResult(tool: AgentHealthReportTool, overrides: AgentHealthCheck[] = []): AgentHealthToolResult {
  const checks = AGENT_HEALTH_CHECK_IDS.map(
    (checkId) => overrides.find((check) => check.checkId === checkId) ?? pass(checkId)
  );
  return buildToolResult({ tool, version: `${tool} 1.0.0`, previousVersion: null, checks });
}

const noPicker = (tool: string) => skipCheck('screen-picker', 'no-definition', '選択画面の定義が無いツール', `${tool} は picker 無し`);
const noApproval = skipCheck('screen-approval', 'not-shown', '承認ダイアログを出さないツール');

/** The shape of 2026-10-05's run: 35 pass, 7 skip. */
const probed: AgentHealthToolResult[] = [
  toolResult('claude'),
  toolResult('codex'),
  toolResult('antigravity', [noPicker('antigravity')]),
  toolResult('opencode', [
    skipCheck('hook-correlation', 'no-definition', 'hook を使わないツール（configScope: none）'),
    noPicker('opencode'),
    noApproval,
  ]),
  toolResult('command-code', [noPicker('command-code')]),
  toolResult('opencode-v2', [noPicker('opencode-v2'), noApproval]),
];

function limited(tool: AgentHealthReportTool, kind: 'signed-out' | 'unsupported', reason: string): AgentHealthToolResult {
  return buildToolResult({
    tool,
    version: `${tool} 1.0.0`,
    previousVersion: null,
    checks: [
      pass('version'),
      ...AGENT_HEALTH_CHECK_IDS.filter((id) => id !== 'version').map((id) => skipCheck(id, kind, `${tool} は起動しない`, reason)),
    ],
  });
}

const daily = [
  ...probed,
  limited('gemini', 'signed-out', 'サインインできない'),
  limited('vibe-local', 'unsupported', '起動手順が無い'),
  limited('copilot', 'unsupported', '起動手順が無い'),
];

const allSelected = {
  selectedTools: [...AGENT_HEALTH_REPORT_TOOLS],
  selectedChecks: [...AGENT_HEALTH_CHECK_IDS],
};

describe('buildCoverage', () => {
  it('has a row for each of the nine tools and a cell for every check', () => {
    const coverage = buildCoverage({ results: daily, ...allSelected });
    expect(coverage.rows.map((row) => row.tool)).toEqual([...AGENT_HEALTH_REPORT_TOOLS]);
    expect(coverage.rows).toHaveLength(9);
    expect(coverage.checkIds).toEqual([...AGENT_HEALTH_CHECK_IDS]);
    for (const row of coverage.rows) expect(Object.keys(row.cells).sort()).toEqual([...AGENT_HEALTH_CHECK_IDS].sort());
    expect(coverage.rows.filter((row) => row.coverage === 'version-only').map((row) => row.tool)).toEqual([
      ...AGENT_HEALTH_LIMITED_TOOLS,
    ]);
  });

  it('counts 2026-10-05 plus the three version-only tools, skips by kind', () => {
    const coverage = buildCoverage({ results: daily, ...allSelected });
    expect(coverage.counts).toEqual({
      pass: 38,
      fail: 0,
      skip: 25,
      skipByKind: { 'no-definition': 5, 'not-shown': 2, 'signed-out': 6, unsupported: 12 },
    });
  });

  it('every skip cell has a kind; gemini shows that it cannot sign in', () => {
    const coverage = buildCoverage({ results: daily, ...allSelected });
    for (const row of coverage.rows) {
      for (const cell of Object.values(row.cells)) {
        if (cell.status === 'skip') expect(cell.skipKind).toBeDefined();
      }
    }
    const gemini = coverage.rows.find((row) => row.tool === 'gemini')!;
    expect(gemini.cells.version).toEqual({ status: 'pass' });
    expect(gemini.cells['screen-idle']).toEqual({ status: 'skip', skipKind: 'signed-out' });
  });

  it('a tool or check this run was not asked for is "not-selected"; a selected one with nothing recorded is "not-recorded"', () => {
    const codexOnly = buildToolResult({
      tool: 'codex',
      version: 'codex 1',
      previousVersion: null,
      checks: [pass('version')],
    });
    const coverage = buildCoverage({
      results: [codexOnly],
      selectedTools: ['codex'],
      selectedChecks: ['version', 'screen-idle'],
    });
    const codex = coverage.rows.find((row) => row.tool === 'codex')!;
    expect(codex.cells['screen-idle']).toEqual({ status: 'skip', skipKind: 'not-recorded' });
    expect(codex.cells['screen-running']).toEqual({ status: 'skip', skipKind: 'not-selected' });
    const claude = coverage.rows.find((row) => row.tool === 'claude')!;
    expect(claude.cells.version).toEqual({ status: 'skip', skipKind: 'not-selected' });
  });

  it('a skip produced without a kind is shown as "not-recorded", not as fine', () => {
    const bare: AgentHealthCheck = { checkId: 'hook-correlation', status: 'skip', summary: 's', skipReason: 'r' };
    const coverage = buildCoverage({ results: [toolResult('claude', [bare])], ...allSelected });
    expect(coverage.rows[0].cells['hook-correlation']).toEqual({ status: 'skip', skipKind: 'not-recorded' });
  });
});

describe('coverageHeadline / summarizeCoverage', () => {
  it('line 1 is "pass N・fail N・skip N（kind N・…）"', () => {
    const coverage = buildCoverage({ results: daily, ...allSelected });
    expect(coverageHeadline(coverage.counts)).toBe(
      'pass 38・fail 0・skip 25（検査の定義が無い 5・このツールは、その画面を出さない 2・サインインできない 6・ツールが未対応 12）'
    );
  });

  it('lists all three counts even when nothing was skipped', () => {
    expect(coverageHeadline({ pass: 7, fail: 0, skip: 0, skipByKind: {} })).toBe('pass 7・fail 0・skip 0');
  });

  it('has the table and the reasons, and never reads as "all pass"', () => {
    const coverage = buildCoverage({ results: daily, ...allSelected });
    const lines = summarizeCoverage(coverage, daily);
    expect(lines[0]).toMatch(/^pass \d+・fail \d+・skip \d+/);
    expect(lines).toContain(`| ツール | ${AGENT_HEALTH_CHECK_IDS.join(' | ')} |`);
    const geminiRow = lines.find((line) => line.startsWith('| gemini'));
    expect(geminiRow).toContain('gemini（version のみ）');
    expect(geminiRow).toContain('| pass |');
    expect(geminiRow).toContain('skip（サインインできない）');
    expect(lines).toContain(
      '- gemini hook-correlation, screen-idle, screen-picker, screen-running, screen-approval, screen-quoted-dialog: サインインできない — サインインできない'
    );
    expect(lines).toContain('- opencode screen-approval: このツールは、その画面を出さない — 承認ダイアログを出さないツール');
    expect(lines.join('\n')).not.toMatch(/全項目|all pass/i);
  });

  it('does not explain what the run was not asked to do', () => {
    const coverage = buildCoverage({
      results: [toolResult('codex')],
      selectedTools: ['codex'],
      selectedChecks: [...AGENT_HEALTH_CHECK_IDS],
    });
    const lines = summarizeCoverage(coverage, [toolResult('codex')]);
    expect(lines[0]).toBe('pass 7・fail 0・skip 56（今回の実行の対象外 56）');
    expect(lines).not.toContain('未実施の理由:');
  });
});

describe('checksLimitedTools', () => {
  it('is true on the daily run (every probed tool), false on a --tools retry', () => {
    expect(checksLimitedTools([...AGENT_HEALTH_TOOLS])).toBe(true);
    expect(checksLimitedTools(['codex'])).toBe(false);
  });
});

describe('exit code (unchanged by the new rows)', () => {
  const report = (tools: AgentHealthToolResult[]): AgentHealthReport => ({
    schemaVersion: 1,
    startedAt: '2026-10-05T00:00:00.000Z',
    completedAt: '2026-10-05T00:10:00.000Z',
    host: { commandmateCommit: 'abc', node: 'v24' },
    tools,
    safety: { globalConfigRestored: [], tmuxSocket: 'cm-agent-health' },
  });

  it('is 0 with the skipped version-only rows, 1 when one of them fails', () => {
    expect(decideExitCode(report(daily))).toBe(0);
    const geminiGone = buildToolResult({
      tool: 'gemini',
      version: null,
      previousVersion: null,
      checks: [{ checkId: 'version', status: 'fail', summary: 'x' }],
    });
    expect(decideExitCode(report([...probed, geminiGone]))).toBe(1);
  });
});
