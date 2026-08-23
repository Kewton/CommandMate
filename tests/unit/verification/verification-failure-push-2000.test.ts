/**
 * A failed verification reaches a phone — unless it judged a contract
 * (Issue #2000).
 *
 * Driven through the real `startVerification` against a real repository, the
 * way `gate-runner-task-contract.test.ts` is: the decision keys off the task the
 * runner **resolves**, and only a real run resolves one. Gates are
 * `sh -c 'exit N'`, so each run costs milliseconds.
 *
 * Only `web-push` is stubbed. A spied notifier would count calls rather than
 * notifications, and would pass with the fan-out or the per-kind filter removed.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { removeTempDir } from '@tests/helpers/temp-dir';

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    sendNotification: (...args: unknown[]) => sendNotification(...args),
    setVapidDetails: vi.fn(),
  },
}));

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

import { createTask, upsertWorktree, type Task } from '@/lib/db';
import { upsertPushSubscription } from '@/lib/db/push-subscriptions-db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { resetNotificationDedup } from '@/lib/push/notification-dedup';
import { startVerification, waitForVerification } from '@/lib/verification/gate-runner';

let db: Database.Database;
let repo: string;
const wtId = 'wt-2000-verify';
const tempDirs: string[] = [];
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
let savedEnv: Record<string, string | undefined>;

const CONFIG = `version: 1
gates:
  - id: pass-gate
    command: "sh -c 'exit 0'"
    timeoutSec: 30
  - id: fail-gate
    command: "sh -c 'exit 1'"
    timeoutSec: 30
options:
  baseRef: main
  skipInPrimaryCheckout: false
`;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'verify-push-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'push@example.test'], dir);
  git(['config', 'user.name', 'Push'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(join(dir, '.commandmate', 'verify.yaml'), CONFIG);
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  return dir;
}

/** Uncommitted work, so the work-evidence gate has something to judge. */
function addWork(): void {
  writeFileSync(join(repo, 'work.txt'), 'agent output\n');
}

function seedTask(): Task {
  return createTask(db, {
    worktreeId: wtId,
    cliToolId: 'claude',
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: contract run
goal: do the work
scope:
  allow: ["**"]
`,
      'task.yaml'
    ),
    status: 'running',
  });
}

async function runToCompletion(gateIds?: string[]): Promise<void> {
  const { runId } = await startVerification({
    worktreeId: wtId,
    worktreePath: repo,
    trigger: 'manual',
    gateIds,
  });
  await waitForVerification(runId);
  // The notification is fire-and-forget from the run's `finally`.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function failurePayloads(): Array<{ kind: string; body: string; title: string }> {
  return sendNotification.mock.calls
    .map(
      ([, payload]) =>
        JSON.parse(payload as string) as { kind: string; body: string; title: string }
    )
    .filter((p) => p.kind === 'failure');
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  repo = createRepo();
  upsertWorktree(db, {
    id: wtId,
    name: 'feature/verify-push',
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
  });
  upsertPushSubscription(db, {
    endpoint: 'https://push.example/verify',
    p256dh: 'p',
    auth: 'a',
    locale: 'en',
  });

  savedEnv = {};
  for (const key of VAPID_ENV) savedEnv[key] = process.env[key];
  process.env.CM_VAPID_PUBLIC_KEY = 'test-public-key';
  process.env.CM_VAPID_PRIVATE_KEY = 'test-private-key';

  sendNotification.mockReset();
  sendNotification.mockResolvedValue({ statusCode: 201 });
  resetNotificationDedup();
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  resetNotificationDedup();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
  for (const key of VAPID_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('Issue #2000: verification failure notification', () => {
  it('notifies when a human-run verification fails, naming the gate', async () => {
    addWork();
    await runToCompletion(['fail-gate']);

    expect(failurePayloads()).toHaveLength(1);
    expect(failurePayloads()[0].title).toBe('feature/verify-push');
    expect(failurePayloads()[0].body).toContain('Verification failed');
    expect(failurePayloads()[0].body).toContain('fail-gate');
  });

  it('says nothing when the run passes', async () => {
    addWork();
    await runToCompletion(['pass-gate']);

    expect(failurePayloads()).toHaveLength(0);
  });

  it('says nothing for a run the worktree contract was resolved for', async () => {
    // The measured correction to the Issue's draft reading: nothing here names
    // a taskId, and `commandmate verify` never sends one — but
    // `startVerification` resolves the worktree's own verifiable task anyway
    // (#1545), which is exactly how an /orchestrate worker's run is attached.
    // Keying the exclusion on `input.taskId` would have let this ring.
    seedTask();
    addWork();
    await runToCompletion(['fail-gate']);

    expect(failurePayloads()).toHaveLength(0);
  });

  it('notifies when the repository declares no usable verify.yaml', async () => {
    // The synchronous config-failure path closes the run as `error` without
    // scheduling any gate. The verdict is just as absent as a red gate's.
    writeFileSync(join(repo, '.commandmate', 'verify.yaml'), 'version: 1\ngates: []\n');
    addWork();
    await runToCompletion();

    expect(failurePayloads()).toHaveLength(1);
    expect(failurePayloads()[0].body).toContain('Verification failed');
  });

  it('says nothing when there was no work to verify', async () => {
    // work-evidence found nothing → run `not_started`, exit 21. Nothing failed.
    await runToCompletion();

    expect(failurePayloads()).toHaveLength(0);
  });
});
