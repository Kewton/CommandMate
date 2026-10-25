/**
 * sendNewTask arms Auto-Yes for any 1〜24h the dialog picked (Issue #3913).
 *
 * The picked ms is what reaches `POST .../auto-yes`, before the send; a
 * response with no expiry stays "unknown" — the picked duration is never used
 * to guess one.
 */

import { describe, it, expect, vi } from 'vitest';
import { sendNewTask, type SendNewTaskInput } from '@/lib/new-task/send-new-task';
import { jsonResponse } from './new-task-fixtures';

const HOUR = 3_600_000;

function input(autoYesDuration: SendNewTaskInput['autoYesDuration']): SendNewTaskInput {
  return { target: { worktreeId: 'wt', instanceId: 'codex-2' }, cliToolId: 'codex', content: 'go', autoYesDuration };
}

describe('[#3913] sendNewTask — 5h / 24h', () => {
  it.each([[5, 18_000_000], [24, 86_400_000]] as const)('arms %ih with that many ms, then sends', async (_hours, ms) => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return url.endsWith('/auto-yes') ? jsonResponse({ enabled: true, expiresAt: 1 + ms }) : jsonResponse({ id: 'm1' }, 201);
    });

    const result = await sendNewTask(input(ms), request);

    expect(calls.map((c) => c.url)).toEqual(['/api/worktrees/wt/auto-yes', '/api/worktrees/wt/send']);
    expect(calls[0].body).toMatchObject({ enabled: true, instanceId: 'codex-2', duration: ms });
    expect(result).toEqual({ ok: true, armedAutoYes: { enabled: true, expiresAt: 1 + ms } });
  });

  it('a 24h arm answered without an expiry is unknown, not now + 24h', async () => {
    const request = vi.fn(async (url: string) =>
      url.endsWith('/auto-yes') ? jsonResponse({ enabled: true }) : jsonResponse({ id: 'm1' }, 201),
    );
    expect(await sendNewTask(input(24 * HOUR as SendNewTaskInput['autoYesDuration']), request)).toEqual({
      ok: true,
      autoYesStateUnknown: true,
    });
  });

  it('touches no Auto-Yes when nothing was picked (negative control)', async () => {
    const request = vi.fn(async (_url: string) => jsonResponse({ id: 'm1' }, 201));
    await sendNewTask(input(null), request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0][0])).toBe('/api/worktrees/wt/send');
  });
});
