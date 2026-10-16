/**
 * Issue #3729: command-code's daily checks on an account that hit its weekly
 * usage limit (2026-10-16, #3717 / #3718 / #3719).
 *
 * Positive control: the evidence panes the daily run failed on (and the
 * `stop`-missing hook check of the same session) become a `usage-limit` skip,
 * counted in `skipByKind`. Negative control: the same fail with no limit on
 * the pane still fails, a pass stays a pass, and the healthy banners that
 * mention "usage limit" (claude's promo, codex's reset footer) are not a limit.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { buildCoverage, coverageHeadline, summarizeCoverage } from '@/lib/agent-health/coverage';
import { evaluateScreen, type ScreenCheckId, type ScreenVerdict } from '@/lib/agent-health/screen-checks';
import {
  AGENT_HEALTH_SKIP_KIND_LABELS,
  AGENT_HEALTH_SKIP_KINDS,
  type AgentHealthCheck,
  type AgentHealthToolResult,
} from '@/lib/agent-health/types';
import { findUsageLimit, judgeUsageLimit, USAGE_LIMIT_SIGNATURES } from '@/lib/agent-health/usage-limit';

const DIR = fileURLToPath(new URL('../../../fixtures/agent-health-usage-limit-3729/', import.meta.url));
const CODEX_1628 = fileURLToPath(new URL('../../lib/detection/fixtures/codex-live-1628/', import.meta.url));
const read = (dir: string, name: string) => readFileSync(`${dir}${name}`, 'utf8');

const RUNNING = read(DIR, 'running-turn.txt');
const APPROVAL = read(DIR, 'approval-turn.txt');
const NO_LIMIT = read(DIR, 'running-turn-no-limit.txt');

function verdictOf(frame: string): ScreenVerdict {
  const result = detectSessionStatus(frame, 'command-code');
  return { status: result.status, reason: result.reason, hasActivePrompt: result.hasActivePrompt, evidence: result.evidence };
}

function screen(checkId: ScreenCheckId, frame: string): AgentHealthCheck {
  return judgeUsageLimit({ checkId, ...evaluateScreen(checkId, verdictOf(frame), frame) }, [frame]);
}

/** #3719's fail: the dialog never appeared (probe-tool.ts approvalTurn). */
function approvalNotShown(frame: string): AgentHealthCheck {
  return judgeUsageLimit(
    {
      checkId: 'screen-approval',
      status: 'fail',
      summary: '期待: 「Run the shell command: touch agent-health-probe.txt」で承認ダイアログ（Command Code needs to execute）が出る。実際: 60 秒以内に出なかった',
      evidence: frame,
    },
    [frame]
  );
}

/** #3717's fail: session_start arrived, stop did not. */
const HOOK_FAIL: AgentHealthCheck = {
  checkId: 'hook-correlation',
  status: 'fail',
  summary: '期待: session_start / stop が worktreeId=agent-health-probe・instanceId=command-code-probe で届く。実際: stop が未着（受信 1 件）',
  evidence: '{"kind":"agent-event","tool":"command-code","event":"session_start"}',
};

describe('[#3729] the skip kind', () => {
  it('is a kind of its own, with a label that says usage limit', () => {
    expect(AGENT_HEALTH_SKIP_KINDS).toContain('usage-limit');
    expect(AGENT_HEALTH_SKIP_KIND_LABELS['usage-limit']).toContain('利用上限');
  });
});

describe('[#3729] finding the limit on a pane', () => {
  it('finds command-code\'s wording on both evidence panes', () => {
    expect(findUsageLimit(RUNNING)?.signature.id).toBe('command-code-reached');
    expect(findUsageLimit(RUNNING)?.line).toContain("You've reached your weekly usage limit. Resets in 1d 17h");
    expect(findUsageLimit(APPROVAL)?.signature.id).toBe('command-code-reached');
  });

  it('finds the 429 row alone, through ANSI colour', () => {
    const row = '⚠ taste learning failed: POST /alpha/generate → \u001b[31m429\u001b[0m error: You hit the usage limit for your plan.';
    expect(findUsageLimit(row)?.signature.id).toBe('http-429-usage-limit');
  });

  it('is a table other tools can be added to (claude / codex wording)', () => {
    expect(USAGE_LIMIT_SIGNATURES.map((entry) => entry.tool)).toEqual(expect.arrayContaining(['command-code', 'claude']));
    expect(findUsageLimit('Claude usage limit reached. Your limit will reset at 3pm.')?.signature.id).toBe('claude-limit-reached');
    expect(findUsageLimit("■ You've hit your usage limit. Upgrade to Pro or try again in 2 days.")?.signature.id).toBe(
      'hit-your-limit'
    );
  });

  it('does not take healthy banners or a bare 429 for the limit', () => {
    expect(findUsageLimit(NO_LIMIT)).toBeNull();
    expect(findUsageLimit('Claude Code can use up to 50% of your weekly usage limit on Fable 5 before falling back.')).toBeNull();
    expect(findUsageLimit(read(CODEX_1628, 'working.txt'))).toBeNull();
    expect(findUsageLimit('API Error: 429 Too Many Requests')).toBeNull();
    expect(findUsageLimit('Resets in 1d 17h')).toBeNull();
  });
});

describe('[#3718] screen-running on the limited turn', () => {
  it('is the verdict the daily run failed on', () => {
    expect(evaluateScreen('screen-running', verdictOf(RUNNING), RUNNING).status).toBe('fail');
  });

  it('is a usage-limit skip whose reason names the limit and keeps the would-be fail', () => {
    const check = screen('screen-running', RUNNING);
    expect(check).toMatchObject({ checkId: 'screen-running', status: 'skip', skipKind: 'usage-limit' });
    expect(check.summary).toContain('利用上限');
    expect(check.skipReason).toContain('利用上限');
    expect(check.skipReason).toContain('weekly usage limit');
    expect(check.skipReason).toContain('判定していれば: 期待: 実行中');
    expect(check.evidence).toContain('weekly usage limit');
  });

  it('still fails when the pane shows no limit (negative control)', () => {
    expect(screen('screen-running', NO_LIMIT)).toMatchObject({ status: 'fail' });
    expect(screen('screen-running', NO_LIMIT).skipKind).toBeUndefined();
  });
});

describe('[#3719] screen-approval whose dialog never appeared', () => {
  it('is a usage-limit skip on the limited pane', () => {
    expect(approvalNotShown(APPROVAL)).toMatchObject({ checkId: 'screen-approval', status: 'skip', skipKind: 'usage-limit' });
  });

  it('still fails when the pane shows no limit (negative control)', () => {
    expect(approvalNotShown(NO_LIMIT)).toMatchObject({ status: 'fail', evidence: NO_LIMIT });
  });
});

describe('[#3717] hook-correlation of a limited session', () => {
  it('is a usage-limit skip, with the limited pane as evidence', () => {
    const check = judgeUsageLimit(HOOK_FAIL, [RUNNING]);
    expect(check).toMatchObject({ checkId: 'hook-correlation', status: 'skip', skipKind: 'usage-limit' });
    expect(check.skipReason).toContain('stop が未着');
    expect(check.evidence).toContain('weekly usage limit');
  });

  it('still fails when no frame of the session showed the limit (negative control)', () => {
    expect(judgeUsageLimit(HOOK_FAIL, [])).toBe(HOOK_FAIL);
    expect(judgeUsageLimit(HOOK_FAIL, [NO_LIMIT])).toBe(HOOK_FAIL);
  });
});

describe('[#3729] what is left alone', () => {
  it('keeps a pass a pass, even on a limited pane', () => {
    const pass: AgentHealthCheck = { checkId: 'screen-quoted-dialog', status: 'pass', summary: 'ok' };
    expect(judgeUsageLimit(pass, [RUNNING])).toBe(pass);
  });

  it('keeps an existing skip as it was', () => {
    const skip: AgentHealthCheck = { checkId: 'screen-approval', status: 'skip', summary: 's', skipKind: 'not-shown' };
    expect(judgeUsageLimit(skip, [RUNNING])).toBe(skip);
  });
});

describe('[#3729] the report counts the skips', () => {
  it('puts them in skipByKind, the headline and the reasons', () => {
    const checks: AgentHealthCheck[] = [
      { checkId: 'version', status: 'pass', summary: 'commandcode --version → 1.81.0' },
      judgeUsageLimit(HOOK_FAIL, [RUNNING]),
      { checkId: 'screen-idle', status: 'pass', summary: 'ok' },
      screen('screen-running', RUNNING),
      approvalNotShown(APPROVAL),
    ];
    const results: AgentHealthToolResult[] = [
      { tool: 'command-code', version: '1.81.0', previousVersion: '1.81.0', versionChanged: false, checks },
    ];
    const coverage = buildCoverage({
      results,
      selectedTools: ['command-code'],
      selectedChecks: ['version', 'hook-correlation', 'screen-idle', 'screen-running', 'screen-approval'],
    });
    expect(coverage.counts.skipByKind['usage-limit']).toBe(3);
    expect(coverage.counts.fail).toBe(0);
    expect(coverageHeadline(coverage.counts)).toContain('利用上限に達している 3');
    const lines = summarizeCoverage(coverage, results);
    expect(lines.some((line) => line.startsWith('- command-code hook-correlation') && line.includes('利用上限'))).toBe(true);
  });
});
