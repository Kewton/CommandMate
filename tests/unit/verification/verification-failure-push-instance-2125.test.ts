/**
 * A real verification run reaches a phone with the agent named (Issue #2125).
 *
 * Driven through `startVerification` against a real repository, the way the
 * #2000 suite is, because the fact under test spans the whole chain: the CLI
 * sends no instance, `gate-runner` forwards `null`, and the notifier is the
 * only place left that can say anything about which agent the run was about.
 * A unit test of the notifier alone would pass with `gate-runner` handing the
 * instance over in a shape the notifier never reads.
 *
 * Gates are `sh -c 'exit N'`, so each run costs milliseconds. Only `web-push`
 * is stubbed.
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

import { upsertWorktree } from '@/lib/db';
import { getVerificationRun } from '@/lib/db/verification-db';
import { upsertPushSubscription } from '@/lib/db/push-subscriptions-db';
import { resetNotificationDedup } from '@/lib/push/notification-dedup';
import { startVerification, waitForVerification } from '@/lib/verification/gate-runner';

let db: Database.Database;
let repo: string;
const wtId = 'wt-2125-verify';
const tempDirs: string[] = [];
const VAPID_ENV = ['CM_VAPID_PUBLIC_KEY', 'CM_VAPID_PRIVATE_KEY', 'CM_VAPID_SUBJECT'] as const;
let savedEnv: Record<string, string | undefined>;

const CONFIG = `version: 1
gates:
  - id: lint
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'verify-push-2125-')));
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
  // Uncommitted work, so work-evidence has something to judge.
  writeFileSync(join(dir, 'work.txt'), 'agent output\n');
  return dir;
}

/** Run `lint` to a verdict and let the fire-and-forget notification land. */
async function runToCompletion(instanceId?: string): Promise<number> {
  const { runId } = await startVerification({
    worktreeId: wtId,
    worktreePath: repo,
    trigger: 'manual',
    gateIds: ['lint'],
    instanceId,
  });
  await waitForVerification(runId);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return runId;
}

function failureTitles(): string[] {
  return sendNotification.mock.calls
    .map(([, payload]) => JSON.parse(payload as string) as { kind: string; title: string })
    .filter((p) => p.kind === 'failure')
    .map((p) => p.title);
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  repo = createRepo();
  upsertWorktree(db, {
    id: wtId,
    name: 'uat/push-2002',
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
    cliToolId: 'codex',
  });
  upsertPushSubscription(db, {
    endpoint: 'https://push.example/verify-2125',
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

describe('Issue #2125: `commandmate verify` failure cards name the agent', () => {
  it('labels the worktree-wide run with the agent the worktree resolves to', async () => {
    // The exact call `commandmate verify <id>` makes: no `--instance`. The
    // worktree runs codex, so nothing in the chain may say `claude`.
    await runToCompletion();

    expect(failureTitles()).toEqual(['uat/push-2002 (worktree: codex)']);
  });

  it('names the instance plainly when `--instance` attributed the run', async () => {
    await runToCompletion('codex-2');

    expect(failureTitles()).toEqual(['uat/push-2002 (codex-2)']);
  });

  it('does not write a resolved instance onto the run it labelled', async () => {
    // The line #2125 deliberately did not cross. `namesOpencodeInstance`
    // (#2043) reads this column and treats an unnamed instance as "do not
    // consult the second witness", so filling it in for the sake of a
    // notification title would move a verdict.
    const runId = await runToCompletion();

    expect(failureTitles()).toHaveLength(1);
    expect(getVerificationRun(db, runId)?.instanceId).toBeNull();
  });

  it('keeps `--instance` on the run row as the caller declared it', async () => {
    const runId = await runToCompletion('codex-2');

    expect(getVerificationRun(db, runId)?.instanceId).toBe('codex-2');
  });
});
