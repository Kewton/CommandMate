/**
 * POST /api/hooks/agent-event (Issue #1549, Phase 3-2).
 *
 * Nothing is mocked below the route: real SQLite, real worktrees on disk, real
 * verification runs against `sh -c 'exit 0'` gates. The whole point of this
 * endpoint is that a POST from an agent's hook moves a task, and a mocked
 * service would only prove the route forwards arguments.
 *
 * Two properties get the most attention, because both are the kind that pass
 * vacuously if you are not careful:
 *
 *  - a `cwd` is refused for being malformed even when the path it would resolve
 *    to is a legitimate worktree, so the traversal check cannot be satisfied by
 *    "it happened not to match anything"
 *  - a session with no contract records nothing at all, asserted next to a
 *    control case in the same file that does record — otherwise "no rows" is
 *    equally consistent with the wiring being dead
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createTask,
  getTask,
  listTaskEvents,
  listVerificationRuns,
  upsertWorktree,
  type Task,
  type TaskStatus,
} from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { waitForVerification } from '@/lib/verification/gate-runner';
import {
  clearAgentStopEvents,
  getLastStopEventAt,
} from '@/lib/session/agent-event-state';
import { AUTH_EXCLUDED_PATHS } from '@/config/auth-config';

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

const VERIFY_CONFIG = `version: 1
gates:
  - id: pass-gate
    command: "sh -c 'exit 0'"
    timeoutSec: 30
options:
  baseRef: main
  skipInPrimaryCheckout: false
`;

let db: Database.Database;
let repo: string;
const wtId = 'wt-agent-event';
const tempDirs: string[] = [];

const asReq = (req: Request) => req as unknown as NextRequest;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepo(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'hook@example.test'], dir);
  git(['config', 'user.name', 'Hook'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(join(dir, '.commandmate', 'verify.yaml'), VERIFY_CONFIG);
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  // Uncommitted work, so the built-in work-evidence gate has something to find.
  writeFileSync(join(dir, 'work.txt'), 'agent output\n');
  return dir;
}

function seedTask(
  options: { status?: TaskStatus; autoVerifyOnStop?: boolean; instanceId?: string | null } = {}
): Task {
  const success =
    options.autoVerifyOnStop === undefined
      ? ''
      : `success:\n  autoVerifyOnStop: ${options.autoVerifyOnStop}\n`;
  return createTask(db, {
    worktreeId: wtId,
    cliToolId: 'claude',
    instanceId: options.instanceId === undefined ? null : options.instanceId,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: hook contract
goal: do the work
scope:
  allow: ["**"]
verify:
  gates: [pass-gate]
${success}`,
      'task.yaml'
    ),
    status: options.status ?? 'running',
  });
}

async function postEvent(body: unknown, raw?: string) {
  const { POST } = await import('@/app/api/hooks/agent-event/route');
  return POST(
    asReq(
      new Request('http://localhost/api/hooks/agent-event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw ?? JSON.stringify(body),
      })
    )
  );
}

async function postStop(cwd: string, tool = 'claude') {
  return postEvent({ tool, event: 'stop', cwd });
}

/** Every task_events row in the database, across all tasks. */
function allEvents() {
  const ids = db.prepare('SELECT id FROM tasks').all() as Array<{ id: string }>;
  return ids.flatMap((row) => listTaskEvents(db, row.id));
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAgentStopEvents();

  repo = createRepo('agent-event-');
  upsertWorktree(db, {
    id: wtId,
    name: 'feature/hook',
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
  });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  clearAgentStopEvents();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('input validation', () => {
  it('rejects a body that is not a JSON object', async () => {
    expect((await postEvent(undefined, 'not json')).status).toBe(400);
    expect((await postEvent(['stop'])).status).toBe(400);
    expect((await postEvent(null, 'null')).status).toBe(400);
  });

  it('rejects a tool that is not a known CLI tool id', async () => {
    expect((await postEvent({ tool: 'rm -rf', event: 'stop', cwd: repo })).status).toBe(400);
    expect((await postEvent({ event: 'stop', cwd: repo })).status).toBe(400);
  });

  it('rejects an unknown event name', async () => {
    expect((await postEvent({ tool: 'claude', event: 'exploded', cwd: repo })).status).toBe(400);
    expect((await postEvent({ tool: 'claude', cwd: repo })).status).toBe(400);
  });

  it('accepts the three declared event names', async () => {
    for (const event of ['stop', 'notification', 'session_start']) {
      expect((await postEvent({ tool: 'claude', event, cwd: repo })).status).toBe(202);
    }
  });

  it('rejects an over-long sessionId but accepts one at the limit', async () => {
    const base = { tool: 'claude', event: 'stop', cwd: repo };
    expect((await postEvent({ ...base, sessionId: 'a'.repeat(256) })).status).toBe(202);
    expect((await postEvent({ ...base, sessionId: 'a'.repeat(257) })).status).toBe(400);
  });
});

describe('cwd path traversal', () => {
  /**
   * The traversal cases below all *resolve* to the registered worktree. If the
   * route only rejected paths that turned out to match nothing, every one of
   * them would return 202 and the check would be worthless.
   */
  it('refuses a traversal path even when it resolves to a real worktree', async () => {
    // Control: the honest spelling of the same directory is accepted.
    expect((await postStop(join(repo, 'src'))).status).toBe(202);

    for (const cwd of [
      `${repo}/src/../src`,
      `${repo}/src/deep/../..`,
      `${repo}/..${repo.slice(repo.lastIndexOf('/'))}`,
    ]) {
      const response = await postStop(cwd);
      expect(response.status, `expected 400 for ${cwd}`).toBe(400);
      expect((await response.json()).error).toContain('traversal');
    }
  });

  it('refuses percent-encoded traversal', async () => {
    const response = await postStop(`${repo}/src/%2e%2e/src`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('traversal');
  });

  it('refuses a relative path, an empty path and a NUL byte', async () => {
    expect((await postStop('relative/path')).status).toBe(400);
    expect((await postStop('')).status).toBe(400);
    expect((await postStop(`${repo}\0/etc`)).status).toBe(400);
    expect((await postStop(`/${'a'.repeat(4096)}`)).status).toBe(400);
  });

  it('records nothing for a rejected cwd', async () => {
    seedTask();
    await postStop(`${repo}/src/../src`);

    expect(allEvents()).toHaveLength(0);
    expect(getLastStopEventAt(wtId, 'claude')).toBeNull();
  });
});

describe('worktree resolution', () => {
  it('resolves the worktree root and any directory beneath it', async () => {
    for (const cwd of [repo, join(repo, 'src'), join(repo, 'src', 'deep')]) {
      clearAgentStopEvents();
      expect((await postStop(cwd)).status).toBe(202);
      expect(getLastStopEventAt(wtId, 'claude'), `no event recorded for ${cwd}`).not.toBeNull();
    }
  });

  it('picks the innermost worktree when one is nested inside another', async () => {
    const inner = join(repo, 'nested');
    mkdirSync(inner, { recursive: true });
    upsertWorktree(db, {
      id: 'wt-inner',
      name: 'feature/inner',
      path: inner,
      repositoryPath: repo,
      repositoryName: 'fixture',
    });

    await postStop(inner);

    expect(getLastStopEventAt('wt-inner', 'claude')).not.toBeNull();
    expect(getLastStopEventAt(wtId, 'claude')).toBeNull();
  });

  it('accepts an unresolvable cwd with the same body a resolvable one gets', async () => {
    const resolved = await postStop(repo);
    const unknown = await postStop('/definitely/not/a/registered/worktree');
    const gone = await postStop(join(repo, 'no-such-directory'));

    const accepted = await resolved.json();
    expect(unknown.status).toBe(202);
    expect(gone.status).toBe(202);
    expect(await unknown.json()).toEqual(accepted);
    expect(await gone.json()).toEqual(accepted);
  });
});

describe('stop event effects', () => {
  it('records agent_idle with source=hook against the active task', async () => {
    const task = seedTask({ status: 'running' });

    expect((await postStop(repo)).status).toBe(202);

    const events = listTaskEvents(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('agent_idle');
    expect(events[0].fromStatus).toBe('running');
    expect(events[0].toStatus).toBe('running');
    expect(events[0].payload).toEqual({ source: 'hook' });
    expect(getTask(db, task.id)?.status).toBe('running');
  });

  it('moves a prompt-waiting task back to running', async () => {
    const task = seedTask({ status: 'waiting_input' });

    await postStop(repo);

    expect(getTask(db, task.id)?.status).toBe('running');
    expect(listTaskEvents(db, task.id)[0].toStatus).toBe('running');
  });

  it('records a refused transition as a row with to_status NULL', async () => {
    // A stop arriving mid-verification must not walk the task back out of
    // `verifying` — but the attempt has to stay visible, or a hook that fired
    // and was declined is indistinguishable from one that never fired.
    const task = seedTask({ status: 'verifying' });

    expect((await postStop(repo)).status).toBe(202);

    const events = listTaskEvents(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('agent_idle');
    expect(events[0].fromStatus).toBe('verifying');
    expect(events[0].toStatus).toBeNull();
    expect(getTask(db, task.id)?.status).toBe('verifying');
  });

  it('does not resolve a task that already reached a terminal status', async () => {
    // Distinct from the rejected transition above: `succeeded` and `cancelled`
    // are not active statuses, so a late hook never reaches the state machine at
    // all and leaves no row. Asserted so the difference is deliberate rather
    // than discovered later as a gap in the log.
    for (const status of ['succeeded', 'failed', 'cancelled', 'not_started'] as const) {
      db.prepare('DELETE FROM task_events').run();
      db.prepare('DELETE FROM tasks').run();
      const task = seedTask({ status });

      expect((await postStop(repo)).status).toBe(202);

      expect(listTaskEvents(db, task.id), `unexpected event for ${status}`).toHaveLength(0);
      expect(getTask(db, task.id)?.status).toBe(status);
    }
  });

  it('does not touch a task belonging to a different CLI tool', async () => {
    const task = seedTask({ status: 'running' });

    await postStop(repo, 'codex');

    expect(allEvents()).toHaveLength(0);
    expect(getTask(db, task.id)?.status).toBe('running');
  });

  it('leaves the task alone for notification and session_start', async () => {
    const task = seedTask({ status: 'running' });

    for (const event of ['notification', 'session_start']) {
      expect((await postEvent({ tool: 'claude', event, cwd: repo })).status).toBe(202);
    }

    expect(listTaskEvents(db, task.id)).toHaveLength(0);
    expect(getTask(db, task.id)?.status).toBe('running');
  });
});

describe('success.autoVerifyOnStop', () => {
  it('starts a verification run and drives the task to a verdict when true', async () => {
    const task = seedTask({ status: 'running', autoVerifyOnStop: true });

    expect((await postStop(repo)).status).toBe(202);

    const runs = listVerificationRuns(db, wtId);
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe('task');
    expect(runs[0].taskId).toBe(task.id);

    await waitForVerification(runs[0].id);
    expect(getTask(db, task.id)?.status).toBe('succeeded');

    const events = listTaskEvents(db, task.id).map((event) => event.event);
    expect(events).toEqual(['agent_idle', 'verify_started', 'verify_passed']);
  });

  it('starts nothing when the contract omits the flag', async () => {
    const task = seedTask({ status: 'running' });

    await postStop(repo);

    expect(listVerificationRuns(db, wtId)).toHaveLength(0);
    expect(getTask(db, task.id)?.status).toBe('running');
  });

  it('starts nothing when the flag is explicitly false', async () => {
    seedTask({ status: 'running', autoVerifyOnStop: false });

    await postStop(repo);

    expect(listVerificationRuns(db, wtId)).toHaveLength(0);
  });

  it('survives a second stop arriving while the first run is in flight', async () => {
    const task = seedTask({ status: 'running', autoVerifyOnStop: true });

    const [first, second] = await Promise.all([postStop(repo), postStop(repo)]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const runs = listVerificationRuns(db, wtId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    await Promise.all(runs.map((run) => waitForVerification(run.id)));
    expect(getTask(db, task.id)?.status).toBe('succeeded');
  });
});

describe('sessions with no contract are unaffected', () => {
  it('writes no task rows, no events and no runs, yet still accepts the event', async () => {
    // Control: the same POST against a contract-bearing session does record.
    // Without it, the assertions below would also hold if the route were dead.
    const control = seedTask({ status: 'running' });
    await postStop(repo);
    expect(listTaskEvents(db, control.id)).toHaveLength(1);

    db.prepare('DELETE FROM task_events').run();
    db.prepare('DELETE FROM tasks').run();

    expect((await postStop(repo)).status).toBe(202);

    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_events').get()).toEqual({ n: 0 });
    expect(listVerificationRuns(db, wtId)).toHaveLength(0);
  });

  it('still records the stop timestamp so the session can expose it', async () => {
    const before = Date.now();
    await postStop(repo);

    const at = getLastStopEventAt(wtId, 'claude');
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThanOrEqual(before);
  });

  it('leaves a pending task pending — nothing has been sent to that agent yet', async () => {
    const task = seedTask({ status: 'pending' });

    await postStop(repo);

    // `pending` is not an active status, so the task is never resolved at all.
    expect(listTaskEvents(db, task.id)).toHaveLength(0);
    expect(getTask(db, task.id)?.status).toBe('pending');
  });
});

describe('authentication', () => {
  it('is not in the auth bypass list', () => {
    // The route carries no auth code of its own: middleware protects everything
    // that is not listed here, so this list is the whole of its access control.
    // The live enforcement is exercised in hooks-agent-event-auth.test.ts.
    expect(AUTH_EXCLUDED_PATHS as readonly string[]).not.toContain('/api/hooks/agent-event');
    expect(AUTH_EXCLUDED_PATHS as readonly string[]).not.toContain('/api/hooks/claude-done');
  });
});
