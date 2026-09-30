/**
 * Issue #3046: the release-readiness rules (GO / 要判断 / NO-GO) and the
 * readers of the facts they are decided from.
 */

import { describe, expect, it } from 'vitest';
import {
  compareMetrics,
  countHighAdvisories,
  decideReadiness,
  extractAgentHealthKey,
  findPullRequestForIssue,
  formatDelta,
  jstDateOf,
  latestDateBefore,
  mergedOnDate,
  parseHealthReportDigest,
  parseMetricsFile,
  parsePullRequests,
  parseReleaseReportArgs,
  parseTasksTsv,
  parseVerifyExit,
  pickWaitLog,
  reproducesFailAfter,
  summarizeCheckRollup,
  summarizeWorkflowRuns,
  type DispatchedIssueRow,
  type PullRequestInfo,
  type ReadinessFacts,
} from '@/lib/agent-health/release-readiness';

function row(overrides: Partial<DispatchedIssueRow> = {}): DispatchedIssueRow {
  return {
    number: 3050,
    kind: 'bug',
    title: 't',
    agent: 'claude (opus)',
    pr: { number: 3060, url: 'https://github.com/o/r/pull/3060', state: 'MERGED' },
    ci: 'success',
    verifyExit: 0,
    merged: true,
    mergedAt: '2026-10-01T03:00:00Z',
    commit: 'abcdef0123',
    agentHealthKey: null,
    reproducedFail: null,
    ...overrides,
  };
}

function facts(overrides: Partial<ReadinessFacts> = {}): ReadinessFacts {
  return {
    developCi: 'success',
    mergedToday: [{ number: 3060, title: 'fix', url: '', checks: 'success' }],
    audit: { current: 0, atLastRelease: 0 },
    dispatchStatus: 'sent',
    dispatched: [row()],
    prLookupOk: true,
    deferred: [],
    ...overrides,
  };
}

function pr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 1,
    title: '',
    url: '',
    state: 'OPEN',
    headRefName: '',
    baseRefName: 'develop',
    mergedAt: null,
    mergeCommit: null,
    headRefOid: null,
    body: '',
    checks: 'unknown',
    ...overrides,
  };
}

describe('decideReadiness', () => {
  it('GO when nothing applies, with reasons', () => {
    const decision = decideReadiness(facts());
    expect(decision.verdict).toBe('go');
    expect(decision.reasons.length).toBeGreaterThan(0);
    expect(decision.reasons).toContain('develop HEAD の CI は緑');
    expect(decision.nextSteps).toEqual(['`/release` を実行する']);
  });

  it('GO on a day nothing was dispatched', () => {
    const decision = decideReadiness(facts({ dispatchStatus: null, dispatched: [], mergedToday: [] }));
    expect(decision.verdict).toBe('go');
    expect(decision.reasons).toContain('dispatch した Issue は無い');
  });

  describe('NO-GO', () => {
    it('develop HEAD CI is red', () => {
      const decision = decideReadiness(facts({ developCi: 'failure' }));
      expect(decision.verdict).toBe('no-go');
      expect(decision.reasons).toContain('develop HEAD の CI が赤');
      expect(decision.nextSteps.join('\n')).not.toContain('/release');
    });

    it.each(['failure', 'pending', 'none', 'unknown'] as const)('a PR merged today has checks %s', (checks) => {
      const decision = decideReadiness(
        facts({ mergedToday: [{ number: 3070, title: 'x', url: '', checks }] })
      );
      expect(decision.verdict).toBe('no-go');
      expect(decision.reasons[0]).toContain('#3070');
    });

    it('npm audit high+ increased since the last release', () => {
      const decision = decideReadiness(facts({ audit: { current: 3, atLastRelease: 1 } }));
      expect(decision.verdict).toBe('no-go');
      expect(decision.reasons[0]).toContain('1 → 3');
    });

    it('a dispatched bug fix still reproduces the agent-health fail', () => {
      const decision = decideReadiness(
        facts({ dispatched: [row({ agentHealthKey: 'agent-health:codex:screen-idle', reproducedFail: true })] })
      );
      expect(decision.verdict).toBe('no-go');
      expect(decision.reasons[0]).toContain('agent-health:codex:screen-idle');
    });

    it('NO-GO wins over 要判断 and keeps both reasons', () => {
      const decision = decideReadiness(facts({ developCi: 'failure', deferred: [3052] }));
      expect(decision.verdict).toBe('no-go');
      expect(decision.reasons).toHaveLength(2);
    });
  });

  describe('要判断', () => {
    it('a dispatched Issue has no PR', () => {
      const decision = decideReadiness(facts({ dispatched: [row({ pr: null, merged: false, commit: null })] }));
      expect(decision.verdict).toBe('hold');
      expect(decision.reasons[0]).toContain('#3050（PR 未作成）');
    });

    it('says "PR を確認できず" when the PR list could not be read', () => {
      const decision = decideReadiness(
        facts({ prLookupOk: false, mergedToday: [], dispatched: [row({ pr: null, merged: false })] })
      );
      expect(decision.reasons.join('\n')).toContain('PR を確認できず');
    });

    it('a dispatched Issue is not merged', () => {
      const decision = decideReadiness(
        facts({ dispatched: [row({ merged: false, pr: { number: 3060, url: '', state: 'OPEN' } })] })
      );
      expect(decision.verdict).toBe('hold');
      expect(decision.reasons[0]).toContain('未マージ');
    });

    it('verify failed', () => {
      const decision = decideReadiness(facts({ dispatched: [row({ verifyExit: 20 })] }));
      expect(decision.verdict).toBe('hold');
      expect(decision.reasons[0]).toContain('verify 不合格 exit 20');
    });

    it('there is a carry-over', () => {
      const decision = decideReadiness(facts({ deferred: [3052, 3053] }));
      expect(decision.verdict).toBe('hold');
      expect(decision.reasons[0]).toContain('#3052, #3053');
    });

    it.each(['pending', 'unknown'] as const)('develop HEAD CI is %s', (developCi) => {
      expect(decideReadiness(facts({ developCi })).verdict).toBe('hold');
    });

    it('the merged-PR list could not be read', () => {
      expect(decideReadiness(facts({ mergedToday: null })).verdict).toBe('hold');
    });

    it('offers /release after the judgement', () => {
      const decision = decideReadiness(facts({ deferred: [1] }));
      expect(decision.nextSteps[decision.nextSteps.length - 1]).toContain('/release');
    });
  });

  it('notes, but does not act on, missing audit baselines and unverified fixes', () => {
    const decision = decideReadiness(
      facts({
        audit: { current: 2, atLastRelease: null },
        dispatched: [row({ agentHealthKey: 'agent-health:claude:version', reproducedFail: null })],
      })
    );
    expect(decision.verdict).toBe('go');
    expect(decision.notes.join('\n')).toContain('前回リリース時の値が無い');
    expect(decision.notes.join('\n')).toContain('#3050');
  });

  it('an unverified verify (no log) does not block', () => {
    expect(decideReadiness(facts({ dispatched: [row({ verifyExit: null })] })).verdict).toBe('go');
  });
});

describe('CI state readers', () => {
  it('summarizeWorkflowRuns keeps the newest run per workflow', () => {
    expect(summarizeWorkflowRuns(null)).toBe('unknown');
    expect(summarizeWorkflowRuns([])).toBe('none');
    expect(
      summarizeWorkflowRuns([
        { workflowName: 'CI', status: 'completed', conclusion: 'failure', createdAt: '2026-10-01T00:00:00Z' },
        { workflowName: 'CI', status: 'completed', conclusion: 'success', createdAt: '2026-10-01T01:00:00Z' },
      ])
    ).toBe('success');
    expect(
      summarizeWorkflowRuns([
        { workflowName: 'CI', status: 'in_progress', conclusion: null },
        { workflowName: 'Other', status: 'completed', conclusion: 'skipped' },
      ])
    ).toBe('pending');
    expect(summarizeWorkflowRuns([{ workflowName: 'CI', status: 'completed', conclusion: 'cancelled' }])).toBe(
      'failure'
    );
  });

  it('summarizeCheckRollup ignores superseded runs of the same check', () => {
    expect(summarizeCheckRollup(null)).toBe('unknown');
    expect(summarizeCheckRollup([])).toBe('none');
    expect(
      summarizeCheckRollup([
        { __typename: 'CheckRun', name: 'Unit', workflowName: 'CI', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: '2026-10-01T00:00:00Z' },
        { __typename: 'CheckRun', name: 'Unit', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-01T01:00:00Z' },
        { __typename: 'StatusContext', context: 'vercel', state: 'SUCCESS' },
      ])
    ).toBe('success');
    expect(summarizeCheckRollup([{ context: 'x', state: 'FAILURE' }])).toBe('failure');
    expect(summarizeCheckRollup([{ name: 'Lint', status: 'QUEUED', conclusion: '' }])).toBe('pending');
  });
});

describe('pull requests', () => {
  it('parsePullRequests reads gh rows and drops junk', () => {
    const prs = parsePullRequests([
      {
        number: 5,
        title: 'feat: x (#3050)',
        url: 'u',
        state: 'MERGED',
        headRefName: 'feature/3050-x',
        baseRefName: 'develop',
        mergedAt: '2026-10-01T03:00:00Z',
        mergeCommit: { oid: 'abc' },
        headRefOid: 'def',
        body: '',
        statusCheckRollup: [],
      },
      { title: 'no number' },
      null,
    ]);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 5, state: 'MERGED', mergeCommit: 'abc', checks: 'none' });
    expect(parsePullRequests({})).toEqual([]);
  });

  it('mergedOnDate uses the JST day and only develop', () => {
    const prs = [
      pr({ number: 1, state: 'MERGED', mergedAt: '2026-09-30T15:30:00Z' }), // 10-01 00:30 JST
      pr({ number: 2, state: 'MERGED', mergedAt: '2026-09-30T14:30:00Z' }), // 09-30 JST
      pr({ number: 3, state: 'MERGED', mergedAt: '2026-10-01T01:00:00Z', baseRefName: 'main' }),
      pr({ number: 4, state: 'OPEN' }),
    ];
    expect(mergedOnDate(prs, '2026-10-01').map((p) => p.number)).toEqual([1]);
  });

  it('findPullRequestForIssue matches branch, title or Closes, preferring merged', () => {
    const prs = [
      pr({ number: 10, headRefName: 'fix/3050-a', state: 'CLOSED' }),
      pr({ number: 11, title: 'fix: a (#3050)', state: 'MERGED' }),
      pr({ number: 12, body: 'Closes #3050', state: 'OPEN' }),
      pr({ number: 13, body: 'Closes #30500' }),
      pr({ number: 14, baseRefName: 'main', title: 'release (#3050)', state: 'MERGED' }),
    ];
    expect(findPullRequestForIssue(prs, 3050)?.number).toBe(11);
    expect(findPullRequestForIssue(prs.slice(2), 3050)?.number).toBe(12);
    expect(findPullRequestForIssue(prs.slice(3), 3050)).toBeNull();
  });
});

describe('orchestrate run files', () => {
  it('parseTasksTsv keeps CommandMate worktrees only', () => {
    const tasks = parseTasksTsv(
      '3044\tcommandmate-issue-3044\tclaude\tid\topus\n3002\tcommandmate-skills-cm3002\tclaude\tid\topus\nbad line\n'
    );
    expect([...tasks.entries()]).toEqual([[3044, { worktree: 'commandmate-issue-3044', agent: 'claude', model: 'opus' }]]);
  });

  it('pickWaitLog takes the last attempt and skips the skills repo', () => {
    const names = [
      'wait-3038.log',
      'wait-3038-r2.log',
      'wait-batch3-3039-274-275-commandmate-issue-3039.log',
      'wait-skills-286-288-286.log',
      'wait-30380.log',
    ];
    expect(pickWaitLog(names, 3038)).toBe('wait-3038-r2.log');
    expect(pickWaitLog(names, 3039)).toBe('wait-batch3-3039-274-275-commandmate-issue-3039.log');
    expect(pickWaitLog(names, 286)).toBeNull();
    expect(pickWaitLog(names, 1)).toBeNull();
  });

  it('parseVerifyExit', () => {
    expect(parseVerifyExit('Waiting: x\n')).toBeNull();
    expect(parseVerifyExit('GATE lint PASS\nRESULT passed\n')).toBe(0);
    expect(parseVerifyExit('GATE env-clean FAIL\nRESULT failed\n')).toBe(20);
    expect(parseVerifyExit('GATE work-evidence FAIL (commits=0)\nRESULT failed\n')).toBe(21);
    expect(parseVerifyExit('RESULT passed\nexit=0\nRESULT failed\nexit=20\n')).toBe(20);
  });
});

describe('agent-health reproduction', () => {
  it('extractAgentHealthKey skips batch and script identifiers', () => {
    expect(extractAgentHealthKey('id: agent-health:batch:2026-10-01, agent-health:codex:screen-idle')).toEqual({
      tool: 'codex',
      checkId: 'screen-idle',
    });
    expect(extractAgentHealthKey('agent-health:script:run')).toBeNull();
  });

  const report = (name: string, completedAt: string, status: string) =>
    parseHealthReportDigest(
      name,
      JSON.stringify({ completedAt, tools: [{ tool: 'codex', checks: [{ checkId: 'screen-idle', status }] }] })
    )!;
  const key = { tool: 'codex', checkId: 'screen-idle' };

  it('uses the newest report completed after the merge', () => {
    const reports = [
      report('a', '2026-10-01T00:00:00Z', 'fail'), // before the merge
      report('b', '2026-10-02T00:00:00Z', 'fail'),
      report('c', '2026-10-02T01:00:00Z', 'pass'),
    ];
    expect(reproducesFailAfter(reports, key, '2026-10-01T03:00:00Z')).toBe(false);
    expect(reproducesFailAfter(reports.slice(0, 2), key, '2026-10-01T03:00:00Z')).toBe(true);
    expect(reproducesFailAfter(reports.slice(0, 1), key, '2026-10-01T03:00:00Z')).toBeNull();
    expect(reproducesFailAfter([report('d', '2026-10-02T00:00:00Z', 'skip')], key, '2026-10-01T03:00:00Z')).toBeNull();
  });

  it('parseHealthReportDigest rejects non-reports', () => {
    expect(parseHealthReportDigest('x', '{')).toBeNull();
    expect(parseHealthReportDigest('x', '{}')).toBeNull();
  });
});

describe('metrics', () => {
  const file = (metrics: unknown[]) => JSON.stringify({ schemaVersion: 1, startedAt: '', completedAt: '', metrics });

  it('parseMetricsFile tolerates junk', () => {
    expect(parseMetricsFile(null)).toBeNull();
    expect(parseMetricsFile('{')).toBeNull();
    expect(parseMetricsFile(JSON.stringify({ schemaVersion: 2, metrics: [] }))).toBeNull();
    expect(
      parseMetricsFile(file([{ metricId: 'npm-audit', category: 'security', status: 'fail', value: 2, summary: 's', candidates: [] }, { x: 1 }]))
    ).toEqual([{ metricId: 'npm-audit', category: 'security', status: 'fail', value: 2, summary: 's' }]);
  });

  it('compareMetrics pairs values; skip counts as unknown', () => {
    const today = parseMetricsFile(file([{ metricId: 'file-size', category: 'maintainability', status: 'fail', value: 5, summary: '' }]))!;
    const prev = parseMetricsFile(file([{ metricId: 'file-size', category: 'maintainability', status: 'fail', value: 4, summary: '' }]))!;
    const rel = parseMetricsFile(file([{ metricId: 'file-size', category: 'maintainability', status: 'skip', value: 1, summary: '' }]))!;
    expect(compareMetrics(today, prev, rel)[0]).toMatchObject({ value: 5, previousDay: 4, atLastRelease: null });
    expect(compareMetrics(today, null, null)[0]).toMatchObject({ previousDay: null, atLastRelease: null });
  });

  it('formatDelta', () => {
    expect(formatDelta(5, 3)).toBe('+2');
    expect(formatDelta(3, 5)).toBe('-2');
    expect(formatDelta(3, 3)).toBe('±0');
    expect(formatDelta(null, 3)).toBe('');
  });

  it('countHighAdvisories counts unique high/critical advisories', () => {
    expect(countHighAdvisories(null)).toBeNull();
    expect(countHighAdvisories({})).toBeNull();
    expect(
      countHighAdvisories({
        vulnerabilities: {
          a: { via: [{ source: 1, severity: 'high' }, { source: 2, severity: 'moderate' }] },
          b: { via: [{ source: 1, severity: 'high' }, { source: 3, severity: 'critical' }, 'a'] },
        },
      })
    ).toBe(2);
  });
});

describe('dates', () => {
  it('jstDateOf', () => {
    expect(jstDateOf('2026-09-30T15:00:00Z')).toBe('2026-10-01');
    expect(jstDateOf('2026-09-30T22:58:02+09:00')).toBe('2026-09-30');
    expect(jstDateOf(null)).toBeNull();
    expect(jstDateOf('nope')).toBeNull();
  });

  it('latestDateBefore', () => {
    const dates = ['2026-09-28', '2026-09-30', '2026-10-01', 'junk'];
    expect(latestDateBefore(dates, '2026-10-01', false)).toBe('2026-09-30');
    expect(latestDateBefore(dates, '2026-10-01', true)).toBe('2026-10-01');
    expect(latestDateBefore(dates, '2026-09-29', true)).toBe('2026-09-28');
    expect(latestDateBefore(dates, '2026-09-01', true)).toBeNull();
  });
});

describe('parseReleaseReportArgs', () => {
  it('defaults', () => {
    expect(parseReleaseReportArgs([], '2026-10-01')).toEqual({
      ok: true,
      options: {
        date: '2026-10-01',
        out: null,
        stateDir: null,
        runsDir: null,
        findings: null,
        repo: 'Kewton/CommandMate',
        gh: true,
        audit: true,
      },
    });
  });

  it('reads every flag, both spellings', () => {
    const result = parseReleaseReportArgs(
      ['--date', '2026-09-30', '--out=/o.html', '--state-dir', '/s', '--runs-dir', '/r', '--findings', '/f.md', '--repo', 'a/b', '--no-gh', '--no-audit'],
      '2026-10-01'
    );
    expect(result).toEqual({
      ok: true,
      options: { date: '2026-09-30', out: '/o.html', stateDir: '/s', runsDir: '/r', findings: '/f.md', repo: 'a/b', gh: false, audit: false },
    });
  });

  it('rejects bad input', () => {
    expect(parseReleaseReportArgs(['--date', '2026-02-30'], 'x').ok).toBe(false);
    expect(parseReleaseReportArgs(['--date'], 'x').ok).toBe(false);
    expect(parseReleaseReportArgs(['--repo', 'nope'], 'x').ok).toBe(false);
    expect(parseReleaseReportArgs(['--bogus'], 'x').ok).toBe(false);
    expect(parseReleaseReportArgs(['--help'], 'x')).toMatchObject({ ok: false, help: true });
  });
});
