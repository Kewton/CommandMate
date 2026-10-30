/**
 * Issue #3994 (#3988 / #3989 / #3990): command-code's daily checks on turns
 * the model provider refused (`⚠ Error: Authentication failed.` and
 * `401 … Invalid 'Authorization'`, 2026-10-29).
 *
 * Positive control: the frames the daily run failed on become a `signed-out`
 * skip, and so does `hook-correlation` when `session_start` arrived and only
 * `stop` is missing. Negative control: the same checks still fail when the
 * refusal rows are removed, when they were already on the pane before the
 * request, when `session_start` is missing too, and for a tool without the
 * rows in its spec.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import type { HookDelivery } from '@/lib/agent-health/hook-correlation';
import {
  COMMAND_CODE_MODEL_AUTH_FAILURE_ROWS,
  countModelAuthFailures,
  judgeHookCorrelation,
  judgeTurnCheck,
  judgeTurnScreen,
  OPENCODE_MODEL_AUTH_FAILURE_ROWS,
} from '@/lib/agent-health/model-auth';
import type { ScreenVerdict } from '@/lib/agent-health/screen-checks';
import type { AgentHealthCheck } from '@/lib/agent-health/types';
import { TOOL_PROBE_SPECS } from '../../../../scripts/agent-health/tool-table';

const DIR = fileURLToPath(new URL('../../../fixtures/command-code-agent-health-3994/', import.meta.url));
const read = (name: string) => readFileSync(`${DIR}${name}.txt`, 'utf8');

const RUNNING = read('auth-failed-running-turn');
const APPROVAL = read('auth-failed-approval-turn');
const ROWS = COMMAND_CODE_MODEL_AUTH_FAILURE_ROWS;

/** The idle frame before the first request: no refusal on it. */
const IDLE = '';

/** The frame with every refusal row (both wordings) replaced by a plain reply. */
function withoutRefusal(frame: string): string {
  return frame
    .split('\n')
    .map((line) => (/Authentication failed|Invalid 'Authorization'/.test(line) ? '● Done.' : line))
    .join('\n');
}

function verdictOf(frame: string): ScreenVerdict {
  const result = detectSessionStatus(frame, 'command-code');
  return {
    status: result.status,
    reason: result.reason,
    hasActivePrompt: result.hasActivePrompt,
    evidence: result.evidence,
  };
}

/** The probe's fail when the approval dialog never appeared (scripts/agent-health/probe-tool.ts). */
function approvalNotShown(frame: string): AgentHealthCheck {
  return {
    checkId: 'screen-approval',
    status: 'fail',
    summary: '期待: 「Run the shell command: touch agent-health-probe.txt」で承認ダイアログ（Command Code needs to execute）が出る。実際: 60 秒以内に出なかった',
    evidence: frame,
  };
}

describe('[#3994] command-code refusal rows', () => {
  it('are in command-code’s probe spec; opencode keeps its own', () => {
    expect(TOOL_PROBE_SPECS['command-code'].modelAuthFailureRows).toBe(COMMAND_CODE_MODEL_AUTH_FAILURE_ROWS);
    expect(TOOL_PROBE_SPECS.opencode.modelAuthFailureRows).toBe(OPENCODE_MODEL_AUTH_FAILURE_ROWS);
    expect(TOOL_PROBE_SPECS['opencode-v2'].modelAuthFailureRows).toBe(OPENCODE_MODEL_AUTH_FAILURE_ROWS);
  });

  it('count both wordings on each refused turn', () => {
    expect(countModelAuthFailures(RUNNING, ROWS)).toBe(2);
    expect(countModelAuthFailures(APPROVAL, ROWS)).toBe(4);
  });

  it('are not opencode’s row, and opencode’s row is not theirs', () => {
    expect(countModelAuthFailures(RUNNING)).toBe(0);
    expect(countModelAuthFailures('Error: Unauthorized\n', ROWS)).toBe(0);
  });

  it('are not counted in the request echo or without the tool’s ⚠ mark', () => {
    expect(countModelAuthFailures('❯ ⚠ Error: Authentication failed. Run "cmd login"\n', ROWS)).toBe(0);
    expect(countModelAuthFailures('  Error: Authentication failed. quoted\n', ROWS)).toBe(0);
    expect(countModelAuthFailures("❯ 401 error: Invalid 'Authorization' header\n", ROWS)).toBe(0);
  });
});

describe('[#3989] screen-running on the refused turn', () => {
  it('is the verdict the daily run failed on', () => {
    expect(verdictOf(RUNNING)).toMatchObject({ status: 'ready', reason: 'input_prompt' });
  });

  it('is a signed-out skip naming the refusal row, with the would-be fail kept', () => {
    const check = judgeTurnScreen('screen-running', verdictOf(RUNNING), RUNNING, IDLE, { rows: ROWS });
    expect(check).toMatchObject({ checkId: 'screen-running', status: 'skip', skipKind: 'signed-out' });
    expect(check.summary).toMatch(/Authentication failed|Invalid 'Authorization'/);
    expect(check.skipReason).toContain('期待: 実行中（running、evidence=positive）');
  });

  it('still fails with the refusal rows removed', () => {
    const edited = withoutRefusal(RUNNING);
    expect(judgeTurnScreen('screen-running', verdictOf(edited), edited, IDLE, { rows: ROWS }).status).toBe('fail');
  });

  it('still fails when the refusal was already on the pane before the request', () => {
    expect(judgeTurnScreen('screen-running', verdictOf(RUNNING), RUNNING, RUNNING, { rows: ROWS }).status).toBe('fail');
  });

  it('still fails for a tool without the rows in its spec', () => {
    expect(judgeTurnScreen('screen-running', verdictOf(RUNNING), RUNNING, IDLE, { rows: [] }).status).toBe('fail');
  });

  it('a check that holds still passes on a refused turn', () => {
    const passing: ScreenVerdict = { status: 'running', reason: 'x', hasActivePrompt: false, evidence: 'positive' };
    expect(judgeTurnScreen('screen-running', passing, RUNNING, IDLE, { rows: ROWS }).status).toBe('pass');
  });
});

describe('[#3990] screen-approval when the dialog never appeared', () => {
  it('is a signed-out skip when the approval turn ended in the refusal (after the refused running turn)', () => {
    const check = judgeTurnCheck(approvalNotShown(APPROVAL), APPROVAL, RUNNING, ROWS);
    expect(check).toMatchObject({ checkId: 'screen-approval', status: 'skip', skipKind: 'signed-out' });
    expect(check.skipReason).toContain('60 秒以内に出なかった');
    expect(check.evidence).toBe(APPROVAL);
  });

  it('still fails with the refusal rows removed', () => {
    const edited = withoutRefusal(APPROVAL);
    expect(judgeTurnCheck(approvalNotShown(edited), edited, IDLE, ROWS).status).toBe('fail');
  });

  it('still fails when only the earlier (running) turn was refused', () => {
    const lastTurn = APPROVAL.indexOf('❯ Run the shell command: touch');
    const replied = `${APPROVAL.slice(0, lastTurn)}${withoutRefusal(APPROVAL.slice(lastTurn))}`;
    expect(countModelAuthFailures(replied, ROWS)).toBe(2);
    expect(judgeTurnCheck(approvalNotShown(replied), replied, RUNNING, ROWS).status).toBe('fail');
  });

  it('still fails when the refusal was already on the pane before the request', () => {
    expect(judgeTurnCheck(approvalNotShown(APPROVAL), APPROVAL, APPROVAL, ROWS).status).toBe('fail');
  });

  it('a pass is returned unchanged', () => {
    const pass: AgentHealthCheck = { checkId: 'screen-approval', status: 'pass', summary: 'ok' };
    expect(judgeTurnCheck(pass, APPROVAL, RUNNING, ROWS)).toBe(pass);
  });

  it('the dialog that did appear goes through the same judgement (screen)', () => {
    const atDialog = verdictOf(APPROVAL);
    expect(judgeTurnScreen('screen-approval', atDialog, APPROVAL, RUNNING, { rows: ROWS }).status).toBe('skip');
  });
});

const EXPECT = {
  tool: 'command-code',
  worktreeId: 'agent-health-probe',
  instanceId: 'command-code-probe',
  expectedEvents: ['session_start', 'stop'],
};

function delivery(event: string, overrides: Partial<HookDelivery> = {}): HookDelivery {
  return {
    kind: 'agent-event',
    tool: 'command-code',
    event,
    worktreeId: 'agent-health-probe',
    instanceId: 'command-code-probe',
    receivedAt: Date.UTC(2026, 9, 28, 22, 3, 47, 831),
    ...overrides,
  };
}

describe('[#3988] hooks hook-correlation on refused turns', () => {
  it('is a signed-out skip when session_start arrived and only stop is missing (the daily run’s delivery)', () => {
    const check = judgeHookCorrelation([delivery('session_start')], EXPECT, { unauthorizedFrame: RUNNING, rows: ROWS });
    expect(check).toMatchObject({ checkId: 'hook-correlation', status: 'skip', skipKind: 'signed-out' });
    expect(check.skipReason).toContain('stop が未着');
    expect(check.evidence).toContain('Error: Authentication failed.');
  });

  it('still fails when session_start is missing too', () => {
    expect(judgeHookCorrelation([], EXPECT, { unauthorizedFrame: RUNNING, rows: ROWS }).status).toBe('fail');
  });

  it('still fails when no turn ended in the refusal', () => {
    expect(judgeHookCorrelation([delivery('session_start')], EXPECT, { unauthorizedFrame: null, rows: ROWS }).status).toBe(
      'fail'
    );
  });

  it('still fails when a hook arrived with another instance', () => {
    const deliveries = [delivery('session_start'), delivery('stop', { instanceId: 'someone-else' })];
    expect(judgeHookCorrelation(deliveries, EXPECT, { unauthorizedFrame: RUNNING, rows: ROWS }).status).toBe('fail');
  });

  it('still fails when another expected event is missing besides stop', () => {
    const expectation = { ...EXPECT, expectedEvents: ['session_start', 'user_prompt_submit', 'stop'] };
    expect(
      judgeHookCorrelation([delivery('session_start')], expectation, { unauthorizedFrame: RUNNING, rows: ROWS }).status
    ).toBe('fail');
  });

  it('still passes when stop arrived', () => {
    const deliveries = [delivery('session_start'), delivery('stop')];
    expect(judgeHookCorrelation(deliveries, EXPECT, { unauthorizedFrame: RUNNING, rows: ROWS }).status).toBe('pass');
  });
});
