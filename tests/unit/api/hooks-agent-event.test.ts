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
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
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
  getAgentTurn,
  getLastStopEventAt,
  getStructuredSessionState,
} from '@/lib/session/agent-event-state';
import { AUTH_EXCLUDED_PATHS } from '@/config/auth-config';
import { freezeClock, unfreezeClock } from '@tests/helpers/frozen-clock';
import { removeTempDir } from '@tests/helpers/temp-dir';

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
    if (dir) removeTempDir(dir);
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

describe('a short turn the agent started for itself (Issue #3289)', () => {
  /**
   * The server log of 2026-10-05, claude 2.1.289: a `Stop`, the
   * `UserPromptSubmit` of the turn a background task's completion notice opened
   * 540 ms later, and that turn's `Stop` 1473 ms after the first. The second
   * `Stop` was logged `agent-event-duplicate-dropped`, the turn stayed open, and
   * `commandmate wait` did not return.
   *
   * The clock is driven by hand because the receiver stamps each delivery with
   * `Date.now()`, and "inside the three-second window" has to be a fact of the
   * case rather than of how fast the machine ran it.
   */
  const T = 1_800_000_000_000;
  const PROMPT_AFTER_MS = 540;
  const SECOND_STOP_AFTER_MS = 1473;
  const SESSION = 'sess-3289';

  afterEach(() => unfreezeClock());

  /** Deliver one event at `T + afterMs`, in the shape the relay script posts. */
  async function deliver(
    event: string,
    afterMs: number,
    extra: { tool?: string; detail?: string } = {}
  ) {
    freezeClock(T + afterMs);
    const response = await postEvent({
      tool: 'claude',
      event,
      cwd: repo,
      sessionId: SESSION,
      ...extra,
    });
    expect(response.status).toBe(202);
  }

  it('applies the second stop, and the turn it ends is closed', async () => {
    const task = seedTask({ status: 'running' });

    await deliver('stop', 0);
    expect(getLastStopEventAt(wtId, 'claude')).toBe(T);

    await deliver('user_prompt_submit', PROMPT_AFTER_MS);
    expect(getStructuredSessionState(wtId, 'claude')?.status).toBe('running');

    await deliver('stop', SECOND_STOP_AFTER_MS);

    expect(getLastStopEventAt(wtId, 'claude')).toBe(T + SECOND_STOP_AFTER_MS);
    expect(getStructuredSessionState(wtId, 'claude')?.status).toBe('ready');
    expect(listTaskEvents(db, task.id).map((event) => event.event)).toEqual([
      'agent_idle',
      'agent_idle',
    ]);
  });

  it('still drops the second stop when no turn started in between', async () => {
    // The control for the case above: same session, same two timestamps, and
    // the only thing missing is the turn start.
    const task = seedTask({ status: 'running' });

    await deliver('stop', 0);
    await deliver('stop', SECOND_STOP_AFTER_MS);

    expect(getLastStopEventAt(wtId, 'claude')).toBe(T);
    expect(listTaskEvents(db, task.id)).toHaveLength(1);
  });

  it('applies one stop per turn on a host that delivers every event twice (#1722)', async () => {
    const task = seedTask({ status: 'running' });

    await deliver('stop', 0);
    await deliver('stop', 20);
    await deliver('user_prompt_submit', PROMPT_AFTER_MS);
    await deliver('user_prompt_submit', PROMPT_AFTER_MS + 20);
    await deliver('stop', SECOND_STOP_AFTER_MS);
    await deliver('stop', SECOND_STOP_AFTER_MS + 20);

    // The 1st and the 5th delivery, and neither copy.
    expect(listTaskEvents(db, task.id)).toHaveLength(2);
    expect(getLastStopEventAt(wtId, 'claude')).toBe(T + SECOND_STOP_AFTER_MS);
    expect(getStructuredSessionState(wtId, 'claude')?.status).toBe('ready');
  });

  it('does the same for the tools whose turns are opened by a tool event', async () => {
    // Neither sends `user_prompt_submit` (`capabilities.supportedEvents`): the
    // first event this server sees of an antigravity turn is `post_tool_use`,
    // and of a Command Code turn `pre_tool_use`.
    const cases = [
      { tool: 'antigravity', event: 'post_tool_use', detail: 'run_command' },
      { tool: 'command-code', event: 'pre_tool_use', detail: 'Bash' },
    ] as const;

    for (const { tool, event, detail } of cases) {
      await deliver('stop', 0, { tool });
      await deliver(event, PROMPT_AFTER_MS, { tool, detail });
      expect(getStructuredSessionState(wtId, tool)?.status, tool).toBe('running');

      await deliver('stop', SECOND_STOP_AFTER_MS, { tool });

      expect(getLastStopEventAt(wtId, tool), tool).toBe(T + SECOND_STOP_AFTER_MS);
      expect(getStructuredSessionState(wtId, tool)?.status, tool).toBe('ready');
    }
  });
});

describe('a turn that began right after the previous one ended (Issue #3301)', () => {
  /**
   * The server log of 2026-10-04, a worker of Epic #3207: the
   * `UserPromptSubmit` of a turn a background task's completion notice opened,
   * that turn's `Stop` 2624 ms later, and the `UserPromptSubmit` of the next
   * notice's turn 22 ms after the `Stop`. The second start was logged
   * `agent-event-duplicate-dropped` — it is inside three seconds of the first —
   * and the server went on publishing `ready` for an agent that was working.
   */
  const T = 1_800_000_000_000;
  const STOP_AFTER_MS = 2624;
  const NEXT_START_AFTER_MS = 2646;
  const SESSION = 'sess-3301';

  afterEach(() => unfreezeClock());

  /** Deliver one event at `T + afterMs`, in the shape the relay script posts. */
  async function deliver(
    event: string,
    afterMs: number,
    extra: { tool?: string; detail?: string } = {}
  ) {
    freezeClock(T + afterMs);
    const response = await postEvent({
      tool: 'claude',
      event,
      cwd: repo,
      sessionId: SESSION,
      ...extra,
    });
    expect(response.status).toBe(202);
  }

  it('applies the second start, and the turn it begins is open', async () => {
    const task = seedTask({ status: 'running' });

    await deliver('user_prompt_submit', 0);
    const first = getAgentTurn(wtId, 'claude');
    expect(first?.openedAt).toBe(T);

    await deliver('stop', STOP_AFTER_MS);
    expect(getStructuredSessionState(wtId, 'claude')?.status).toBe('ready');

    await deliver('user_prompt_submit', NEXT_START_AFTER_MS);

    const second = getAgentTurn(wtId, 'claude');
    expect(second?.openedAt).toBe(T + NEXT_START_AFTER_MS);
    expect(second?.closedAt).toBeNull();
    expect(second?.turnId).not.toBe(first?.turnId);
    expect(getStructuredSessionState(wtId, 'claude')?.status).toBe('running');

    // And that turn's stop closes it, inside three seconds of the previous one.
    await deliver('stop', NEXT_START_AFTER_MS + 1000);

    expect(getLastStopEventAt(wtId, 'claude')).toBe(T + NEXT_START_AFTER_MS + 1000);
    expect(getStructuredSessionState(wtId, 'claude')?.status).toBe('ready');
    expect(listTaskEvents(db, task.id).map((event) => event.event)).toEqual([
      'agent_idle',
      'agent_idle',
    ]);
  });

  it('still counts a burst of starts as one turn start', async () => {
    // The control for the case above. 2026-10-02T15:52:09.896Z / .900Z / .905Z:
    // Claude Code attached three queued notices to a running turn and fired
    // `UserPromptSubmit` for each. A `user_prompt_submit` that is applied opens
    // a new turn, so two more of them would have re-opened it twice.
    await deliver('user_prompt_submit', 0);
    const opened = getAgentTurn(wtId, 'claude');

    await deliver('user_prompt_submit', 4);
    await deliver('user_prompt_submit', 9);

    const turn = getAgentTurn(wtId, 'claude');
    expect(turn?.turnId).toBe(opened?.turnId);
    expect(turn?.openedAt).toBe(T);
    expect(getStructuredSessionState(wtId, 'claude')?.status).toBe('running');
  });

  it('applies one start and one stop per turn on a host that delivers every event twice (#1722)', async () => {
    const task = seedTask({ status: 'running' });

    await deliver('user_prompt_submit', 0);
    await deliver('user_prompt_submit', 20);
    await deliver('stop', STOP_AFTER_MS);
    await deliver('stop', STOP_AFTER_MS + 20);
    await deliver('user_prompt_submit', NEXT_START_AFTER_MS);
    await deliver('user_prompt_submit', NEXT_START_AFTER_MS + 20);

    // The 5th delivery opened the turn, and its copy did not open another.
    expect(getAgentTurn(wtId, 'claude')?.openedAt).toBe(T + NEXT_START_AFTER_MS);
    expect(getStructuredSessionState(wtId, 'claude')?.status).toBe('running');

    await deliver('stop', NEXT_START_AFTER_MS + 1000);
    await deliver('stop', NEXT_START_AFTER_MS + 1020);

    // The 3rd and the 7th delivery, and neither copy.
    expect(listTaskEvents(db, task.id)).toHaveLength(2);
    expect(getLastStopEventAt(wtId, 'claude')).toBe(T + NEXT_START_AFTER_MS + 1000);
    expect(getStructuredSessionState(wtId, 'claude')?.status).toBe('ready');
  });

  it('does the same for the tools whose turns are opened by a tool event', async () => {
    // Neither sends `user_prompt_submit` (`capabilities.supportedEvents`), and
    // a short turn of either can call the one tool the previous turn called.
    const cases = [
      { tool: 'antigravity', event: 'post_tool_use', detail: 'run_command' },
      { tool: 'command-code', event: 'pre_tool_use', detail: 'Bash' },
    ] as const;

    for (const { tool, event, detail } of cases) {
      await deliver(event, 0, { tool, detail });
      await deliver('stop', STOP_AFTER_MS, { tool });
      expect(getStructuredSessionState(wtId, tool)?.status, tool).toBe('ready');

      await deliver(event, NEXT_START_AFTER_MS, { tool, detail });

      expect(getAgentTurn(wtId, tool)?.openedAt, tool).toBe(T + NEXT_START_AFTER_MS);
      expect(getStructuredSessionState(wtId, tool)?.status, tool).toBe('running');
    }
  });
});

describe('a queued notice delivered into a running turn (Issue #3330)', () => {
  /**
   * The shape the injected `type: "http"` hook posts: Claude's own payload,
   * prompt included. In the server logs of 2026-10-02 to 2026-10-05, 178
   * deliveries like the second one below arrived with the turn still open, a
   * median of 63.5 s after it opened, each matched by a
   * `queue-operation: remove` of a `<task-notification>` in the transcript.
   * Applying one re-opened the turn under a new id.
   */
  const T = 1_800_000_000_000;
  const NOTICE_AFTER_MS = 63_500;
  const STOP_AFTER_MS = 90_000;
  const SESSION = 'sess-3330';
  const NOTICE = '<task-notification>\n<status>completed</status>\n</task-notification>';

  afterEach(() => unfreezeClock());

  async function deliver(hookEventName: string, afterMs: number, prompt?: string) {
    freezeClock(T + afterMs);
    const response = await postEvent({
      tool: 'claude',
      hook_event_name: hookEventName,
      cwd: repo,
      session_id: SESSION,
      ...(prompt === undefined ? {} : { prompt }),
    });
    expect(response.status).toBe(202);
  }

  it('keeps the turn open under its id, and that turn’s stop closes it', async () => {
    const task = seedTask({ status: 'running' });

    await deliver('UserPromptSubmit', 0, 'Implement the change');
    const opened = getAgentTurn(wtId, 'claude');
    expect(opened?.openedAt).toBe(T);

    await deliver('UserPromptSubmit', NOTICE_AFTER_MS, NOTICE);

    const joined = getAgentTurn(wtId, 'claude');
    expect(joined?.turnId).toBe(opened?.turnId);
    expect(joined?.openedAt).toBe(T);
    expect(joined?.closedAt).toBeNull();
    expect(getStructuredSessionState(wtId, 'claude')?.status).toBe('running');
    // What `wait` reads (`turnSettled`): no stop at or after the turn it adopted.
    expect(getLastStopEventAt(wtId, 'claude')).toBeNull();

    await deliver('Stop', STOP_AFTER_MS);

    const closed = getAgentTurn(wtId, 'claude');
    expect(closed?.turnId).toBe(opened?.turnId);
    expect(closed?.closedBy).toBe('stop');
    expect(getLastStopEventAt(wtId, 'claude')).toBe(T + STOP_AFTER_MS);
    expect(getLastStopEventAt(wtId, 'claude')).toBeGreaterThanOrEqual(closed?.openedAt ?? Infinity);
    expect(getStructuredSessionState(wtId, 'claude')?.status).toBe('ready');
    expect(listTaskEvents(db, task.id).map((event) => event.event)).toEqual(['agent_idle']);
  });

  it('opens a new turn for a prompt that is not a notice (control: interrupt and resend)', async () => {
    await deliver('UserPromptSubmit', 0, 'Implement the change');
    const opened = getAgentTurn(wtId, 'claude');

    await deliver('UserPromptSubmit', NOTICE_AFTER_MS, 'Actually, do it differently');

    const resent = getAgentTurn(wtId, 'claude');
    expect(resent?.turnId).not.toBe(opened?.turnId);
    expect(resent?.openedAt).toBe(T + NOTICE_AFTER_MS);
  });

  it('opens a new turn for a notice that arrives after the turn ended (#3289)', async () => {
    await deliver('UserPromptSubmit', 0, 'Implement the change');
    const first = getAgentTurn(wtId, 'claude');
    await deliver('Stop', 2_000);
    await deliver('UserPromptSubmit', 2_540, NOTICE);

    const resumed = getAgentTurn(wtId, 'claude');
    expect(resumed?.turnId).not.toBe(first?.turnId);
    expect(resumed?.openedAt).toBe(T + 2_540);
    expect(getStructuredSessionState(wtId, 'claude')?.status).toBe('running');
  });

  it('leaves the relay script’s prompt-less shape as it was', async () => {
    // `scripts/hooks/cmate-agent-event.sh` rebuilds the body and drops the
    // prompt, so nothing it posts can be told apart, and every prompt opens a
    // turn as before this Issue.
    await deliver('UserPromptSubmit', 0);
    const opened = getAgentTurn(wtId, 'claude');
    await deliver('UserPromptSubmit', NOTICE_AFTER_MS);

    expect(getAgentTurn(wtId, 'claude')?.turnId).not.toBe(opened?.turnId);
  });

  it('does not read a notice into another tool’s prompt', async () => {
    // Only a source that declares `promptJoinsOpenTurn` marks anything.
    freezeClock(T);
    await postEvent({ tool: 'codex', hook_event_name: 'UserPromptSubmit', cwd: repo, session_id: SESSION, prompt: 'go' });
    const opened = getAgentTurn(wtId, 'codex');
    freezeClock(T + NOTICE_AFTER_MS);
    await postEvent({ tool: 'codex', hook_event_name: 'UserPromptSubmit', cwd: repo, session_id: SESSION, prompt: NOTICE });

    expect(getAgentTurn(wtId, 'codex')?.turnId).not.toBe(opened?.turnId);
  });
});

describe('a queued notice delivered twice, by the injected hook and a relay (Issue #3330)', () => {
  /**
   * A host with the #1549 manual relay beside the injected `type: "http"` hook
   * posts every `UserPromptSubmit` twice, milliseconds apart and under one
   * de-duplication key. The relay's body carries no prompt; a current relay
   * says `queuedNotice: true` instead, an older one says nothing. Whichever
   * copy lands first is applied and the second is dropped, and the turn must
   * not move in either order.
   */
  const T = 1_800_000_000_000;
  const NOTICE_AFTER_MS = 63_500;
  const SESSION = 'sess-3330-twice';
  const NOTICE = '<task-notification>\n<status>completed</status>\n</task-notification>';

  afterEach(() => unfreezeClock());

  /** The injected hook: Claude's own payload. */
  async function http(afterMs: number, prompt: string) {
    freezeClock(T + afterMs);
    const response = await postEvent({
      tool: 'claude',
      hook_event_name: 'UserPromptSubmit',
      cwd: repo,
      session_id: SESSION,
      prompt,
    });
    expect(response.status).toBe(202);
  }

  /** The relay script's rebuilt body. */
  async function relay(afterMs: number, queuedNotice?: boolean) {
    freezeClock(T + afterMs);
    const response = await postEvent({
      tool: 'claude',
      event: 'user_prompt_submit',
      cwd: repo,
      sessionId: SESSION,
      ...(queuedNotice === undefined ? {} : { queuedNotice }),
    });
    expect(response.status).toBe(202);
  }

  async function openTurn() {
    await http(0, 'Implement the change');
    await relay(8);
    const opened = getAgentTurn(wtId, 'claude');
    expect(opened?.openedAt).toBe(T);
    return opened;
  }

  const orders = [
    { name: 'relay first, then the injected hook', first: 'relay', second: 'http' },
    { name: 'the injected hook first, then the relay', first: 'http', second: 'relay' },
  ] as const;

  for (const { name, first, second } of orders) {
    it(`keeps the turn for a notice: ${name}`, async () => {
      const task = seedTask({ status: 'running' });
      const opened = await openTurn();

      const deliver = (kind: 'relay' | 'http', afterMs: number) =>
        kind === 'relay' ? relay(afterMs, true) : http(afterMs, NOTICE);
      await deliver(first, NOTICE_AFTER_MS);
      await deliver(second, NOTICE_AFTER_MS + 6);

      const turn = getAgentTurn(wtId, 'claude');
      expect(turn?.turnId).toBe(opened?.turnId);
      expect(turn?.openedAt).toBe(T);
      expect(turn?.closedAt).toBeNull();

      freezeClock(T + 90_000);
      await postEvent({ tool: 'claude', hook_event_name: 'Stop', cwd: repo, session_id: SESSION });
      expect(getAgentTurn(wtId, 'claude')?.turnId).toBe(opened?.turnId);
      expect(getAgentTurn(wtId, 'claude')?.closedBy).toBe('stop');
      expect(listTaskEvents(db, task.id)).toHaveLength(1);
    });
  }

  it('keeps the turn on a host with the relay alone, from its queuedNotice flag', async () => {
    // No injected hook to fall back on: the flag is the only thing that says
    // this prompt is a notice.
    await relay(0);
    const opened = getAgentTurn(wtId, 'claude');
    await relay(NOTICE_AFTER_MS, true);

    expect(getAgentTurn(wtId, 'claude')?.turnId).toBe(opened?.turnId);
    expect(getAgentTurn(wtId, 'claude')?.openedAt).toBe(T);

    // Control: the same relay with no flag re-opens it, as before.
    await relay(NOTICE_AFTER_MS + 30_000);
    expect(getAgentTurn(wtId, 'claude')?.turnId).not.toBe(opened?.turnId);
  });

  it('keeps the turn when an older relay with no flag lands first and the marked hook is dropped', async () => {
    const opened = await openTurn();

    await relay(NOTICE_AFTER_MS);
    // The unmarked copy was applied and re-opened the turn …
    expect(getAgentTurn(wtId, 'claude')?.turnId).not.toBe(opened?.turnId);

    // … and the marked copy, dropped as its duplicate, puts it back.
    await http(NOTICE_AFTER_MS + 6, NOTICE);

    const turn = getAgentTurn(wtId, 'claude');
    expect(turn?.turnId).toBe(opened?.turnId);
    expect(turn?.openedAt).toBe(T);
    expect(turn?.closedAt).toBeNull();
    expect(getStructuredSessionState(wtId, 'claude')?.status).toBe('running');
  });

  it('opens a new turn for a prompt that is not a notice, in either order (control)', async () => {
    for (const relayFirst of [true, false]) {
      clearAgentStopEvents();
      const opened = await openTurn();
      const at = NOTICE_AFTER_MS;
      if (relayFirst) {
        await relay(at);
        await http(at + 6, 'Actually, do it differently');
      } else {
        await http(at, 'Actually, do it differently');
        await relay(at + 6);
      }

      const turn = getAgentTurn(wtId, 'claude');
      expect(turn?.turnId, `relayFirst=${relayFirst}`).not.toBe(opened?.turnId);
      expect(turn?.openedAt, `relayFirst=${relayFirst}`).toBe(T + at);
    }
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
