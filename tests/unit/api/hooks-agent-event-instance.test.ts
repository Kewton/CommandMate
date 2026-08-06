/**
 * POST /api/hooks/agent-event — instance correlation and the widened event
 * vocabulary (Issue #1722).
 *
 * `hooks-agent-event.test.ts` is the #1549 contract and is deliberately left
 * untouched: it passing unchanged is the proof that a hand-configured hook
 * still behaves exactly as it did. This file covers what #1722 adds, and does
 * it with the payloads Claude Code actually sends — `tests/fixtures/hooks/
 * claude/*.json`, captured from a live v2.1.223 session in #1721 — rather than
 * with bodies invented to match the parser. An injected `type: "http"` hook
 * cannot shape its body, so those payloads *are* the wire format.
 *
 * Nothing below the route is mocked: real SQLite, real worktrees on disk.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { createTask, listTaskEvents, upsertWorktree, type Task, type TaskStatus } from '@/lib/db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';
import {
  clearAgentStopEvents,
  getLastAgentEvent,
  getLastStopEventAt,
} from '@/lib/session/agent-event-state';
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

const FIXTURE_DIR = join(process.cwd(), 'tests/fixtures/hooks/claude');

let db: Database.Database;
let repo: string;
const wtId = 'wt-instance';
const tempDirs: string[] = [];

const asReq = (req: Request) => req as unknown as NextRequest;

/**
 * A captured payload with its placeholders filled in.
 *
 * Only `<CWD>` and `session_id` are substituted — everything else is left as it
 * arrived, so a field the route starts depending on is a field a real session
 * really sends.
 */
function claudePayload(
  name: string,
  overrides: { cwd?: string; sessionId?: string } = {}
): Record<string, unknown> {
  const payload = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
  payload.cwd = overrides.cwd ?? repo;
  if (overrides.sessionId !== undefined) payload.session_id = overrides.sessionId;
  return payload;
}

function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-event-instance-')));
  tempDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function seedTask(options: { instanceId: string | null; status?: TaskStatus }): Task {
  return createTask(db, {
    worktreeId: wtId,
    cliToolId: 'claude',
    instanceId: options.instanceId,
    contractPath: '.commandmate/tasks/t.yaml',
    contract: parseTaskContract(
      `version: 1
title: hook contract
goal: do the work
scope:
  allow: ["**"]
`,
      'task.yaml'
    ),
    status: options.status ?? 'running',
  });
}

/** POST, with correlation supplied the way an injected hook supplies it: in the URL. */
async function post(
  body: unknown,
  query: Record<string, string> = {}
): Promise<Response> {
  const { POST } = await import('@/app/api/hooks/agent-event/route');
  const search = new URLSearchParams(query).toString();
  return POST(
    asReq(
      new Request(`http://localhost/api/hooks/agent-event${search ? `?${search}` : ''}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  );
}

const injected = (instanceId: string) => ({ tool: 'claude', worktreeId: wtId, instanceId });

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAgentStopEvents();

  repo = createRepo();
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

describe("Claude Code's own payload shape", () => {
  it('accepts every captured lifecycle payload and files it under the right event', async () => {
    const expected: Record<string, string> = {
      'session-start.json': 'session_start',
      'session-start-clear.json': 'session_start',
      'user-prompt-submit.json': 'user_prompt_submit',
      'stop.json': 'stop',
      'notification-permission-prompt.json': 'notification',
      'notification-idle-prompt.json': 'notification',
      'session-end.json': 'session_end',
      'session-end-clear.json': 'session_end',
    };

    for (const [name, event] of Object.entries(expected)) {
      clearAgentStopEvents();
      const response = await post(claudePayload(name), {
        tool: 'claude',
        worktreeId: wtId,
        instanceId: 'claude',
      });

      expect(response.status, `${name} rejected`).toBe(202);
      expect(getLastAgentEvent(wtId, 'claude')?.event, name).toBe(event);
    }
  });

  it('covers every lifecycle fixture on disk, so a new capture cannot be forgotten', () => {
    const observed = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')).hook_event_name);

    // The two that are out of scope are named so their absence is a decision.
    expect(new Set(observed)).toEqual(
      new Set([
        'SessionStart',
        'UserPromptSubmit',
        'Stop',
        'Notification',
        'SessionEnd',
        'PermissionRequest',
        'PreToolUse',
      ])
    );
  });

  it('refuses a decision-bearing event rather than filing it as something else', async () => {
    for (const name of ['pre-tool-use-bash.json', 'permission-request.json']) {
      const response = await post(claudePayload(name), { tool: 'claude', worktreeId: wtId });
      expect(response.status, name).toBe(400);
    }
  });

  it('records the notification subtype from notification_type, not from message', async () => {
    // The matcher and every downstream reader key on notification_type; the
    // `message` field is English prose written for a human.
    await post(claudePayload('notification-permission-prompt.json'), injected('claude'));
    expect(getLastAgentEvent(wtId, 'claude')?.detail).toBe('permission_prompt');

    clearAgentStopEvents();
    await post(claudePayload('notification-idle-prompt.json'), injected('claude'));
    expect(getLastAgentEvent(wtId, 'claude')?.detail).toBe('idle_prompt');
  });

  it('records the reason a session ended and the source it started from', async () => {
    await post(claudePayload('session-end-clear.json'), injected('claude'));
    expect(getLastAgentEvent(wtId, 'claude')?.detail).toBe('clear');

    await post(claudePayload('session-start-clear.json'), injected('claude'));
    expect(getLastAgentEvent(wtId, 'claude')?.detail).toBe('clear');
  });

  it('applies a Stop payload to the task, exactly as the relay shape does', async () => {
    const task = seedTask({ instanceId: null });

    expect((await post(claudePayload('stop.json'), injected('claude'))).status).toBe(202);

    expect(listTaskEvents(db, task.id).map((e) => e.event)).toEqual(['agent_idle']);
  });
});

describe('instance correlation', () => {
  it('moves the non-primary instance task and leaves the primary alone', async () => {
    // Before #1722 the route applied every event to the primary instance,
    // because cwd is identical for both. Both tasks are seeded so the assertion
    // cannot pass by nothing happening at all.
    const primary = seedTask({ instanceId: null });
    const second = seedTask({ instanceId: 'claude-2' });

    expect((await post(claudePayload('stop.json'), injected('claude-2'))).status).toBe(202);

    expect(listTaskEvents(db, second.id).map((e) => e.event)).toEqual(['agent_idle']);
    expect(listTaskEvents(db, primary.id)).toHaveLength(0);
    expect(getLastStopEventAt(wtId, 'claude', 'claude-2')).not.toBeNull();
    expect(getLastStopEventAt(wtId, 'claude')).toBeNull();
  });

  it('still lands on the primary when no instance is named (backward compatible)', async () => {
    const primary = seedTask({ instanceId: null });
    const second = seedTask({ instanceId: 'claude-2' });

    await post({ tool: 'claude', event: 'stop', cwd: repo });

    expect(listTaskEvents(db, primary.id).map((e) => e.event)).toEqual(['agent_idle']);
    expect(listTaskEvents(db, second.id)).toHaveLength(0);
  });

  it('accepts the correlation keys from the body as well as the URL', async () => {
    // The relay script sends them in the body; an http hook can only send them
    // in the URL. Both have to reach the same place.
    const second = seedTask({ instanceId: 'claude-2' });

    await post({ tool: 'claude', event: 'stop', cwd: repo, worktreeId: wtId, instanceId: 'claude-2' });

    expect(listTaskEvents(db, second.id).map((e) => e.event)).toEqual(['agent_idle']);
  });

  it('rejects an unsafe instance id', async () => {
    for (const instanceId of ['claude 2', 'claude/../2', 'a'.repeat(65), 'x;rm -rf /']) {
      const response = await post(claudePayload('stop.json'), {
        tool: 'claude',
        worktreeId: wtId,
        instanceId,
      });
      expect(response.status, instanceId).toBe(400);
      expect((await response.json()).error).toContain('instanceId');
    }
  });

  it('resolves by worktree id without needing a resolvable cwd', async () => {
    // The whole point of baking the id into the URL: a worktree whose path has
    // moved, or an agent reporting a directory the server cannot stat, still
    // correlates.
    const task = seedTask({ instanceId: null });

    const response = await post(claudePayload('stop.json', { cwd: '/no/such/directory' }), {
      tool: 'claude',
      worktreeId: wtId,
      instanceId: 'claude',
    });

    expect(response.status).toBe(202);
    expect(listTaskEvents(db, task.id)).toHaveLength(1);
  });

  it('answers an unknown worktree id with the accepted body, revealing nothing', async () => {
    const known = await post(claudePayload('stop.json'), injected('claude'));
    const unknown = await post(claudePayload('stop.json'), {
      tool: 'claude',
      worktreeId: 'wt-does-not-exist',
    });

    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toEqual(await known.json());
  });

  it('still rejects a malformed cwd when one is sent alongside a worktree id', async () => {
    const response = await post(claudePayload('stop.json', { cwd: `${repo}/src/../src` }), {
      tool: 'claude',
      worktreeId: wtId,
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('traversal');
  });

  it('takes the tool from the URL when the body has none, and prefers the body', async () => {
    expect((await post(claudePayload('stop.json'), { tool: 'claude', worktreeId: wtId })).status)
      .toBe(202);
    expect((await post(claudePayload('stop.json'), { worktreeId: wtId })).status).toBe(400);
    expect(
      (await post({ tool: 'codex', event: 'stop', cwd: repo }, { tool: 'claude' })).status
    ).toBe(202);
    expect(getLastStopEventAt(wtId, 'codex')).not.toBeNull();
  });
});

describe('double delivery', () => {
  /**
   * `--settings` hooks are concatenated with `~/.claude/settings.json`, not
   * substituted for it, so anyone who followed the #1549 manual setup now has
   * two Stop hooks reporting the same turn. `applyAgentStopEvent` is idempotent
   * for the timestamp but `applyTaskEvent` is not: two deliveries would write
   * two `agent_idle` rows and make one turn look like two.
   */
  it('writes one agent_idle row when the same turn is reported twice', async () => {
    const task = seedTask({ instanceId: null });
    const payload = claudePayload('stop.json', { sessionId: 'sess-dup' });

    expect((await post(payload, injected('claude'))).status).toBe(202);
    expect((await post(payload, injected('claude'))).status).toBe(202);

    expect(listTaskEvents(db, task.id)).toHaveLength(1);
  });

  it('does not collapse two genuine turns, which carry different session ids', async () => {
    const task = seedTask({ instanceId: null });

    await post(claudePayload('stop.json', { sessionId: 'sess-a' }), injected('claude'));
    await post(claudePayload('stop.json', { sessionId: 'sess-b' }), injected('claude'));

    expect(listTaskEvents(db, task.id)).toHaveLength(2);
  });

  it('does not collapse the same session reporting two different events', async () => {
    await post(claudePayload('user-prompt-submit.json', { sessionId: 'sess-c' }), injected('claude'));
    await post(claudePayload('stop.json', { sessionId: 'sess-c' }), injected('claude'));

    expect(getLastAgentEvent(wtId, 'claude')?.event).toBe('stop');
    expect(getLastStopEventAt(wtId, 'claude')).not.toBeNull();
  });

  it('does not collapse the same session id reported by two instances', async () => {
    const primary = seedTask({ instanceId: null });
    const second = seedTask({ instanceId: 'claude-2' });
    const payload = claudePayload('stop.json', { sessionId: 'sess-shared' });

    await post(payload, injected('claude'));
    await post(payload, injected('claude-2'));

    expect(listTaskEvents(db, primary.id)).toHaveLength(1);
    expect(listTaskEvents(db, second.id)).toHaveLength(1);
  });

  it('never suppresses an event that carries no session id', async () => {
    // A caller with no session id has given us nothing to tell two deliveries
    // of one turn from two genuine turns, so suppressing there would silently
    // drop real events. The #1549 relay run without a hook payload does this.
    const task = seedTask({ instanceId: null });

    await post({ tool: 'claude', event: 'stop', cwd: repo });
    await post({ tool: 'claude', event: 'stop', cwd: repo });

    expect(listTaskEvents(db, task.id)).toHaveLength(2);
  });
});

describe('event vocabulary', () => {
  it('accepts the two new event names in the relay body shape', async () => {
    for (const event of ['user_prompt_submit', 'session_end']) {
      const response = await post({ tool: 'claude', event, cwd: repo });
      expect(response.status, event).toBe(202);
      expect(getLastAgentEvent(wtId, 'claude')?.event).toBe(event);
    }
  });

  it('changes no task state for anything but stop', async () => {
    // Issue #1722 is observation only. Wiring these into sessionStatus / wait /
    // Auto-Yes is #1723, and a task row appearing here would mean it leaked in.
    const task = seedTask({ instanceId: null });

    for (const name of [
      'session-start.json',
      'user-prompt-submit.json',
      'notification-idle-prompt.json',
      'session-end.json',
    ]) {
      await post(claudePayload(name), injected('claude'));
    }

    expect(listTaskEvents(db, task.id)).toHaveLength(0);
    expect(getLastStopEventAt(wtId, 'claude')).toBeNull();

    // Control: the same wiring does record when the event is a stop.
    await post(claudePayload('stop.json'), injected('claude'));
    expect(listTaskEvents(db, task.id)).toHaveLength(1);
  });

  it('does not use session_id as the instance key across a /clear', async () => {
    // `/clear` fires SessionEnd(clear) then SessionStart(clear) with a *new*
    // session_id while the pane, the worktree and the instance are unchanged.
    // Correlation therefore has to survive the id changing under it.
    const task = seedTask({ instanceId: 'claude-2' });

    await post(claudePayload('session-end-clear.json', { sessionId: 'before' }), injected('claude-2'));
    await post(claudePayload('session-start-clear.json', { sessionId: 'after' }), injected('claude-2'));
    await post(claudePayload('stop.json', { sessionId: 'after' }), injected('claude-2'));

    expect(listTaskEvents(db, task.id).map((e) => e.event)).toEqual(['agent_idle']);
    expect(getLastAgentEvent(wtId, 'claude', 'claude-2')?.sessionId).toBe('after');
  });
});
