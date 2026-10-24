/**
 * sendNewTask arms Auto-Yes with the answer mode the dialog picked
 * (Issue #3863).
 *
 * The arming request names the mode on every arming — the default too —
 * because the route reads an omitted mode on an instance already on as "keep
 * the current one", and the dialog's list may predate another tab arming it in
 * 慎重. Nothing is armed, and so no mode is sent, without a duration.
 */

import { describe, it, expect, vi } from 'vitest';
import { sendNewTask, type SendNewTaskInput } from '@/lib/new-task/send-new-task';
import { jsonResponse } from './new-task-fixtures';

const HOUR = 3_600_000;

function input(overrides: Partial<SendNewTaskInput> = {}): SendNewTaskInput {
  return {
    target: { worktreeId: 'wt', instanceId: 'codex-2' },
    cliToolId: 'codex',
    content: 'go',
    autoYesDuration: HOUR,
    ...overrides,
  };
}

function fakeRequest() {
  return vi.fn(async (url: string) =>
    url.endsWith('/auto-yes')
      ? jsonResponse({ enabled: true, expiresAt: 123, answerMode: 'careful' })
      : jsonResponse({ id: 'm1' }, 201),
  );
}

function armingBody(request: ReturnType<typeof fakeRequest>): Record<string, unknown> {
  const call = request.mock.calls.find(([url]) => String(url).endsWith('/auto-yes')) as unknown as
    | [string, { body: string }]
    | undefined;
  expect(call).toBeDefined();
  return JSON.parse(call![1].body) as Record<string, unknown>;
}

describe('[#3863] sendNewTask — the Auto-Yes answer mode', () => {
  it('arms with careful when it was picked', async () => {
    const request = fakeRequest();
    await sendNewTask(input({ autoYesAnswerMode: 'careful' }), request);

    expect(armingBody(request)).toEqual({
      enabled: true,
      cliToolId: 'codex',
      instanceId: 'codex-2',
      duration: HOUR,
      answerMode: 'careful',
    });
  });

  it('names recommended when the dialog passes it', async () => {
    const request = fakeRequest();
    await sendNewTask(input({ autoYesAnswerMode: 'recommended' }), request);

    expect(armingBody(request)).toMatchObject({ answerMode: 'recommended' });
  });

  it('names recommended when no mode is given (never left out)', async () => {
    const request = fakeRequest();
    await sendNewTask(input(), request);

    expect(armingBody(request)).toMatchObject({ answerMode: 'recommended' });
  });

  it('arms nothing without a duration, whatever the mode (negative control)', async () => {
    const request = fakeRequest();
    await sendNewTask(input({ autoYesDuration: null, autoYesAnswerMode: 'careful' }), request);

    expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/worktrees/wt/send']);
  });

  it('reports the armed state as before (the mode does not change the result shape)', async () => {
    const result = await sendNewTask(input({ autoYesAnswerMode: 'careful' }), fakeRequest());

    expect(result).toEqual({ ok: true, armedAutoYes: { enabled: true, expiresAt: 123 } });
  });
});
