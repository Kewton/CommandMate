/**
 * The failure notifier: who rings, who does not, and why the log says so
 * (Issue #2000).
 *
 * Driven against a real in-memory database with only `web-push` stubbed, for
 * the reason #1790's and #1999's suites give: the property under test is
 * whether a notification **leaves the process**, and a spied
 * `notifyPushSubscribers` would pass with the dedup or the fan-out removed.
 *
 * The logger is mocked because half of the requirement is discoverability
 * (`docs/design/discoverability-principle.md`): "the phone stayed quiet" has to
 * be told apart from "the notifier is broken", so the reason code on every
 * decision is asserted here rather than left to a human reading the source.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: vi.fn(),
  },
}));

// `vi.hoisted` because `vi.mock`'s factory is hoisted above every import: the
// notifier's own dependencies (`worktree-db` → `chat-db`) call `createLogger`
// at module scope, so the mock has to exist before any of them evaluate.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  },
}));
mockLogger.withContext.mockReturnValue(mockLogger);
vi.mock('@/lib/logger', () => ({
  createLogger: () => mockLogger,
  generateRequestId: () => 'test-request-id',
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import { upsertPushSubscription, updatePushSubscriptionPreferences } from '@/lib/db';
import { resetNotificationDedup } from '@/lib/push/notification-dedup';
import { clearUpstreamFaultEpisodes, UPSTREAM_FAULT_COOLDOWN_MS } from '@/lib/push/failure-episode-state';
import {
  notifySessionStartFailurePush,
  notifyUpstreamFaultPush,
  notifyVerificationFailurePush,
} from '@/lib/push/failure-push-notifier';
import { SessionStartFailedError } from '@/lib/session/session-start-error';

const WT = 'wt-2000';
const ENDPOINT = 'https://push.example/2000';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
const T0 = 1_800_000_000_000;

let savedEnv: Record<string, string | undefined>;

/** The payloads actually handed to web-push. */
function payloads(): Array<{ kind: string; body: string; title: string }> {
  return sendNotification.mock.calls.map(
    ([, payload]) => JSON.parse(payload as string) as { kind: string; body: string; title: string }
  );
}

/** Every `reason` this run logged, whichever level it was logged at. */
function loggedReasons(action: string): string[] {
  return [mockLogger.debug, mockLogger.info, mockLogger.warn]
    .flatMap((fn) => fn.mock.calls as Array<[string, Record<string, unknown>?]>)
    .filter(([name]) => name === action)
    .map(([, ctx]) => String(ctx?.reason ?? ''));
}

function raisedSignatures(): string[] {
  return (mockLogger.info.mock.calls as Array<[string, Record<string, unknown>?]>)
    .filter(([name]) => name === 'failure-push-raised')
    .map(([, ctx]) => String(ctx?.signature ?? ''));
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(WT, 'feature-x', '/tmp/wt-2000', '/tmp/repo', 'repo', T0);
  upsertPushSubscription(db, { endpoint: ENDPOINT, p256dh: 'p', auth: 'a', locale: 'en' });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  mockLogger.debug.mockReset();
  mockLogger.info.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();

  resetNotificationDedup();
  clearUpstreamFaultEpisodes();
});

afterEach(() => {
  resetNotificationDedup();
  clearUpstreamFaultEpisodes();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ===========================================================================
// 1. Verification gate failure
// ===========================================================================

describe('verification failure push (Issue #2000)', () => {
  const base = {
    worktreeId: WT,
    runId: 7,
    taskId: null as string | null,
    trigger: 'manual' as const,
  };

  it('notifies for a failed run that judged no contract, naming the gates', async () => {
    await notifyVerificationFailurePush({
      ...base,
      status: 'failed',
      failedGateIds: ['lint', 'unit'],
    });

    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({
      kind: 'failure',
      // Issue #2125: a run that named no instance is labelled with the
      // worktree's resolved default rather than losing the suffix entirely.
      title: 'feature-x (worktree: claude)',
      body: 'Verification failed: lint, unit',
    });
  });

  it('notifies for a run that errored before producing a verdict', async () => {
    await notifyVerificationFailurePush({ ...base, status: 'error' });
    expect(payloads()).toHaveLength(1);
    expect(payloads()[0].body).toBe('Verification failed');
  });

  it('stays quiet for a run attached to a contract task, and says why', async () => {
    // The adjudicated exclusion: /orchestrate workers all end in a verification
    // run, and ringing for each red one is the flood Epic #2002 exists to remove.
    await notifyVerificationFailurePush({
      ...base,
      taskId: '11111111-2222-3333-4444-555555555555',
      status: 'failed',
      failedGateIds: ['unit'],
    });

    expect(sendNotification).not.toHaveBeenCalled();
    expect(loggedReasons('failure-push-suppressed')).toContain('contract-task');
  });

  it('stays quiet for statuses that are not a failure', async () => {
    for (const status of ['passed', 'not_started', 'cancelled'] as const) {
      await notifyVerificationFailurePush({ ...base, status });
    }
    expect(sendNotification).not.toHaveBeenCalled();
    expect(loggedReasons('failure-push-suppressed')).toEqual([
      'run-not-failed',
      'run-not-failed',
      'run-not-failed',
    ]);
  });

  it('treats two runs of the same worktree as two incidents', async () => {
    await notifyVerificationFailurePush({ ...base, runId: 7, status: 'failed', failedGateIds: ['unit'] });
    await notifyVerificationFailurePush({ ...base, runId: 8, status: 'failed', failedGateIds: ['unit'] });

    // Same worktree, same failing gate, same wording, inside the 30 s content
    // window — the run id is what keeps them apart.
    expect(payloads()).toHaveLength(2);
    expect(raisedSignatures()).toEqual(['verification:7', 'verification:8']);
  });

  it('does not reach a device that turned the action bucket off', async () => {
    updatePushSubscriptionPreferences(db, ENDPOINT, { enabledPrompt: false });
    await notifyVerificationFailurePush({ ...base, status: 'failed' });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('reaches a device that has completions off — a failure is not a completion', async () => {
    // The default state of a device registered after #2000.
    updatePushSubscriptionPreferences(db, ENDPOINT, { enabledCompletion: false });
    await notifyVerificationFailurePush({ ...base, status: 'failed' });
    expect(payloads()).toHaveLength(1);
  });
});

// ===========================================================================
// 2. Upstream fault
// ===========================================================================

describe('upstream fault push (Issue #2000)', () => {
  const fault = (now: number, faultId: string | null = 'overloaded') =>
    notifyUpstreamFaultPush({
      worktreeId: WT,
      cliToolId: 'claude',
      faultId,
      matchedText: 'API Error: Repeated 529 Overloaded errors',
      now,
    });

  it('rings once for one incident, however many polls see it', async () => {
    for (let i = 0; i < 40; i += 1) await fault(T0 + i * 2_000);

    expect(payloads()).toHaveLength(1);
    expect(payloads()[0].body).toBe(
      'Stalled by an upstream API fault: API Error: Repeated 529 Overloaded errors'
    );
  });

  it('does not ring again while the storm flaps in and out of the window', async () => {
    await fault(T0);
    // The banner scrolls away and comes back with each retry.
    for (let i = 1; i <= 10; i += 1) {
      await fault(T0 + i * 4_000, null);
      await fault(T0 + i * 4_000 + 1_000, i % 2 === 0 ? 'retrying' : 'overloaded');
    }

    expect(payloads()).toHaveLength(1);
    expect(loggedReasons('failure-push-suppressed')).toContain('upstream-cooldown');
  });

  it('rings again for an incident past the cooldown', async () => {
    await fault(T0);
    await fault(T0 + 1_000, null);
    await fault(T0 + UPSTREAM_FAULT_COOLDOWN_MS + 1_000);

    expect(payloads()).toHaveLength(2);
  });

  it('is inert on an install with no VAPID keys', async () => {
    delete process.env.CM_VAPID_PUBLIC_KEY;
    delete process.env.CM_VAPID_PRIVATE_KEY;

    await fault(T0);

    expect(sendNotification).not.toHaveBeenCalled();
    // Nothing was recorded either, so configuring push later still notifies.
    process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
    process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';
    await fault(T0 + 1_000);
    expect(payloads()).toHaveLength(1);
  });
});

// ===========================================================================
// 3. Session start failure
// ===========================================================================

/**
 * Issue #2009 changed the input from a pre-digested `detectedPattern` to the
 * error `startSession()` actually threw, because the classification (ring /
 * stay quiet / which wording) is what has to live in one place. Every assertion
 * below is byte-identical to #2000's: same title, same body, same dedup.
 */
const NESTED_SESSION_PATTERN = 'cannot be launched inside another Claude Code session';

function claudeStartFailure(): SessionStartFailedError {
  return new SessionStartFailedError('Claude Code', 'mcbd-claude-wt-2000', NESTED_SESSION_PATTERN);
}

describe('session start failure push (Issue #2000)', () => {
  it('notifies with the tool and the pattern that was detected', async () => {
    await notifySessionStartFailurePush({
      worktreeId: WT,
      cliToolId: 'claude',
      toolName: 'Claude Code',
      error: claudeStartFailure(),
    });

    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({
      kind: 'failure',
      title: 'feature-x (claude)',
      body:
        'Could not start the session: Claude Code: cannot be launched inside another Claude Code session',
    });
  });

  it('collapses the burst a retrying caller produces', async () => {
    const input = {
      worktreeId: WT,
      cliToolId: 'claude' as const,
      toolName: 'Claude Code',
      error: claudeStartFailure(),
    };
    await notifySessionStartFailurePush(input);
    await notifySessionStartFailurePush(input);
    await notifySessionStartFailurePush(input);

    expect(payloads()).toHaveLength(1);
  });

  it('keeps two instances of the same worktree apart', async () => {
    const input = {
      worktreeId: WT,
      cliToolId: 'claude' as const,
      toolName: 'Claude Code',
      error: claudeStartFailure(),
    };
    await notifySessionStartFailurePush(input);
    await notifySessionStartFailurePush({ ...input, instanceId: 'claude-2' });

    expect(payloads()).toHaveLength(2);
    expect(payloads().map((p) => p.title)).toEqual([
      'feature-x (claude)',
      'feature-x (claude-2)',
    ]);
  });
});

// ===========================================================================
// 4. Auto-Yes does not turn failures into a flood (Issue #2000, requirement 3)
// ===========================================================================

describe('failure notifications under Auto-Yes (Issue #2000)', () => {
  it('is bounded by the incident, not by the poll rate, whatever Auto-Yes does', async () => {
    // #1999 gates prompts on Auto-Yes; failures deliberately do not go through
    // that gate (Auto-Yes answers dialogs, it does not fix a red gate or an
    // upstream outage). What has to hold instead is that the failure paths are
    // bounded by the incident. An Auto-Yes session polls for hours, so this is
    // the shape that matters: one long stall, hundreds of polls.
    for (let i = 0; i < 300; i += 1) {
      await notifyUpstreamFaultPush({
        worktreeId: WT,
        cliToolId: 'claude',
        faultId: i % 7 === 0 ? null : 'overloaded',
        matchedText: `API Error: 529 Overloaded · attempt ${i}/300`,
        now: T0 + i * 2_000,
      });
    }

    // 300 polls over 10 minutes of stall — well inside one cooldown.
    expect(payloads()).toHaveLength(1);
  });
});
