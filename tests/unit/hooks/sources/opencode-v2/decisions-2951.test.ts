/**
 * OpenCode V2's pending decisions, re-read (Issue #2951).
 *
 *  - Auto-Yes switched on while an approval is already pending answers it:
 *    `recheckPendingDecisions` re-reads `GET /api/permission/request`, which
 *    the source can now do (`resync: 'pending-list'`);
 *  - a (re-)connection replays the server's pending lists through the live
 *    ingest (`resyncOpencodeV2Pending`), and an id already delivered is a
 *    duplicate, not a second approval;
 *  - a form field with `custom: true` is published as a question that takes a
 *    typed answer.
 *
 * The harness (fake server, mocks, `feed`) is `decisions-2945.test.ts`'s.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PORT = 4345;
const PASSWORD = 'pw-2945';

vi.mock('@/lib/hooks/sources/opencode-v2/ports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode-v2/ports')>();
  return { ...actual, getAssignedOpencodeV2Port: vi.fn(() => PORT) };
});

vi.mock('@/lib/hooks/sources/opencode-v2/secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode-v2/secrets')>();
  return { ...actual, readOpencodeV2Password: vi.fn(() => PASSWORD) };
});

// The real verdict (Auto-Yes state, deny patterns), without the database-backed
// contract policy and audit row.
vi.mock('@/lib/hooks/permission-decision-service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/hooks/permission-decision-service')>();
  return {
    ...actual,
    resolvePermissionRequest: vi.fn(
      (
        session: Parameters<typeof actual.decidePermissionRequest>[0],
        payload: Parameters<typeof actual.decidePermissionRequest>[1]
      ) => actual.decidePermissionRequest(session, payload, { readPolicy: () => null })
    ),
  };
});

vi.mock('@/lib/hooks/sources/opencode/push', () => ({
  notifyOpencodeQuestionPush: vi.fn(async () => {}),
}));

import { opencodeV2AgentEventSource } from '@/lib/hooks/sources/opencode-v2/source';
import {
  deliverOpencodeV2Frame,
  OPENCODE_V2_MAX_RESYNCED_DECISIONS,
  resyncOpencodeV2Pending,
} from '@/lib/hooks/sources/opencode-v2/subscription';
import { parseOpencodeV2Form } from '@/lib/hooks/sources/opencode-v2/payloads';
import { recheckPendingDecisions } from '@/lib/hooks/pending-decision-recheck';
import { ingestOpencodeV2Event } from '@/lib/hooks/sources/opencode-v2/ingest';
import { resetPendingDecisions } from '@/lib/hooks/sources';
import { notifyOpencodeQuestionPush } from '@/lib/hooks/sources/opencode/push';
import { clearPermissionDecisions } from '@/lib/hooks/permission-decision-state';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import {
  discardAgentEventState,
  getAskUserQuestion,
  getPendingDecisions,
} from '@/lib/session/agent-event-state';
import type { AgentInstanceRef, NormalizedAgentEvent } from '@/lib/hooks/sources/types';

type Frame = Record<string, unknown>;

const SESSION = 'ses_2945probeSession000000000';
const PERMISSION_ID = 'per_2945probePermission0000000';
const FORM_ID = 'frm_2945probeForm00000000000000';
const PATCH =
  'Index: hello.txt\n===================================================================\n' +
  '--- hello.txt\n+++ hello.txt\n@@ -0,0 +1,1 @@\n+hi\n';

const permissionAsked = (id = PERMISSION_ID): Frame => ({
  id: `evt_${id}`,
  type: 'permission.asked',
  location: { directory: '/tmp/probe/repo' },
  data: {
    id,
    sessionID: SESSION,
    action: 'edit',
    resources: ['hello.txt'],
    save: ['*'],
    metadata: {
      files: [{ file: 'hello.txt', patch: PATCH, status: 'added', additions: 1, deletions: 0 }],
    },
    source: { type: 'tool', messageID: 'msg_x', id: 'prt_x' },
  },
});

/** `Form.Info` as `GET /api/session/{id}/form` answers it. */
const FORM = {
  id: FORM_ID,
  sessionID: SESSION,
  title: 'Questions',
  metadata: { kind: 'question' },
  fields: [
    {
      key: 'q0',
      title: 'Favourite colour?',
      type: 'string',
      options: [
        { value: 'blue', label: 'Blue', description: 'the sky' },
        { value: 'red', label: 'Red' },
      ],
      custom: true,
    },
  ],
};

interface Call {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

let calls: Call[] = [];
let pendingPermissions: unknown[] = [];
let pendingForms: unknown[] = [];

function fakeServer(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      path: url.pathname,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      authorization: headers.get('Authorization'),
    });
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'GET' && url.pathname === `/api/session/${SESSION}/form`) {
      return json({ data: [FORM] });
    }
    if (method === 'GET' && url.pathname === '/api/permission/request') {
      return json({ location: { directory: '/tmp/probe/repo' }, data: pendingPermissions });
    }
    if (method === 'GET' && url.pathname === '/api/form') {
      return json({ location: { directory: '/tmp/probe/repo' }, data: pendingForms });
    }
    if (method === 'POST' && url.pathname.endsWith('/reply')) {
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

let counter = 0;
const targets: AgentInstanceRef[] = [];

function freshTarget(): AgentInstanceRef {
  counter += 1;
  const target: AgentInstanceRef = {
    worktreeId: `wt-2945-${counter}`,
    cliToolId: 'opencode-v2',
    instanceId: 'opencode-v2',
  };
  targets.push(target);
  return target;
}

const stopEffect = vi.fn(async () => {});

async function feed(target: AgentInstanceRef, frames: Frame[]): Promise<void> {
  let at = Date.now();
  for (const frame of frames) {
    const events: NormalizedAgentEvent[] = [];
    deliverOpencodeV2Frame(
      frame,
      (raw) => opencodeV2AgentEventSource.normalizeEvent(raw),
      (event) => events.push(event),
      at
    );
    for (const event of events) await ingestOpencodeV2Event(target, event, stopEffect);
    at += 10;
  }
}

function pendingOf(target: AgentInstanceRef) {
  return getPendingDecisions(target.worktreeId, 'opencode-v2', 'opencode-v2');
}

function replies(): Call[] {
  return calls.filter((call) => call.method === 'POST');
}

beforeEach(() => {
  calls = [];
  pendingPermissions = [];
  pendingForms = [];
  vi.stubGlobal('fetch', fakeServer());
});

afterEach(() => {
  for (const target of targets.splice(0)) {
    discardAgentEventState(target.worktreeId, target.cliToolId, target.instanceId);
  }
  clearAllAutoYesStates();
  clearPermissionDecisions();
  resetPendingDecisions();
  stopEffect.mockClear();
  vi.mocked(notifyOpencodeQuestionPush).mockClear();
  vi.unstubAllGlobals();
});

function replayInto(target: AgentInstanceRef): {
  replay: (frame: Frame) => void;
  settled: () => Promise<void>;
} {
  const frames: Frame[] = [];
  return {
    replay: (frame) => frames.push(frame),
    settled: () => feed(target, frames),
  };
}

describe('Auto-Yes switched on under a pending approval (policy re-check)', () => {
  it('declares a resync the re-check honours', () => {
    expect(opencodeV2AgentEventSource.capabilities.resync).toBe('pending-list');
  });

  it('answers the approval the server is still holding', async () => {
    const target = freshTarget();
    await feed(target, [permissionAsked()]);
    expect(replies()).toEqual([]);
    expect(pendingOf(target)).toHaveLength(1);

    pendingPermissions = [permissionAsked().data];
    setAutoYesEnabled(target.worktreeId, 'opencode-v2', true, undefined, undefined, 'opencode-v2');
    const recheck = await recheckPendingDecisions(target);

    expect(recheck).toMatchObject({ examined: 1, delivered: 1, reason: null });
    expect(replies()).toEqual([
      expect.objectContaining({
        path: `/api/session/${SESSION}/permission/${PERMISSION_ID}/reply`,
        body: { decision: 'once' },
      }),
    ]);
    expect(pendingOf(target)).toEqual([]);
  });

  it('answers nothing when the server holds nothing', async () => {
    const target = freshTarget();
    setAutoYesEnabled(target.worktreeId, 'opencode-v2', true, undefined, undefined, 'opencode-v2');
    expect(await recheckPendingDecisions(target)).toMatchObject({ reason: 'no-pending' });
    expect(replies()).toEqual([]);
  });

  it('never answers a question', async () => {
    const target = freshTarget();
    pendingForms = [FORM];
    setAutoYesEnabled(target.worktreeId, 'opencode-v2', true, undefined, undefined, 'opencode-v2');
    expect(await recheckPendingDecisions(target)).toMatchObject({ reason: 'no-pending' });
    expect(replies()).toEqual([]);
  });
});

describe('a (re-)connection replays the pending lists', () => {
  it('records an approval and a question raised while the stream was down', async () => {
    const target = freshTarget();
    pendingPermissions = [permissionAsked().data];
    pendingForms = [FORM];
    const { replay, settled } = replayInto(target);

    expect(await resyncOpencodeV2Pending(target, PORT, PASSWORD, replay)).toBe(2);
    await settled();

    const ids = pendingOf(target).map((pending) => pending.decisionId);
    expect(ids).toContain(PERMISSION_ID);
    expect(ids).toContain(FORM_ID);
    const episode = getAskUserQuestion(target.worktreeId, 'opencode-v2', 'opencode-v2');
    expect(episode?.spec.questions[0].question).toBe('Favourite colour?');
    expect(replies()).toEqual([]);
  });

  it('with Auto-Yes on, answers the replayed approval', async () => {
    const target = freshTarget();
    setAutoYesEnabled(target.worktreeId, 'opencode-v2', true, undefined, undefined, 'opencode-v2');
    pendingPermissions = [permissionAsked().data];
    const { replay, settled } = replayInto(target);

    await resyncOpencodeV2Pending(target, PORT, PASSWORD, replay);
    await settled();

    expect(replies()).toEqual([
      expect.objectContaining({ body: { decision: 'once' } }),
    ]);
  });

  it('an approval already delivered live is a duplicate, not a second approval', async () => {
    const target = freshTarget();
    setAutoYesEnabled(target.worktreeId, 'opencode-v2', true, undefined, undefined, 'opencode-v2');
    await feed(target, [permissionAsked()]);
    expect(replies()).toHaveLength(1);

    pendingPermissions = [permissionAsked().data];
    const { replay, settled } = replayInto(target);
    await resyncOpencodeV2Pending(target, PORT, PASSWORD, replay);
    await settled();

    expect(replies()).toHaveLength(1);
  });

  it('replays nothing, and does not throw, when the server does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    const replay = vi.fn();
    expect(await resyncOpencodeV2Pending(freshTarget(), PORT, PASSWORD, replay)).toBe(0);
    expect(replay).not.toHaveBeenCalled();
  });

  it('is bounded', async () => {
    pendingPermissions = Array.from(
      { length: OPENCODE_V2_MAX_RESYNCED_DECISIONS + 5 },
      (_unused, index) => ({ ...(permissionAsked(`per_bounded${index}`).data as object) })
    );
    const replay = vi.fn();
    expect(await resyncOpencodeV2Pending(freshTarget(), PORT, PASSWORD, replay)).toBe(
      OPENCODE_V2_MAX_RESYNCED_DECISIONS
    );
  });
});

describe('a form field that takes a typed answer', () => {
  it('`custom: true` is carried onto the question', () => {
    const spec = parseOpencodeV2Form(FORM);
    expect(spec?.questions[0].custom).toBe(true);
  });

  it('a field without it carries no `custom`', () => {
    const spec = parseOpencodeV2Form({
      ...FORM,
      fields: [{ ...FORM.fields[0], custom: false }],
    });
    expect(spec?.questions[0]).not.toHaveProperty('custom');
  });

  it('a boolean field never takes one', () => {
    const spec = parseOpencodeV2Form({
      ...FORM,
      fields: [{ key: 'b', title: 'Proceed?', type: 'boolean', custom: true }],
    });
    expect(spec?.questions[0]).not.toHaveProperty('custom');
  });
});
