/**
 * Issue #2363, end to end inside the process: a real `PostModelSwitch` payload
 * posted to `POST /api/hooks/agent-event` the way the injected hook posts it,
 * and `GET /api/worktrees/:id` reporting the new model under
 * `sessionStatusByInstance.claude.model`.
 *
 * The payloads are what claude 2.1.263 delivered to a CommandMate-shaped
 * `type: "http"` hook on 2026-09-06
 * (`tests/fixtures/hooks/claude-model-switch-2363/README.md`). Only the two
 * things that would leave the process are mocked (tmux, git); the route, the
 * source, the state machine and the status helper are the real ones.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import {
  clearAgentStopEvents,
  getLastAgentEvent,
  getLastKnownAgentModel,
  getResolvedAgentModelInfo,
  onAgentModelChange,
  type AgentModelChange,
} from '@/lib/session/agent-event-state';
import { modelSwitchDetail } from '@/lib/hooks/sources/claude/model-switch';
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

vi.mock('@/lib/tmux/tmux', () => ({
  listSessions: vi.fn(async () => [] as Array<{ name: string }>),
}));

vi.mock('@/lib/git/git-utils', () => ({
  getGitStatus: vi.fn(async () => undefined),
}));

const CLAUDE_FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/claude');
const SWITCH_FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/claude-model-switch-2363');

let db: Database.Database;
let repo: string;
const wtId = 'wt-model-switch-2363';
const tempDirs: string[] = [];
const unsubscribers: Array<() => void> = [];

const asReq = (req: Request) => req as unknown as NextRequest;

function payload(dir: string, name: string, sessionId?: string): Record<string, unknown> {
  const body = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  body.cwd = repo;
  if (sessionId !== undefined) body.session_id = sessionId;
  return body;
}

/** The URL the injected `--settings` file carries, query and all. */
const injected = (instanceId = 'claude', tool = 'claude') => ({ tool, worktreeId: wtId, instanceId });

async function postHook(body: unknown, query: Record<string, string>): Promise<Response> {
  const { POST } = await import('@/app/api/hooks/agent-event/route');
  return POST(
    asReq(
      new Request(`http://localhost/api/hooks/agent-event?${new URLSearchParams(query)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  );
}

type WorktreeResponse = {
  sessionStatusByInstance?: Record<string, { model?: string | null; isRunning: boolean }>;
};

async function getWorktree(): Promise<WorktreeResponse> {
  const { GET } = await import('@/app/api/worktrees/[id]/route');
  const response = await GET(asReq(new Request(`http://localhost/api/worktrees/${wtId}`)), {
    params: Promise.resolve({ id: wtId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as WorktreeResponse;
}

const publishedModel = async () => (await getWorktree()).sessionStatusByInstance?.claude?.model;

function listen(): AgentModelChange[] {
  const changes: AgentModelChange[] = [];
  unsubscribers.push(onAgentModelChange((change) => changes.push(change)));
  return changes;
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAgentStopEvents();

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'model-switch-2363-')));
  tempDirs.push(repo);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });

  upsertWorktree(db, {
    id: wtId,
    name: 'feature/2363',
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
  });
});

afterEach(async () => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  clearAgentStopEvents();
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('PostModelSwitch → sessionStatusByInstance.claude.model (Issue #2363)', () => {
  it('`/model sonnet` after SessionStart(Haiku): the API reports claude-sonnet-5', async () => {
    const changes = listen();
    const start = payload(CLAUDE_FIXTURES, 'session-start.json');
    start.model = 'claude-haiku-4-5-20251001';
    expect((await postHook(start, injected())).status).toBe(202);
    expect(await publishedModel()).toBe('claude-haiku-4-5-20251001');

    const response = await postHook(payload(SWITCH_FIXTURES, 'post-model-switch-command.json'), injected());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });

    expect(getLastKnownAgentModel(wtId, 'claude', 'claude')).toBe('claude-sonnet-5');
    expect(await publishedModel()).toBe('claude-sonnet-5');
    expect(getLastAgentEvent(wtId, 'claude', 'claude')).toMatchObject({
      event: 'notification',
      detail: modelSwitchDetail('claude-sonnet-5'),
      model: 'claude-sonnet-5',
    });
    // #2357's edge, once, from the hook.
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      worktreeId: wtId,
      cliToolId: 'claude',
      instanceId: 'claude',
      from: 'claude-haiku-4-5-20251001',
      to: 'claude-sonnet-5',
      source: 'hook',
    });
  });

  it('`/fast` reports claude-opus-5[1m], the same spelling SessionStart uses', async () => {
    const changes = listen();
    const start = payload(CLAUDE_FIXTURES, 'session-start.json');
    start.model = 'claude-haiku-4-5-20251001';
    await postHook(start, injected());

    expect(
      (await postHook(payload(SWITCH_FIXTURES, 'post-model-switch-fast-on.json'), injected())).status
    ).toBe(202);
    expect(await publishedModel()).toBe('claude-opus-5[1m]');
    expect(changes.map((c) => [c.from, c.to])).toEqual([
      ['claude-haiku-4-5-20251001', 'claude-opus-5[1m]'],
    ]);
  });

  it('a chain of switches inside one dedup window lands each one, and the events between keep the last', async () => {
    // All of these arrive within milliseconds on one session_id — inside the
    // receiver's 3 s de-duplication window. Each switch names a different
    // target, and the subtype carries it, so none is dropped as a repeat.
    await postHook(payload(CLAUDE_FIXTURES, 'session-start.json'), injected());
    expect(await publishedModel()).toBe('claude-opus-5[1m]');

    await postHook(payload(SWITCH_FIXTURES, 'post-model-switch-command.json'), injected());
    expect(await publishedModel()).toBe('claude-sonnet-5');

    // Events without a model do not blank it (the #1783 latch).
    await postHook(payload(CLAUDE_FIXTURES, 'user-prompt-submit.json'), injected());
    await postHook(payload(CLAUDE_FIXTURES, 'stop.json'), injected());
    expect(await publishedModel()).toBe('claude-sonnet-5');

    await postHook(payload(SWITCH_FIXTURES, 'post-model-switch-picker.json'), injected());
    expect(await publishedModel()).toBe('claude-haiku-4-5-20251001');

    await postHook(payload(SWITCH_FIXTURES, 'post-model-switch-default.json'), injected());
    expect(await publishedModel()).toBe('claude-opus-5[1m]');
  });

  it('a second delivery of the same switch inside the window is dropped, not a second edge', async () => {
    const changes = listen();
    await postHook(payload(CLAUDE_FIXTURES, 'session-start.json'), injected());
    const first = await postHook(payload(SWITCH_FIXTURES, 'post-model-switch-command.json'), injected());
    const second = await postHook(payload(SWITCH_FIXTURES, 'post-model-switch-command.json'), injected());
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await publishedModel()).toBe('claude-sonnet-5');
    expect(changes).toHaveLength(1);
  });

  it('keeps alias instances apart', async () => {
    await postHook(payload(CLAUDE_FIXTURES, 'session-start.json'), injected('claude'));
    await postHook(payload(CLAUDE_FIXTURES, 'session-start.json'), injected('claude-2'));
    await postHook(payload(SWITCH_FIXTURES, 'post-model-switch-command.json'), injected('claude-2'));

    // The primary instance is untouched by the alias's switch. The alias is
    // only published once it is on the roster, so it is read off the store —
    // keyed by the id the injected URL carried.
    expect(await publishedModel()).toBe('claude-opus-5[1m]');
    expect(getResolvedAgentModelInfo(wtId, 'claude', 'claude').model).toBe('claude-opus-5[1m]');
    expect(getResolvedAgentModelInfo(wtId, 'claude', 'claude-2').model).toBe('claude-sonnet-5');
  });

  it('never publishes from_model (a switch that names no to_model changes nothing)', async () => {
    await postHook(payload(CLAUDE_FIXTURES, 'session-start.json'), injected());
    const body = payload(SWITCH_FIXTURES, 'post-model-switch-command.json');
    delete body.to_model;
    expect((await postHook(body, injected())).status).toBe(202);
    expect(await publishedModel()).toBe('claude-opus-5[1m]');
    expect(getLastKnownAgentModel(wtId, 'claude', 'claude')).not.toBe(body.from_model);
  });
});

describe('what the route refuses (Issue #2363)', () => {
  it('PreModelSwitch is not a lifecycle event', async () => {
    const response = await postHook(
      payload(SWITCH_FIXTURES, 'pre-model-switch-fast-on-second.json'),
      injected()
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'hook_event_name is not a lifecycle event: PreModelSwitch',
    });
    expect(getLastKnownAgentModel(wtId, 'claude', 'claude')).toBeNull();
  });

  it('the same payload addressed to another tool is refused: only claude speaks it', async () => {
    for (const tool of ['codex', 'copilot'] as const) {
      const response = await postHook(
        payload(SWITCH_FIXTURES, 'post-model-switch-command.json'),
        injected(tool, tool)
      );
      expect(response.status, tool).toBe(400);
      expect(getLastKnownAgentModel(wtId, tool, tool), tool).toBeNull();
    }
  });
});
