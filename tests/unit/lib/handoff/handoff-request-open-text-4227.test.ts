/**
 * pr2e P3-3 (Issue #4227 G-PR3): `create` answering 409 `request_open` carries the picked-up
 * request's text, so the screen can send it again when it never went (`unsent`).
 *
 * The DB is a migrated file under `os.tmpdir()`, removed after each test.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: quiet, warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { handoffCreate } from '@/lib/handoff/request';
import { handoffRequestText } from '@/lib/handoff/template';
import { getHandoffRequest } from '@/lib/db/handoff-db';
import { makeHandoffWorld, screenRequest, WT, type HandoffWorld } from './handoff-harness';

let w: HandoffWorld;
beforeEach(() => {
  w = makeHandoffWorld('handoff-request-open-text-4227-');
  w.makeWorktree();
  w.setMode('on', true);
  w.openLaunch();
});
afterEach(() => w.close());

describe('[#4227] request_open carries the text of the request it picked up', () => {
  it('a second create while the first is open (unsent): 409 request_open with the same text', async () => {
    const first = await w.create();
    expect(getHandoffRequest(w.db, first.request.id)!.sendState).toBe('unsent');
    const again = await handoffCreate(w.db, screenRequest(), WT, { instanceId: 'claude' }, w.deps());
    expect(again.status).toBe(409);
    const body = again.body as { code: string; request: { id: string; sendState: string }; text?: string };
    expect(body.code).toBe('request_open');
    expect(body.request.id).toBe(first.request.id);
    expect(body.request.sendState).toBe('unsent');
    const row = getHandoffRequest(w.db, first.request.id)!;
    expect(body.text).toBe(handoffRequestText(row.id, new Date(row.agentDeadlineAt)));
    expect(body.text).toBe(first.text);
  });
});
