/**
 * opencode's own stream raising phone notifications (Issue #2045).
 *
 * Driven end-to-end against a real in-memory database with only `web-push`
 * stubbed, the way #1790's suite is, and for the same reason: the properties
 * this Issue is about are the ones a spied `notifyPushSubscribers` would hide.
 * "One card per wait, whichever producer saw it" is a statement about the dedup
 * *inside* the fan-out, and a mock at the fan-out's front door would report it
 * green with the dedup deleted.
 *
 * The frames are the captured fixtures, re-confirmed against opencode 1.18.22
 * on 2026-08-25 (`docs/design/opencode-server-live-verification.md` §17): the
 * live `question.asked` and the live `session.error APIError` came back
 * byte-identical in shape to the 1.18.3 captures already in the repository.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
  },
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

// The subscription half of this file drives `deliver()` through a fake stream;
// nothing here is allowed to reach a real opencode server.
vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>();
  return {
    ...actual,
    fetchOpencodePendingPermissions: vi.fn().mockResolvedValue([]),
    fetchOpencodePendingQuestions: vi.fn().mockResolvedValue([]),
    fetchOpencodeSessionStatuses: vi.fn().mockResolvedValue({}),
    fetchOpencodeSessionMessages: vi.fn().mockResolvedValue([]),
    probeOpencodeHealth: vi.fn(),
    openOpencodeEventStream: vi.fn(),
    replyOpencodePermission: vi.fn().mockResolvedValue(true),
    replyOpencodeQuestion: vi.fn().mockResolvedValue(true),
  };
});

import { upsertPushSubscription, updatePushSubscriptionPreferences } from '@/lib/db';
import {
  openOpencodeEventStream,
  probeOpencodeHealth,
  type OpencodeFrame,
} from '@/lib/hooks/sources/opencode/client';
import { ingestOpencodeEvent } from '@/lib/hooks/sources/opencode/ingest';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { resetOpencodeToolCalls } from '@/lib/hooks/sources/opencode/payloads';
import {
  closeOpencodeSubscription,
  openOpencodeSubscription,
  resetOpencodeSubscriptions,
} from '@/lib/hooks/sources/opencode/subscription';
import {
  clearAgentStopEvents,
  discardAgentEventState,
} from '@/lib/session/agent-event-state';
import { resetPendingDecisions, resetUnknownEventTallies } from '@/lib/hooks/sources';
import type { NormalizedAgentEvent } from '@/lib/hooks/sources';
import {
  resetNotificationDedup,
  resetWaitingPushDedup,
} from '@/lib/push/notification-dedup';
import { clearAllPromptCards } from '@/lib/push/prompt-card-state';
import { handleWaitingTransition } from '@/lib/push/waiting-push-notifier';
import { clearAllAutoYesStates } from '@/lib/auto-yes-state';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');
const WT = 'wt-2045';
const PORT = 4795;
const T0 = 1_800_000_000_000;
const SESSION = 'ses_0000000000000000000000000';
const TARGET = { worktreeId: WT, cliToolId: 'opencode', instanceId: 'opencode' } as const;
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;

let savedEnv: Record<string, string | undefined>;

function frame(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

/** The event the subscription would hand to `ingestOpencodeEvent`. */
function normalized(name: string, receivedAt = T0): NormalizedAgentEvent {
  const event = opencodeAgentEventSource.normalizeEvent({ payload: frame(name), receivedAt });
  if (!event) throw new Error(`fixture ${name} did not normalise`);
  return event;
}

/** The same, with the frame edited first — a longer question, another error. */
function normalizedFrom(
  payload: Record<string, unknown>,
  receivedAt = T0
): NormalizedAgentEvent {
  const event = opencodeAgentEventSource.normalizeEvent({ payload, receivedAt });
  if (!event) throw new Error('frame did not normalise');
  return event;
}

/** Let the fire-and-forget fan-out reach `web-push`. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function payloads(): Array<Record<string, unknown>> {
  return sendNotification.mock.calls.map(
    ([, payload]) => JSON.parse(payload as string) as Record<string, unknown>
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-2045', '/tmp/wt-2045', '/tmp/repo', 'repo', T0);
  upsertPushSubscription(db, { endpoint: 'https://push.example/one', p256dh: 'p', auth: 'a' });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  sendNotification.mockReset();
  setVapidDetails.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });

  clearAgentStopEvents();
  discardAgentEventState(WT, 'opencode', 'opencode');
  resetPendingDecisions();
  resetUnknownEventTallies();
  resetOpencodeToolCalls();
  resetOpencodeSubscriptions();
  resetNotificationDedup();
  resetWaitingPushDedup();
  clearAllPromptCards();
  clearAllAutoYesStates();
});

afterEach(async () => {
  await closeOpencodeSubscription(TARGET);
  resetOpencodeSubscriptions();
  clearAllAutoYesStates();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  db.close();
});

describe('question.asked', () => {
  it('sends exactly one card, naming the worktree, the instance and the question', async () => {
    await ingestOpencodeEvent(TARGET, normalized('question-asked'));
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(payloads()[0]).toMatchObject({
      kind: 'prompt',
      // Both halves the Issue asks for: worktree name, then the instance.
      title: 'feature-2045 (opencode)',
      body: 'Waiting for reply: Which colour do you prefer?',
      worktreeId: WT,
      // `prompt`, not `menu`: an opencode question arrives as structured
      // choices, so it is answerable from the app rather than only at the pane.
      waitingKind: 'prompt',
    });
  });

  it('carries at most the first 80 characters of the question', async () => {
    const long = 'A'.repeat(200);
    const payload = frame('question-asked');
    (
      (payload.properties as Record<string, unknown>).questions as Array<Record<string, unknown>>
    )[0].question = long;

    await ingestOpencodeEvent(TARGET, normalizedFrom(payload));
    await flush();

    const body = payloads()[0].body as string;
    const excerpt = body.replace('Waiting for reply: ', '');
    expect(excerpt.length).toBe(80);
    // Truncation, not a slice of a longer excerpt the fan-out would have kept:
    // `push-sender`'s own default is 120, so an unbounded producer would show
    // 120 here.
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('is not joined by a second card when the status probe reports the same wait', async () => {
    // This is the collapse the Issue's "1 通ずつ" depends on. `ingest` sends
    // with `waitingSince = receivedAt`; `worktree-status-helper` later opens the
    // episode with `structuredSince = peekPromptWaiting().structured?.at`, which
    // is that same value, so `waiting-push-notifier` reports the same episode
    // and `shouldSendWaitingPush` recognises it as a repeat.
    await ingestOpencodeEvent(TARGET, normalized('question-asked'));
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);

    handleWaitingTransition({
      worktreeId: WT,
      cliToolId: 'opencode',
      instanceId: 'opencode',
      waiting: true,
      since: T0,
      kind: 'prompt',
      at: T0 + 5_000,
    });
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('sends a second card for a genuinely different wait', async () => {
    // The mirror image of the test above: the guard must not become "one
    // notification per instance, ever". A new `que_` id at a new time is a new
    // question a human has to answer separately.
    await ingestOpencodeEvent(TARGET, normalized('question-asked'));
    await flush();

    const second = frame('question-asked');
    (second.properties as Record<string, unknown>).id = 'que_1111111111111111111111111';
    (
      (second.properties as Record<string, unknown>).questions as Array<Record<string, unknown>>
    )[0].question = 'Which shape do you prefer?';
    await ingestOpencodeEvent(TARGET, normalizedFrom(second, T0 + 60_000));
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(payloads()[1].body).toBe('Waiting for reply: Which shape do you prefer?');
  });

  it('sends nothing extra when the same frame is delivered twice', async () => {
    // `classifyAgentEventDelivery` drops the repeat before `ingest` reaches the
    // notifier at all (#1899's identity guard, keyed on the `que_` id), so this
    // pins that the push producer sits behind that guard rather than in front
    // of it.
    await ingestOpencodeEvent(TARGET, normalized('question-asked'));
    await ingestOpencodeEvent(TARGET, normalized('question-asked'));
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});

describe('session.error', () => {
  it('sends one failure card quoting the provider’s own message', async () => {
    await ingestOpencodeEvent(TARGET, normalized('session-error'));
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const payload = payloads()[0];
    expect(payload).toMatchObject({ kind: 'failure', title: 'feature-2045 (opencode)' });
    expect(payload.body).toContain('The agent stopped with an error:');
    expect(payload.body).toContain('No models loaded');
    // A failure keeps its own Service Worker tag, so it never replaces the card
    // for a question that is still open (#2000).
    expect(payload.tag).toBe(`${WT}:failure`);
  });

  it('says nothing about an abort', async () => {
    // `MessageAbortedError` is what `POST /session/:id/abort` produces — the
    // human pressed Escape. Reporting their own action back to them as a fault
    // is the one wording this path must never produce.
    await ingestOpencodeEvent(TARGET, normalized('session-error-aborted'));
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('notifies for a second, different error in the same session', async () => {
    await ingestOpencodeEvent(TARGET, normalized('session-error'));
    await flush();

    // Past `AGENT_EVENT_DEDUP_WINDOW_MS` on purpose — see the test below for
    // what happens inside it, and why that boundary is not this Issue's to move.
    const second = frame('session-error');
    (second.properties as Record<string, unknown>).error = {
      name: 'ContextOverflowError',
      data: { message: 'The context window is full' },
    };
    await ingestOpencodeEvent(TARGET, normalizedFrom(second, T0 + 10_000));
    await flush();

    // The push dedup key is the incident — `(session, error name)` — not the
    // prose, so two distinct faults both reach the reader while a retry of one
    // does not.
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(payloads()[1].body).toContain('The context window is full');
  });

  it('is bounded by #1899’s delivery window, which `session.error` cannot escape', async () => {
    // Measured, and recorded here because it is a real limit of the feature
    // rather than a property of the notifier: `opencodeEventIdentity` answers
    // null for `session.error` (the frame publishes no per-frame id — see
    // `./mappers`), so `classifyAgentEventDelivery` falls back to the 3 s window
    // keyed `(event, detail, sessionID)`. Two *different* errors closer together
    // than that are therefore collapsed into one card.
    //
    // Left as it is deliberately. The alternative — notifying before the
    // delivery guard — would put the phone in front of the state machine, and
    // #1898 established that ordering as the bug. What the reader loses is the
    // second line of a burst that arrives within three seconds; what they keep
    // is a card whose content the rest of the process agrees with.
    await ingestOpencodeEvent(TARGET, normalized('session-error'));
    const second = frame('session-error');
    (second.properties as Record<string, unknown>).error = {
      name: 'ContextOverflowError',
      data: { message: 'The context window is full' },
    };
    await ingestOpencodeEvent(TARGET, normalizedFrom(second, T0 + 1_000));
    await flush();

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});

describe('the events that must stay quiet', () => {
  it('sends nothing for an approval', async () => {
    // Approvals are Auto-Yes's business and the waiting edge's; this Issue
    // added a producer for the two events that had none, and widening it to
    // `permission.asked` would double every approval notification.
    await ingestOpencodeEvent(TARGET, normalized('permission-asked'));
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends nothing for a completed turn or a tool call', async () => {
    await ingestOpencodeEvent(TARGET, normalized('message-part-updated-tool-running'));
    await ingestOpencodeEvent(TARGET, normalized('message-part-updated-tool-completed'));
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe('installation.update-available', () => {
  let queued: Array<(signal: AbortSignal) => AsyncGenerator<OpencodeFrame>>;

  function streamOf(...frames: OpencodeFrame[]) {
    return async function* (): AsyncGenerator<OpencodeFrame> {
      for (const each of frames) yield each;
    };
  }

  function silentStream(signal: AbortSignal) {
    return async function* (): AsyncGenerator<OpencodeFrame> {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };
  }

  function subscribe() {
    return openOpencodeSubscription(
      TARGET,
      () => {},
      (raw) => opencodeAgentEventSource.normalizeEvent(raw),
      { port: PORT }
    );
  }

  beforeEach(() => {
    queued = [];
    // An update notice is informational, so it rides the completion toggle —
    // which is off by default on a newly registered device (#2000).
    updatePushSubscriptionPreferences(db, 'https://push.example/one', {
      enabledCompletion: true,
    });
    vi.mocked(probeOpencodeHealth).mockResolvedValue({
      kind: 'healthy',
      health: { healthy: true, version: '1.18.22' },
    });
    vi.mocked(openOpencodeEventStream).mockImplementation(
      async (_port: number, signal: AbortSignal) => (queued.shift() ?? silentStream(signal))(signal)
    );
  });

  it('announces the version once, from a frame that maps to no event word', async () => {
    queued.push(streamOf(frame('installation-update-available') as unknown as OpencodeFrame));
    await subscribe();

    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    expect(payloads()[0]).toMatchObject({
      kind: 'completion',
      title: 'feature-2045 (opencode)',
      body: 'An update for opencode is available: 1.19.0',
    });
  });

  it('does not repeat the same version on this connection', async () => {
    // The Issue's "once per session". The frame carries no `sessionID` at all
    // (measured against 1.18.22's `GET /doc`), so the connection is the only
    // unit that can answer it.
    //
    // `resetNotificationDedup()` between the two frames is what makes this test
    // mean anything. `notifyPushSubscribers` also holds a 30 s *content* window
    // keyed `${worktreeId}:completion`, which would swallow the repeat here on
    // its own and report the connection-scoped guard green with the guard
    // deleted — measured: removing `state.announcedUpdates.has(version)` left
    // this file fully passing until the reset was added. Clearing the content
    // window stands in for "an hour has gone by", which is the case the outer
    // guard exists for and the one the inner window cannot cover.
    const notice = frame('installation-update-available') as unknown as OpencodeFrame;
    queued.push(async function* (): AsyncGenerator<OpencodeFrame> {
      yield notice;
      await flush();
      resetNotificationDedup();
      yield notice;
    });
    await subscribe();

    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    await flush();
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('announces a different version even on the same connection', async () => {
    const first = frame('installation-update-available') as unknown as OpencodeFrame;
    const second = frame('installation-update-available');
    (second.properties as Record<string, unknown>).version = '1.20.0';
    queued.push(streamOf(first, second as unknown as OpencodeFrame));
    await subscribe();

    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(2));
    expect(payloads()[1].body).toBe('An update for opencode is available: 1.20.0');
  });

  it('says nothing when the frame carries no version', async () => {
    queued.push(
      streamOf({
        id: 'evt_0000000000000000000000000',
        type: 'installation.update-available',
        properties: {},
      } as unknown as OpencodeFrame)
    );
    await subscribe();
    await flush();
    await flush();

    expect(sendNotification).not.toHaveBeenCalled();
  });
});
