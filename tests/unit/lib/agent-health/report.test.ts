/**
 * Issue #2878: assembling the agent-health report — version comparison,
 * `versionChanged`, state carry-over and the exit code.
 */

import { describe, expect, it } from 'vitest';
import {
  buildToolResult,
  decideExitCode,
  firstVersionLine,
  isVersionChanged,
  nextState,
  paneEvidence,
  parseState,
  previousVersionOf,
  reportDateJst,
  truncateEvidence,
} from '@/lib/agent-health/report';
import {
  MAX_EVIDENCE_CHARS,
  type AgentHealthCheck,
  type AgentHealthReport,
  type AgentHealthToolResult,
  type GlobalConfigRestoreEntry,
} from '@/lib/agent-health/types';

const pass = (checkId: AgentHealthCheck['checkId']): AgentHealthCheck => ({
  checkId,
  status: 'pass',
  summary: 'ok',
});

function report(
  tools: AgentHealthToolResult[],
  restored: GlobalConfigRestoreEntry[] = [],
  scriptErrors?: string[]
): AgentHealthReport {
  return {
    schemaVersion: 1,
    startedAt: '2026-09-27T00:00:00.000Z',
    completedAt: '2026-09-27T00:05:00.000Z',
    host: { commandmateCommit: 'abc', node: 'v24.1.0' },
    tools,
    safety: { globalConfigRestored: restored, tmuxSocket: 'cm-agent-health' },
    ...(scriptErrors ? { scriptErrors } : {}),
  };
}

function tool(checks: AgentHealthCheck[]): AgentHealthToolResult {
  return buildToolResult({ tool: 'codex', version: 'codex-cli 0.157.1', previousVersion: null, checks });
}

describe('versionChanged', () => {
  it('is true only when both versions are known and differ', () => {
    expect(isVersionChanged('codex-cli 0.158.0', 'codex-cli 0.157.1')).toBe(true);
    expect(isVersionChanged('codex-cli 0.157.1', 'codex-cli 0.157.1')).toBe(false);
  });

  it('is false on the first run (no previous version)', () => {
    expect(isVersionChanged('codex-cli 0.157.1', null)).toBe(false);
  });

  it('is false when this run could not read the version', () => {
    expect(isVersionChanged(null, 'codex-cli 0.157.1')).toBe(false);
  });

  it('buildToolResult compares with the previous version from the state', () => {
    const state = parseState(JSON.stringify({ versions: { codex: 'codex-cli 0.156.0' } }));
    const result = buildToolResult({
      tool: 'codex',
      version: 'codex-cli 0.157.1',
      previousVersion: previousVersionOf(state, 'codex'),
      checks: [pass('version')],
    });
    expect(result.previousVersion).toBe('codex-cli 0.156.0');
    expect(result.versionChanged).toBe(true);
    expect(previousVersionOf(state, 'claude')).toBeNull();
  });
});

describe('buildToolResult', () => {
  it('orders checks canonically and truncates evidence', () => {
    const result = buildToolResult({
      tool: 'claude',
      version: '2.1.283 (Claude Code)',
      previousVersion: '2.1.283 (Claude Code)',
      checks: [
        { checkId: 'screen-quoted-dialog', status: 'fail', summary: 'x', evidence: 'e'.repeat(10_000) },
        pass('version'),
        pass('screen-idle'),
        pass('hook-correlation'),
      ],
    });
    expect(result.checks.map((c) => c.checkId)).toEqual([
      'version',
      'hook-correlation',
      'screen-idle',
      'screen-quoted-dialog',
    ]);
    expect(result.checks[3].evidence!.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
    expect(result.versionChanged).toBe(false);
  });
});

describe('nextState', () => {
  it('replaces read versions and keeps the rest', () => {
    const previous = { versions: { claude: 'old-claude', codex: 'old-codex' } };
    const tools = [
      buildToolResult({ tool: 'claude', version: 'new-claude', previousVersion: 'old-claude', checks: [] }),
      buildToolResult({ tool: 'codex', version: null, previousVersion: 'old-codex', checks: [] }),
      buildToolResult({ tool: 'opencode', version: '1.18.32', previousVersion: null, checks: [] }),
    ];
    expect(nextState(previous, tools)).toEqual({
      versions: { claude: 'new-claude', codex: 'old-codex', opencode: '1.18.32' },
    });
  });

  it('parseState treats malformed text as no previous run', () => {
    expect(parseState(null)).toBeNull();
    expect(parseState('{')).toBeNull();
    expect(parseState('{"versions":[]}')).toBeNull();
    expect(parseState('{"versions":{"claude":"1","codex":2}}')).toEqual({ versions: { claude: '1' } });
  });
});

describe('decideExitCode', () => {
  it('is 0 when every check passes or is skipped', () => {
    const skip: AgentHealthCheck = { checkId: 'hook-correlation', status: 'skip', summary: 's', skipReason: 'r' };
    expect(decideExitCode(report([tool([pass('version'), skip])]))).toBe(0);
  });

  it('is 1 when at least one check fails', () => {
    const fail: AgentHealthCheck = { checkId: 'screen-idle', status: 'fail', summary: 'f' };
    expect(decideExitCode(report([tool([pass('version')]), tool([fail])]))).toBe(1);
  });

  it('is 2 when a hook-config file was not restored, even if every check passed', () => {
    const entry = { path: '/x/hooks.json', restored: false, kind: 'hook-config' as const };
    expect(decideExitCode(report([tool([pass('version')])], [entry]))).toBe(2);
  });

  it('treats an entry without a kind as hook-config (fails closed)', () => {
    expect(decideExitCode(report([tool([pass('version')])], [{ path: '/x', restored: false }]))).toBe(2);
  });

  it('does not exit 2 for a trust-state file that was left alone', () => {
    const entry = { path: '/x/settings.json', restored: false, kind: 'trust-state' as const };
    expect(decideExitCode(report([tool([pass('version')])], [entry]))).toBe(0);
  });

  it('is 2 when the script recorded its own errors, over any fail', () => {
    const fail: AgentHealthCheck = { checkId: 'screen-idle', status: 'fail', summary: 'f' };
    expect(decideExitCode(report([tool([fail])], [], ['引数の誤り']))).toBe(2);
  });
});

describe('small helpers', () => {
  it('truncateEvidence keeps the end', () => {
    const text = `${'a'.repeat(5000)}END`;
    const cut = truncateEvidence(text, 100);
    expect(cut.length).toBe(100);
    expect(cut.endsWith('END')).toBe(true);
    expect(truncateEvidence('short')).toBe('short');
  });

  it('paneEvidence collapses blank runs', () => {
    expect(paneEvidence('\n\n\nhead\n\n\n\n   \nfoot\n\n')).toBe('head\n\nfoot');
  });

  it('paneEvidence strips ANSI and keeps the last 40 non-blank-tail lines', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `\u001b[1mrow ${i}\u001b[0m`);
    const evidence = paneEvidence(`${rows.join('\n')}\n\n\n`);
    const lines = evidence.split('\n');
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe('row 20');
    expect(lines[39]).toBe('row 59');
  });

  it('reportDateJst uses the Tokyo date', () => {
    expect(reportDateJst(new Date('2026-09-27T14:59:59Z'))).toBe('2026-09-27');
    expect(reportDateJst(new Date('2026-09-27T15:00:00Z'))).toBe('2026-09-28');
  });

  it('firstVersionLine takes the first non-empty line', () => {
    expect(firstVersionLine('\ncodex-cli 0.157.1\nextra\n')).toBe('codex-cli 0.157.1');
    expect(firstVersionLine('  \n')).toBeNull();
  });
});
