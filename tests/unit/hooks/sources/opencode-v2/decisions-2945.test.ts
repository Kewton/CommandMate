/**
 * OpenCode V2's approvals and questions, answered from CommandMate
 * (Issue #2945, Epic #2370 Phase 2).
 *
 * Frames go through the stream's own path (`deliverOpencodeV2Frame` → the
 * source's normalizer → `ingestOpencodeV2Event`), and the server is a fake
 * `fetch` that records what was POSTed. The approval frame is the Phase 0
 * shape (`metadata.files[].patch`). The first question frame is `form.created`
 * WITHOUT its form, so the question can only be built from the fake
 * `GET /api/session/{id}/form`; the measured 2.0.18 frames (the form nested as
 * `data.form`) are driven at the end.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
import { deliverOpencodeV2Frame } from '@/lib/hooks/sources/opencode-v2/subscription';
import { ingestOpencodeV2Event } from '@/lib/hooks/sources/opencode-v2/ingest';
import { resetPendingDecisions } from '@/lib/hooks/sources';
import { answerPendingDecisionWithReceipt } from '@/lib/hooks/sources/pending-decisions';
import { notifyOpencodeQuestionPush } from '@/lib/hooks/sources/opencode/push';
import { clearPermissionDecisions } from '@/lib/hooks/permission-decision-state';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import {
  discardAgentEventState,
  getAskUserQuestion,
  getPendingDecisions,
  getStructuredSessionState,
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

const permissionReplied: Frame = {
  id: 'evt_replied',
  type: 'permission.replied',
  data: { sessionID: SESSION, requestID: PERMISSION_ID, reply: 'once' },
};

const formCreated: Frame = {
  id: 'evt_form',
  type: 'form.created',
  data: { id: FORM_ID, sessionID: SESSION },
};

const formReplied: Frame = {
  id: 'evt_form_replied',
  type: 'form.replied',
  data: { sessionID: SESSION, formID: FORM_ID, answer: { q0: 'blue' } },
};

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

describe('D1: an approval is published with its diff and answered over …/permission/{id}/reply', () => {
  it('permission.asked (with a patch) opens a pending approval carrying the action, the rule and the diff', async () => {
    const target = freshTarget();
    await feed(target, [permissionAsked()]);

    expect(getStructuredSessionState(target.worktreeId, 'opencode-v2', 'opencode-v2')?.status).toBe(
      'waiting'
    );
    const [pending] = pendingOf(target);
    expect(pending.decisionId).toBe(PERMISSION_ID);
    expect(pending.toolName).toBe('edit');
    expect(pending.patterns).toEqual(['*']);
    // The diff, without the Index / --- / +++ banner.
    expect(pending.message).toBe('edit hello.txt\n@@ -0,0 +1,1 @@\n+hi');
    // Auto-Yes is off: nothing was sent.
    expect(replies()).toEqual([]);
  });

  it.each([
    [{ kind: 'allowOnce' } as const, 'once'],
    [{ kind: 'allowAlways' } as const, 'always'],
    [{ kind: 'deny' } as const, 'reject'],
  ])('a %o verdict POSTs {decision: %s}; permission.replied settles it', async (verdict, wire) => {
    const target = freshTarget();
    await feed(target, [permissionAsked()]);

    pendingPermissions = [(permissionAsked().data as Frame)];
    const [decision] = await opencodeV2AgentEventSource.listPending(target);
    expect(decision).toMatchObject({ kind: 'permission', id: PERMISSION_ID, conversationId: SESSION });

    const { delivery } = await answerPendingDecisionWithReceipt(
      opencodeV2AgentEventSource,
      target,
      decision,
      verdict
    );
    expect(delivery?.delivered).toBe(true);
    expect(replies()).toEqual([
      {
        method: 'POST',
        path: `/api/session/${SESSION}/permission/${PERMISSION_ID}/reply`,
        body: { decision: wire },
        authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`,
      },
    ]);

    await feed(target, [permissionReplied]);
    expect(pendingOf(target)).toEqual([]);
  });

  it('two approvals a second apart are two approvals (identity, not the time window)', async () => {
    const target = freshTarget();
    await feed(target, [permissionAsked(), permissionAsked('per_2945probePermission0000001')]);
    expect(pendingOf(target).map((entry) => entry.decisionId)).toEqual([
      PERMISSION_ID,
      'per_2945probePermission0000001',
    ]);
  });
});

describe('D3: Auto-Yes answers a structured approval by the same rule v1 uses', () => {
  it('Auto-Yes on: answers `once` before recording, so no human is left waiting', async () => {
    const target = freshTarget();
    setAutoYesEnabled(target.worktreeId, 'opencode-v2', true, undefined, undefined, 'opencode-v2');

    await feed(target, [permissionAsked()]);

    expect(replies()).toEqual([
      expect.objectContaining({
        path: `/api/session/${SESSION}/permission/${PERMISSION_ID}/reply`,
        body: { decision: 'once' },
      }),
    ]);
    expect(pendingOf(target)).toEqual([]);
  });

  it('Auto-Yes off: answers nothing and the approval stays pending', async () => {
    const target = freshTarget();
    await feed(target, [permissionAsked()]);
    expect(replies()).toEqual([]);
    expect(pendingOf(target)).toHaveLength(1);
  });
});

describe('D2: a question is published with its choices and answered over …/form/{id}/reply', () => {
  it('form.created + GET …/form → a question with choices, the phone notified', async () => {
    const target = freshTarget();
    await feed(target, [formCreated]);

    expect(calls).toContainEqual(
      expect.objectContaining({ method: 'GET', path: `/api/session/${SESSION}/form` })
    );
    const [pending] = pendingOf(target);
    expect(pending.decisionId).toBe(FORM_ID);
    const episode = getAskUserQuestion(target.worktreeId, 'opencode-v2', 'opencode-v2');
    expect(episode?.spec.questions[0].question).toBe('Favourite colour?');
    expect(episode?.spec.questions[0].choices.map((choice) => choice.label)).toEqual([
      'Blue',
      'Red',
    ]);
    expect(notifyOpencodeQuestionPush).toHaveBeenCalledWith(
      target,
      'opencode-v2',
      'Favourite colour?',
      expect.any(Number)
    );
  });

  it('answering by label sends the option VALUE as {answer: {<key>: <value>}}; form.replied settles it', async () => {
    const target = freshTarget();
    await feed(target, [formCreated]);

    pendingForms = [FORM];
    const [decision] = await opencodeV2AgentEventSource.listPending(target);
    expect(decision).toMatchObject({ kind: 'question', id: FORM_ID, conversationId: SESSION });

    const { delivery } = await answerPendingDecisionWithReceipt(
      opencodeV2AgentEventSource,
      target,
      decision,
      { kind: 'answer', answers: [['Blue']] }
    );
    expect(delivery?.delivered).toBe(true);
    expect(replies()).toEqual([
      expect.objectContaining({
        path: `/api/session/${SESSION}/form/${FORM_ID}/reply`,
        body: { answer: { q0: 'blue' } },
      }),
    ]);

    await feed(target, [formReplied]);
    expect(pendingOf(target)).toEqual([]);
  });

  it('a free-text answer is sent as typed because the field is `custom`', async () => {
    const target = freshTarget();
    pendingForms = [FORM];
    const [decision] = await opencodeV2AgentEventSource.listPending(target);
    await answerPendingDecisionWithReceipt(opencodeV2AgentEventSource, target, decision, {
      kind: 'answer',
      answers: [['Green']],
    });
    expect(replies()[0].body).toEqual({ answer: { q0: 'Green' } });
  });

  it('an approval verdict cannot answer a question, and nothing is sent', async () => {
    const target = freshTarget();
    pendingForms = [FORM];
    const [decision] = await opencodeV2AgentEventSource.listPending(target);
    const { delivery } = await answerPendingDecisionWithReceipt(
      opencodeV2AgentEventSource,
      target,
      decision,
      { kind: 'allowOnce' }
    );
    expect(delivery).toMatchObject({ delivered: false, reason: 'question-needs-answer-verdict' });
    expect(replies()).toEqual([]);
  });
});

describe('the measured 2.0.18 form frames (tests/fixtures/opencode-v2-live-2945)', () => {
  const measured = JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../../fixtures/opencode-v2-live-2945/sse-form-measured.json'),
      'utf8'
    )
  ) as Frame[];
  const created = measured.find((frame) => frame.type === 'form.created') as Frame;
  const replied = measured.find((frame) => frame.type === 'form.replied') as Frame;

  it('form.created nests the form as data.form: the question and its id come off the frame', async () => {
    const target = freshTarget();
    await feed(target, [created]);

    // Read off the frame: nothing asked the server for the form.
    expect(calls.filter((call) => call.method === 'GET')).toEqual([]);
    const [pending] = pendingOf(target);
    expect(pending.decisionId).toBe('frm_0e7df452a001fYcic4U7Q776Km');
    const episode = getAskUserQuestion(target.worktreeId, 'opencode-v2', 'opencode-v2');
    expect(episode?.spec.questions[0].choices.map((choice) => choice.label)).toEqual([
      'Apple',
      'Banana',
    ]);

    await feed(target, [replied]);
    expect(pendingOf(target)).toEqual([]);
  });
});

describe('listPending', () => {
  it('answers an empty list when the server does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    expect(await opencodeV2AgentEventSource.listPending(freshTarget())).toEqual([]);
  });
});
