/**
 * A `SessionStart` the hook intake accepts expires Auto-Yes's Enter record
 * (Issue #3397, review round 3).
 *
 * `/clear`, or `claude` relaunched by hand inside the pane, opens a new
 * generation in `recordAgentEvent` without `beginAgentSession` ever running.
 * The record of the Enter sent to the previous process's screen must go with
 * it — and only for a `SessionStart` that is applied: a late one (#1903) or a
 * duplicate the intake drops must leave the live process's record alone.
 * Harness copied from `late-session-start-1903.test.ts`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { CLIToolType } from '@/lib/cli-tools/types';
import {
  clearAgentStopEvents,
  getAgentEventGenerationStartedAt,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';
import {
  clearEnterFallbacks,
  getEnterFallbackSessionEpoch,
  getLastEnterFallback,
  recordEnterFallbackSent,
} from '@/lib/polling/auto-yes-enter-fallback';
import { buildCompositeKey } from '@/lib/auto-yes-state';
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

const WORKTREE_ID = 'wt-3397-ss';
const COPILOT_FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/copilot');
const CLAUDE_FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/claude');

/** A second agent session — what a genuine relaunch inside the pane looks like. */
const SESSION_B = '11111111-1111-4111-8111-111111111111';

let db: Database.Database;
let repo: string;
const tempDirs: string[] = [];

const asReq = (req: Request) => req as unknown as NextRequest;

/**
 * A captured payload with its placeholders filled in.
 *
 * Only `cwd` and `session_id` are substituted, so a field the route starts
 * depending on is a field a real copilot session really sends.
 */
function payload(
  dir: string,
  name: string,
  overrides: { sessionId?: string | null } = {}
): Record<string, unknown> {
  const body = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
  body.cwd = repo;
  if (overrides.sessionId === null) delete body.session_id;
  else if (overrides.sessionId !== undefined) body.session_id = overrides.sessionId;
  return body;
}

const copilot = (name: string, overrides?: { sessionId?: string | null }) =>
  payload(COPILOT_FIXTURES, name, overrides);
const claude = (name: string, overrides?: { sessionId?: string | null }) =>
  payload(CLAUDE_FIXTURES, name, overrides);

/** POST with the correlation keys an injected hook URL carries. */
async function post(body: unknown, tool: CLIToolType): Promise<Response> {
  const { POST } = await import('@/app/api/hooks/agent-event/route');
  const search = new URLSearchParams({ tool, worktreeId: WORKTREE_ID, instanceId: tool });
  return POST(
    asReq(
      new Request(`http://localhost/api/hooks/agent-event?${search.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  );
}


beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAgentStopEvents();

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'session-start-enter-fallback-3397-')));
  tempDirs.push(repo);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  upsertWorktree(db, {
    id: WORKTREE_ID,
    name: 'fix/3397',
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

function recordSent(tool: CLIToolType, instanceId: string = tool): void {
  recordEnterFallbackSent(WORKTREE_ID, tool, instanceId, {
    promptType: 'multiple_choice',
    refusalReason: 'unsupported_dialog_layout',
    screenKey: 'multiple_choice:Which one?',
  });
}

const epoch = (tool: CLIToolType, instanceId: string = tool) =>
  getEnterFallbackSessionEpoch(buildCompositeKey(WORKTREE_ID, tool, instanceId));

describe('[#3397] an applied SessionStart expires the Enter record', () => {
  beforeEach(() => clearEnterFallbacks());
  afterEach(() => clearEnterFallbacks());

  it('through the route (claude): the record goes, and the poller\'s epoch moves on', async () => {
    recordSent('claude');
    const before = epoch('claude');

    expect((await post(claude('session-start.json'), 'claude')).status).toBe(202);

    expect(getLastEnterFallback(WORKTREE_ID, 'claude', 'claude')).toBeNull();
    expect(epoch('claude')).toBe(before + 1);
  });

  it('/clear (SessionEnd then SessionStart on the same process) expires it too', async () => {
    recordSent('claude');
    expect((await post(claude('session-end-clear.json'), 'claude')).status).toBe(202);
    expect((await post(claude('session-start-clear.json'), 'claude')).status).toBe(202);
    expect(getLastEnterFallback(WORKTREE_ID, 'claude', 'claude')).toBeNull();
  });

  it('another instance\'s SessionStart leaves this record', () => {
    recordSent('claude');
    recordAgentEvent(WORKTREE_ID, 'claude', 'claude-2', {
      event: 'session_start',
      at: Date.now(),
      detail: null,
      sessionId: SESSION_B,
    });
    expect(getLastEnterFallback(WORKTREE_ID, 'claude', 'claude')).not.toBeNull();
  });

  it('a late SessionStart (#1903, held) leaves the record', async () => {
    expect((await post(copilot('user-prompt-submit.json'), 'copilot')).status).toBe(202);
    recordSent('copilot');
    const before = epoch('copilot');

    expect((await post(copilot('session-start.json'), 'copilot')).status).toBe(202);

    // Held: the frame opened no generation (pinned by #1903), and neither did it
    // expire the live process's record.
    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'copilot', 'copilot')).toBeNull();
    expect(getLastEnterFallback(WORKTREE_ID, 'copilot', 'copilot')).not.toBeNull();
    expect(epoch('copilot')).toBe(before);
  });

  it('a duplicate SessionStart the intake drops leaves the record', async () => {
    expect((await post(claude('session-start.json'), 'claude')).status).toBe(202);
    // The Enter goes to the new process's screen after its SessionStart…
    recordSent('claude');
    const before = epoch('claude');

    // …and a repeated delivery of that same SessionStart arrives.
    expect((await post(claude('session-start.json'), 'claude')).status).toBe(202);

    expect(getLastEnterFallback(WORKTREE_ID, 'claude', 'claude')).not.toBeNull();
    expect(epoch('claude')).toBe(before);
  });
});
