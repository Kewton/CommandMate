/**
 * Issue #3045: the rules of the daily hand-off to Claude 3 — who goes, in which
 * order, whether Claude 3 is free, what is sent and what is recorded.
 */

import { describe, expect, it } from 'vitest';
import {
  buildDispatchRecord,
  buildRequest,
  dispatchComment,
  DISPATCH_INSTANCE_ID,
  DISPATCH_WORKTREE_ID,
  formatDispatchLine,
  issueKind,
  judgeAgentState,
  missingLabels,
  parseDispatchArgs,
  parseIssueList,
  parseLabelNames,
  runSuffixOf,
  selectDispatchTargets,
  sendArgv,
  type CandidateIssue,
} from '@/lib/agent-health/dispatch';
import { parseDispatchRecord } from '@/lib/agent-health/dispatch-record';

function issue(number: number, labels: string[], createdAt: string, author = 'Kewton'): CandidateIssue {
  return { number, title: `t${number}`, author, labels, createdAt };
}

describe('parseIssueList', () => {
  it('reads the shape of `gh issue list --json number,title,author,labels,createdAt`', () => {
    const json = [
      {
        author: { id: 'MDQ', is_bot: false, login: 'Kewton', name: '' },
        createdAt: '2026-09-30T05:18:55Z',
        labels: [{ id: 'LA_1', name: 'bug', description: '', color: 'd73a4a' }, { id: 'LA_2', name: 'agent-health' }],
        number: 3031,
        title: 'fix(agent-health): x',
      },
      { number: 'x' },
      null,
    ];
    expect(parseIssueList(json)).toEqual([
      { number: 3031, title: 'fix(agent-health): x', author: 'Kewton', labels: ['bug', 'agent-health'], createdAt: '2026-09-30T05:18:55Z' },
    ]);
    expect(parseIssueList({})).toBeNull();
  });
});

describe('labels', () => {
  it('names the labels that are missing', () => {
    expect(parseLabelNames([{ name: 'agent-health' }, { name: 'bug' }])).toEqual(['agent-health', 'bug']);
    expect(parseLabelNames(null)).toBeNull();
    expect(missingLabels(['agent-health', 'bug'])).toEqual(['metrics', 'security', 'auto-dispatched']);
    expect(missingLabels(['agent-health', 'metrics', 'security', 'auto-dispatched'])).toEqual([]);
  });
});

describe('issueKind', () => {
  it('takes only the owner\'s agent-health / metrics Issues that were not dispatched yet', () => {
    expect(issueKind(issue(1, ['agent-health', 'bug'], 'a'))).toBe('bug');
    expect(issueKind(issue(1, ['metrics'], 'a', 'kewton'))).toBe('metrics');
    expect(issueKind(issue(1, ['agent-health', 'metrics'], 'a'))).toBe('bug');
    expect(issueKind(issue(1, ['agent-health'], 'a', 'someone-else'))).toBeNull();
    expect(issueKind(issue(1, ['agent-health', 'auto-dispatched'], 'a'))).toBeNull();
    expect(issueKind(issue(1, ['bug'], 'a'))).toBeNull();
  });
});

describe('selectDispatchTargets', () => {
  it('orders bugs oldest first, then security metrics, then other metrics', () => {
    const result = selectDispatchTargets([
      issue(20, ['metrics'], '2026-09-01T00:00:00Z'),
      issue(11, ['agent-health'], '2026-09-20T00:00:00Z'),
      issue(21, ['metrics', 'security'], '2026-09-25T00:00:00Z'),
      issue(10, ['agent-health'], '2026-09-10T00:00:00Z'),
    ]);
    expect(result.issues.map((i) => [i.number, i.kind])).toEqual([
      [10, 'bug'],
      [11, 'bug'],
      [21, 'metrics'],
      [20, 'metrics'],
    ]);
    expect(result.deferred).toEqual([]);
  });

  it('takes at most 2 metrics and defers the rest', () => {
    const result = selectDispatchTargets([
      issue(1, ['metrics'], '2026-09-01'),
      issue(2, ['metrics'], '2026-09-02'),
      issue(3, ['metrics'], '2026-09-03'),
    ]);
    expect(result.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(result.deferred).toEqual([3]);
  });

  it('caps the total at 5: bugs first, overflowing bugs and all metrics deferred', () => {
    const bugs = [1, 2, 3, 4, 5, 6].map((n) => issue(n, ['agent-health'], `2026-09-0${n}`));
    const result = selectDispatchTargets([issue(9, ['metrics', 'security'], '2026-08-01'), ...bugs]);
    expect(result.issues.map((i) => i.number)).toEqual([1, 2, 3, 4, 5]);
    expect(result.deferred).toEqual([6, 9]);
  });

  it('fills the room bugs leave with up to 2 metrics', () => {
    const bugs = [1, 2, 3, 4].map((n) => issue(n, ['agent-health'], `2026-09-0${n}`));
    const metrics = [7, 8].map((n) => issue(n, ['metrics'], `2026-09-0${n}`));
    const result = selectDispatchTargets([...metrics, ...bugs]);
    expect(result.issues.map((i) => i.number)).toEqual([1, 2, 3, 4, 7]);
    expect(result.deferred).toEqual([8]);
  });

  it('ignores other authors and dispatched Issues entirely (not even deferred)', () => {
    const result = selectDispatchTargets([
      issue(1, ['agent-health'], '2026-09-01', 'attacker'),
      issue(2, ['agent-health', 'auto-dispatched'], '2026-09-02'),
    ]);
    expect(result).toEqual({ issues: [], deferred: [] });
  });

  it('breaks a createdAt tie by number', () => {
    const result = selectDispatchTargets([issue(8, ['agent-health'], 'same'), issue(7, ['agent-health'], 'same')]);
    expect(result.issues.map((i) => i.number)).toEqual([7, 8]);
  });
});

describe('judgeAgentState', () => {
  const worktree = (status: Record<string, unknown> | undefined, roster = [{ id: 'claude-3', cliTool: 'claude' }]) => [
    { id: 'other', sessionStatusByInstance: {} },
    {
      id: 'mycodebranchdesk',
      agentInstances: roster,
      sessionStatusByInstance: status === undefined ? {} : { 'claude-3': status },
    },
  ];

  it('is ready when running, not processing and not waiting', () => {
    expect(judgeAgentState(worktree({ isRunning: true, isProcessing: false, isWaitingForResponse: false }))).toEqual({ kind: 'ready' });
  });

  it('is busy while processing or at a prompt', () => {
    expect(
      judgeAgentState(worktree({ isRunning: true, isProcessing: true, isWaitingForResponse: false, sessionStatusReason: 'thinking_indicator' }))
    ).toEqual({ kind: 'busy', detail: '作業中（thinking_indicator）' });
    expect(judgeAgentState(worktree({ isRunning: true, isProcessing: false, isWaitingForResponse: true })).kind).toBe('busy');
    expect(judgeAgentState(worktree({ isRunning: true })).kind).toBe('busy');
  });

  it('is not-running without a session (send starts one)', () => {
    expect(judgeAgentState(worktree({ isRunning: false, isProcessing: false }))).toEqual({ kind: 'not-running' });
    expect(judgeAgentState(worktree(undefined))).toEqual({ kind: 'not-running' });
  });

  it('is unknown when the worktree or instance is not the expected one', () => {
    expect(judgeAgentState(null).kind).toBe('unknown');
    expect(judgeAgentState([{ id: 'other' }]).kind).toBe('unknown');
    expect(judgeAgentState(worktree({ isRunning: true }, [])).kind).toBe('unknown');
    expect(judgeAgentState(worktree({ isRunning: true }, [{ id: 'claude-3', cliTool: 'codex' }])).kind).toBe('unknown');
  });
});

describe('what is sent', () => {
  it('always sends to mycodebranchdesk / claude-3', () => {
    expect(DISPATCH_WORKTREE_ID).toBe('mycodebranchdesk');
    expect(DISPATCH_INSTANCE_ID).toBe('claude-3');
    expect(sendArgv('/clear', false)).toEqual(['send', 'mycodebranchdesk', '/clear', '--instance', 'claude-3']);
    expect(sendArgv('msg', true)).toEqual([
      'send', 'mycodebranchdesk', 'msg', '--instance', 'claude-3', '--auto-yes', '--duration', '8h',
    ]);
  });

  it('builds the request: /orchestrate first, merge permission, run-file names, report, no --full', () => {
    const issues = [
      { number: 3050, kind: 'bug' as const, title: 'a' },
      { number: 3051, kind: 'metrics' as const, title: 'b' },
    ];
    const request = buildRequest('2026-10-01', issues);
    expect(request.split('\n')[0]).toBe('/orchestrate 3050 3051');
    expect(request).toContain('本 run では PR の develop へのマージを進めてよい（利用者の明示的な許可）');
    expect(request).toContain('plan-3050-3051.md・summary-3050-3051.md・tasks-3050-3051.tsv');
    expect(request).toContain('npx tsx scripts/agent-health/release-report.ts --date 2026-10-01');
    expect(request).toContain('workspace/agent-health/2026-10-01/release-readiness.html');
    expect(request).toContain('再依頼・再実行しない');
    expect(request.split('\n')[0]).not.toContain('--full');
  });

  it('sends a single Issue as it is', () => {
    const request = buildRequest('2026-10-01', [{ number: 3045, kind: 'bug', title: 'x' }]);
    expect(request.split('\n')[0]).toBe('/orchestrate 3045');
    expect(request).toContain('1 件で実行する');
    expect(request).toContain('summary-3045.md');
  });

  it('comments with a dated marker and the other Issues of the run', () => {
    const issues = [
      { number: 1, kind: 'bug' as const, title: '' },
      { number: 2, kind: 'bug' as const, title: '' },
    ];
    const body = dispatchComment('2026-10-01', issues[0], issues);
    expect(body.split('\n')[0]).toBe('<!-- agent-health-dispatch:2026-10-01 -->');
    expect(body).toContain('同時に依頼: #2');
    expect(body).toContain('auto-dispatched');
  });
});

describe('record and line', () => {
  const issues = [
    { number: 3050, kind: 'bug' as const, title: 'a' },
    { number: 3051, kind: 'metrics' as const, title: 'b' },
  ];

  it('records a sent run with its suffix, and the report reads it back', () => {
    const record = buildDispatchRecord({ date: '2026-10-01', status: 'sent', sentAt: '2026-10-01T00:30:00.000Z', issues, deferred: [3052] });
    expect(record).toEqual({
      schemaVersion: 1,
      date: '2026-10-01',
      status: 'sent',
      sentAt: '2026-10-01T00:30:00.000Z',
      issues,
      deferred: [3052],
      runSuffix: '3050-3051',
    });
    expect(parseDispatchRecord(JSON.stringify(record))).toEqual(record);
    expect(runSuffixOf(issues)).toBe('3050-3051');
  });

  it('has no sentAt / suffix when nothing was sent, and keeps the reason', () => {
    const record = buildDispatchRecord({ date: '2026-10-01', status: 'skipped-busy', issues: [], deferred: [1], reason: 'busy', sentAt: 'x' });
    expect(record).toEqual({ schemaVersion: 1, date: '2026-10-01', status: 'skipped-busy', issues: [], deferred: [1], reason: 'busy' });
    expect(parseDispatchRecord(JSON.stringify(record))).toEqual(record);
  });

  it('prints the final line', () => {
    expect(formatDispatchLine({ date: '2026-10-01', status: 'sent', issues, deferred: [3052] })).toBe(
      'AGENT_HEALTH_DISPATCH date=2026-10-01 status=sent issues=3050,3051 deferred=3052'
    );
    expect(formatDispatchLine({ date: '2026-10-01', status: 'no-target', issues: [], deferred: [], reason: 'a b' })).toBe(
      'AGENT_HEALTH_DISPATCH date=2026-10-01 status=no-target issues=- deferred=- reason="a b"'
    );
  });
});

describe('parseDispatchArgs', () => {
  it('takes --state-dir and --dry-run only (no destination option)', () => {
    expect(parseDispatchArgs([])).toEqual({ ok: true, options: { stateDir: null, dryRun: false } });
    expect(parseDispatchArgs(['--state-dir', '/s', '--dry-run'])).toEqual({ ok: true, options: { stateDir: '/s', dryRun: true } });
    expect(parseDispatchArgs(['--state-dir=/s'])).toEqual({ ok: true, options: { stateDir: '/s', dryRun: false } });
    expect(parseDispatchArgs(['--instance', 'claude']).ok).toBe(false);
    expect(parseDispatchArgs(['--worktree', 'x']).ok).toBe(false);
    expect(parseDispatchArgs(['--state-dir']).ok).toBe(false);
    expect(parseDispatchArgs(['-h'])).toMatchObject({ ok: false, help: true });
  });
});

describe('parseDispatchRecord runSuffix (#3045)', () => {
  it('drops a suffix that is not digits and dashes', () => {
    const base = { schemaVersion: 1, date: '2026-10-01', status: 'sent', issues: [], deferred: [] };
    expect(parseDispatchRecord(JSON.stringify({ ...base, runSuffix: '../x' }))).toEqual(base);
    expect(parseDispatchRecord(JSON.stringify({ ...base, runSuffix: '1-2' }))?.runSuffix).toBe('1-2');
  });
});
