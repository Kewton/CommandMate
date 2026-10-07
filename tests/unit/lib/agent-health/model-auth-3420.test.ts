/**
 * Issues #3420 / #3421 / #3422: opencode-v2's daily checks on a turn the model
 * provider refused (`Error: Unauthorized`, 2026-10-08).
 *
 * Positive control: the frames and SSE types the daily run failed on become a
 * `signed-out` skip. Negative control: the same checks still fail when the
 * turn did not end in that refusal (another model error, a refusal already on
 * the pane before the request, a refusal quoted inside the request box, an SSE
 * failure the server did not report as a failed execution).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import {
  countModelAuthFailures,
  judgeServerEvents,
  judgeTurnScreen,
  turnEndedUnauthorized,
} from '@/lib/agent-health/model-auth';
import type { ScreenCheckId, ScreenVerdict } from '@/lib/agent-health/screen-checks';
import type { ReceivedServerEvent } from '@/lib/agent-health/server-events';

const DIR_3420 = fileURLToPath(new URL('../../../fixtures/opencode-agent-health-3420/', import.meta.url));
const DIR_3021 = fileURLToPath(new URL('../../../fixtures/opencode-agent-health-3021/', import.meta.url));

const read = (dir: string, name: string) => readFileSync(`${dir}${name}.txt`, 'utf8');

function verdictOf(frame: string, cliToolId: 'opencode' | 'opencode-v2'): ScreenVerdict {
  const result = detectSessionStatus(frame, cliToolId);
  return {
    status: result.status,
    reason: result.reason,
    hasActivePrompt: result.hasActivePrompt,
    evidence: result.evidence,
  };
}

function judge(checkId: ScreenCheckId, frame: string, before: string, cliToolId: 'opencode' | 'opencode-v2' = 'opencode-v2') {
  return judgeTurnScreen(checkId, verdictOf(frame, cliToolId), frame, before);
}

/** The idle frame before the first request: no refusal on it. */
const IDLE = '';

describe('[#3420] the refusal row', () => {
  it('is counted on the raw captures (SGR kept) and on the report evidence', () => {
    expect(read(DIR_3420, 'unauthorized-running-turn')).toContain('\u001b[');
    expect(countModelAuthFailures(read(DIR_3420, 'unauthorized-running-turn'))).toBe(1);
    expect(countModelAuthFailures(read(DIR_3420, 'unauthorized-quoted-turn'))).toBe(1);
    expect(countModelAuthFailures(read(DIR_3420, 'unauthorized-quoted-after-running-turn'))).toBe(2);
  });

  it('is not counted inside the request box or on #3021 model-error frames', () => {
    expect(countModelAuthFailures('  ┃  Error: Unauthorized\n')).toBe(0);
    expect(countModelAuthFailures('     Error: Unauthorized token\n')).toBe(0);
    expect(countModelAuthFailures(read(DIR_3021, 'model-error-running-turn'))).toBe(0);
    expect(countModelAuthFailures(read(DIR_3021, 'model-error-quoted-turn'))).toBe(0);
  });

  it('must be new in the turn', () => {
    const one = read(DIR_3420, 'unauthorized-running-turn');
    expect(turnEndedUnauthorized(IDLE, one)).toBe(true);
    expect(turnEndedUnauthorized(one, one)).toBe(false);
  });
});

describe('[#3421] screen-running on the refused turn', () => {
  const frame = read(DIR_3420, 'unauthorized-running-turn');

  it('is the verdict the daily run failed on', () => {
    expect(verdictOf(frame, 'opencode-v2')).toMatchObject({ status: 'ready', reason: 'opencode_response_complete' });
  });

  it('is a signed-out skip, with the would-be fail kept in the reason and the pane as evidence', () => {
    const check = judge('screen-running', frame, IDLE);
    expect(check).toMatchObject({ checkId: 'screen-running', status: 'skip', skipKind: 'signed-out' });
    expect(check.summary).toContain('Error: Unauthorized');
    expect(check.skipReason).toContain('期待: 実行中（running、evidence=positive）');
    expect(check.evidence).toContain('Error: Unauthorized');
  });

  it('still fails when the refusal was already on the pane before the request', () => {
    expect(judge('screen-running', frame, frame).status).toBe('fail');
  });

  it('still fails on another model error (#3021 "No models loaded")', () => {
    const other = read(DIR_3021, 'model-error-running-turn');
    expect(judge('screen-running', other, IDLE, 'opencode').status).toBe('fail');
  });

  it('still fails when the frame is not the refused turn (the refusal row removed)', () => {
    const edited = frame.replace('Error: Unauthorized', 'Done.');
    expect(judge('screen-running', edited, IDLE).status).toBe('fail');
  });
});

describe('[#3422] screen-quoted-dialog on the refused turn', () => {
  it('is a signed-out skip on the retry frame (the quoted turn alone)', () => {
    const frame = read(DIR_3420, 'unauthorized-quoted-turn');
    expect(verdictOf(frame, 'opencode-v2')).toMatchObject({ status: 'waiting', reason: 'opencode_permission_prompt' });
    expect(judge('screen-quoted-dialog', frame, IDLE)).toMatchObject({ status: 'skip', skipKind: 'signed-out' });
  });

  it('is a signed-out skip after a refused running turn (the second refusal is the new one)', () => {
    const after = read(DIR_3420, 'unauthorized-quoted-after-running-turn');
    const before = read(DIR_3420, 'unauthorized-running-turn');
    expect(judge('screen-quoted-dialog', after, before)).toMatchObject({ status: 'skip', skipKind: 'signed-out' });
  });

  it('still fails when only the earlier turn was refused', () => {
    const after = read(DIR_3420, 'unauthorized-quoted-after-running-turn');
    const lastRefusal = after.lastIndexOf('Error: Unauthorized');
    const replied = `${after.slice(0, lastRefusal)}Done.${after.slice(lastRefusal + 'Error: Unauthorized'.length)}`;
    expect(judge('screen-quoted-dialog', replied, read(DIR_3420, 'unauthorized-running-turn')).status).toBe('fail');
  });

  it('still fails on another model error (#3021)', () => {
    const other = read(DIR_3021, 'model-error-quoted-turn');
    expect(judge('screen-quoted-dialog', other, IDLE, 'opencode').status).toBe('fail');
  });

  it('a check that holds still passes on a refused turn', () => {
    const passing: ScreenVerdict = { status: 'ready', reason: 'x', hasActivePrompt: false, evidence: 'positive' };
    const frame = read(DIR_3420, 'unauthorized-quoted-turn');
    expect(judgeTurnScreen('screen-quoted-dialog', passing, frame, IDLE).status).toBe('pass');
  });
});

/** The types the daily run received, in arrival order (report `2026-10-08.json`). */
const REFUSED_TYPES = [
  'server.connected',
  'worktree.resolved',
  'project.updated',
  'models-dev.refreshed',
  'integration.updated',
  'provider.updated',
  'model.updated',
  'session.created',
  'session.inbox.enqueued',
  'session.execution.started',
  'session.inbox.delivered',
  'session.step.started',
  'session.step.failed',
  'session.execution.failed',
  'session.viewed',
];

const events = (types: readonly string[], at = 100): ReceivedServerEvent[] =>
  types.map((type) => ({ type, receivedAt: at }));

describe('[#3420] hook-correlation (opencode-v2 SSE) on the refused turn', () => {
  const window = { from: 50, to: 200 };

  it('is a signed-out skip when the screen showed the refusal and the server said the execution failed', () => {
    const check = judgeServerEvents(events(REFUSED_TYPES), { window, unauthorized: true });
    expect(check).toMatchObject({ checkId: 'hook-correlation', status: 'skip', skipKind: 'signed-out' });
    expect(check.skipReason).toContain('session.execution.succeeded が未着');
  });

  it('without a running window (the retry drives a plain turn) too', () => {
    expect(judgeServerEvents(events(REFUSED_TYPES), { unauthorized: true }).status).toBe('skip');
  });

  it('still fails when the screen showed no refusal', () => {
    expect(judgeServerEvents(events(REFUSED_TYPES), { window, unauthorized: false }).status).toBe('fail');
  });

  it('still fails when the server did not report a failed execution', () => {
    const types = REFUSED_TYPES.filter((type) => type !== 'session.execution.failed');
    expect(judgeServerEvents(events(types), { window, unauthorized: true }).status).toBe('fail');
  });

  it('still fails when session.execution.started is missing too', () => {
    const types = REFUSED_TYPES.filter((type) => type !== 'session.execution.started');
    expect(judgeServerEvents(events(types), { window, unauthorized: true }).status).toBe('fail');
  });

  it('still fails when the failure arrived outside the running window', () => {
    const inside = events(REFUSED_TYPES.filter((type) => type !== 'session.execution.failed'));
    const outside = events(['session.execution.failed'], 500);
    expect(judgeServerEvents([...inside, ...outside], { window, unauthorized: true }).status).toBe('fail');
  });

  it('still fails when the stream broke', () => {
    expect(
      judgeServerEvents(events(REFUSED_TYPES), { window, unauthorized: true, streamError: 'ECONNRESET' }).status
    ).toBe('fail');
  });

  it('still passes when the turn succeeded', () => {
    const types = ['session.execution.started', 'session.execution.succeeded'];
    expect(judgeServerEvents(events(types), { window, unauthorized: true }).status).toBe('pass');
  });
});
