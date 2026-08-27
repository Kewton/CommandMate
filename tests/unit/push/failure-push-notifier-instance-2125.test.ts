/**
 * The failure card names which instance went red (Issue #2125).
 *
 * The measured symptom (orchestrator UAT, 2026-08-27, iPadOS 18.7 / APNs; not
 * re-measured here — no device is reachable from this suite): a verification
 * failure raised by `commandmate verify uat/push-2002` arrived titled
 * `uat/push-2002` with the body `検証ゲート不合格：lint`. The body was already
 * ideal; the title had dropped the agent entirely, so a worktree running several
 * instances in parallel could not be told which one had failed.
 *
 * Driven against a real in-memory database with only `web-push` stubbed, for
 * the reason the #2000 suite gives: the property under test is what leaves the
 * process as a payload, and a spied `notifyPushSubscribers` would pass with the
 * title assembly removed.
 *
 * The waiting path is exercised in the same file on purpose. "The prompt card
 * still says `(claude)`" is an acceptance condition of #2125 and a #1790
 * regression if it breaks, and the two paths only diverge on this worktree if
 * both are watched at once.
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

// Hoisted for the reason the #2000 suite documents: the notifier's transitive
// imports call `createLogger` at module scope.
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

import { upsertPushSubscription } from '@/lib/db';
import { addAgentInstance } from '@/lib/db/agent-instances-db';
import { isValidInstanceId } from '@/lib/cli-tools/types';
import { resetNotificationDedup, resetWaitingPushDedup } from '@/lib/push/notification-dedup';
import { clearUpstreamFaultEpisodes } from '@/lib/push/failure-episode-state';
import {
  formatWorktreeWideAgentLabel,
  notifySessionStartFailurePush,
  notifyUpstreamFaultPush,
  notifyVerificationFailurePush,
} from '@/lib/push/failure-push-notifier';
import {
  startWaitingPushNotifier,
  stopWaitingPushNotifier,
} from '@/lib/push/waiting-push-notifier';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  observeWaitingEdge,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-2125';
const ENDPOINT = 'https://push.example/2125';
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
const T0 = 1_800_000_000_000;

let savedEnv: Record<string, string | undefined>;

const verificationRun = {
  worktreeId: WT,
  runId: 7,
  taskId: null as string | null,
  status: 'failed' as const,
  trigger: 'manual' as const,
  failedGateIds: ['lint'],
};

/** Titles actually handed to web-push, in order. */
function titles(): string[] {
  return sendNotification.mock.calls.map(
    ([, payload]) => (JSON.parse(payload as string) as { title: string }).title
  );
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** `agentLabel` from every `failure-push-raised` line this run logged. */
function raisedAgentLabels(): Array<unknown> {
  return (mockLogger.info.mock.calls as Array<[string, Record<string, unknown>?]>)
    .filter(([name]) => name === 'failure-push-raised')
    .map(([, ctx]) => ctx?.agentLabel);
}

function raisedInstanceIds(): Array<unknown> {
  return (mockLogger.info.mock.calls as Array<[string, Record<string, unknown>?]>)
    .filter(([name]) => name === 'failure-push-raised')
    .map(([, ctx]) => ctx?.instanceId);
}

function insertWorktree(cliToolId: string | null): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name, updated_at, cli_tool_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(WT, 'uat/push-2002', '/tmp/wt-2125', '/tmp/repo', 'repo', T0, cliToolId);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  insertWorktree('claude');
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

  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
  stopWaitingPushNotifier();
  resetNotificationDedup();
  resetWaitingPushDedup();
  clearUpstreamFaultEpisodes();
});

afterEach(() => {
  stopWaitingPushNotifier();
  clearWaitingTransitionListeners();
  clearWaitingEpisodes();
  resetNotificationDedup();
  resetWaitingPushDedup();
  clearUpstreamFaultEpisodes();
  db.close();
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('Issue #2125: a failure card never drops the agent silently', () => {
  it('labels a run that named no instance with the worktree-wide default', async () => {
    // Exactly the shape `commandmate verify <id>` produces: manual trigger, no
    // `--instance`, no task. Before #2125 this arrived as `uat/push-2002`.
    await notifyVerificationFailurePush({ ...verificationRun, instanceId: null });

    expect(titles()).toEqual(['uat/push-2002 (worktree: claude)']);
  });

  it('reads the default off the worktree rather than assuming claude', async () => {
    db.prepare('UPDATE worktrees SET cli_tool_id = ? WHERE id = ?').run('codex', WT);

    await notifyVerificationFailurePush({ ...verificationRun, instanceId: null });

    expect(titles()).toEqual(['uat/push-2002 (worktree: codex)']);
  });

  it('names the instance plainly when the caller attributed the run to one', async () => {
    // `commandmate verify <id> --instance codex-2`, and every `wait --verify`
    // that carries one. This is an attribution, not a default, so it renders
    // without the worktree-wide mark.
    await notifyVerificationFailurePush({ ...verificationRun, instanceId: 'codex-2' });

    expect(titles()).toEqual(['uat/push-2002 (codex-2)']);
  });

  it('does not blame a roster entry the run never named', async () => {
    // The scenario the Issue is about — several instances on one worktree. The
    // run named none of them, so none of them may appear as the subject; the
    // card says the worktree's default, marked as the default.
    addAgentInstance(db, WT, { id: 'codex-2', cliTool: 'codex', alias: '', order: 0 });
    addAgentInstance(db, WT, { id: 'claude-2', cliTool: 'claude', alias: '', order: 1 });

    await notifyVerificationFailurePush({ ...verificationRun, instanceId: null });

    expect(titles()).toEqual(['uat/push-2002 (worktree: claude)']);
  });

  it('says it could not tell, rather than guessing, when the worktree is gone', async () => {
    // `resolveSessionTarget` answers `fallback` here, which is its own
    // last-resort literal and not a fact about this worktree.
    db.prepare('DELETE FROM worktrees WHERE id = ?').run(WT);

    await notifyVerificationFailurePush({ ...verificationRun, instanceId: null });

    expect(titles()).toEqual([`${WT} (worktree: ?)`]);
  });

  it('keeps the log truthful about what the producer was told', async () => {
    await notifyVerificationFailurePush({ ...verificationRun, instanceId: null });

    // The card gained a label; the record did not gain an instance. #2043 rests
    // on an unnamed instance staying unnamed.
    expect(raisedAgentLabels()).toEqual(['worktree: claude']);
    expect(raisedInstanceIds()).toEqual([undefined]);
  });

  it('renders both spellings outside the instance-id alphabet', async () => {
    // The guarantee that makes the mark readable: no instance can ever be
    // called `worktree: claude`, so the suffix cannot be mistaken for one — not
    // even on a worktree whose operator registered an instance named `worktree`.
    expect(isValidInstanceId('worktree')).toBe(true);
    expect(isValidInstanceId(formatWorktreeWideAgentLabel('claude'))).toBe(false);
    expect(isValidInstanceId(formatWorktreeWideAgentLabel())).toBe(false);
  });
});

describe('Issue #2125: the other cards are untouched', () => {
  it('leaves the waiting card at `<worktree> (claude)` — the #1790 shape', async () => {
    startWaitingPushNotifier();
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    await flush();

    expect(titles()).toEqual(['uat/push-2002 (claude)']);
  });

  it('renders the two paths differently for the same worktree', async () => {
    startWaitingPushNotifier();
    observeWaitingEdge({ worktreeId: WT, cliToolId: 'claude', waiting: true, kind: 'prompt', now: T0 });
    await flush();
    await notifyVerificationFailurePush({ ...verificationRun, instanceId: null });

    // The divergence is the whole point: the prompt is about the instance that
    // is waiting, the verification is about the tree the gates ran in.
    expect(titles()).toEqual(['uat/push-2002 (claude)', 'uat/push-2002 (worktree: claude)']);
  });

  it('leaves the upstream-fault card naming its instance plainly', async () => {
    await notifyUpstreamFaultPush({
      worktreeId: WT,
      cliToolId: 'claude',
      faultId: 'overloaded',
      matchedText: 'API Error: Repeated 529 Overloaded errors',
      now: T0,
    });

    expect(titles()).toEqual(['uat/push-2002 (claude)']);
  });

  it('leaves the session-start card naming its instance plainly', async () => {
    await notifySessionStartFailurePush({
      worktreeId: WT,
      cliToolId: 'codex',
      instanceId: 'codex-2',
      toolName: 'Codex',
      error: new Error('tmux said no'),
    });

    expect(titles()).toEqual(['uat/push-2002 (codex-2)']);
  });
});
