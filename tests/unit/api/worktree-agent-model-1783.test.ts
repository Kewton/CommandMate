/**
 * The model, from the agent's own hook to the worktree API (Issue #1783).
 *
 * The two unit suites either side of this one — `agent-model-1783` (extraction)
 * and `agent-model-state-1783` (retention) — can both be green while the field
 * never reaches a client, because between them sit two joins that neither one
 * exercises: the receiver route has to pass `normalized.model` into
 * `recordAgentEvent`, and `detectWorktreeSessionStatus` has to read it back out
 * onto `sessionStatusByInstance`. Drop either and the pipeline is a chain of
 * passing tests that shows nothing.
 *
 * So this drives the real route with the real captured payloads against real
 * SQLite, and asserts on the JSON `GET /api/worktrees/:id` actually returns.
 * Only the things that would touch the machine — tmux, git — are mocked.
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
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';
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

// The two things that would reach outside the process. Everything between the
// hook and the response body is the real implementation.
vi.mock('@/lib/tmux/tmux', () => ({
  listSessions: vi.fn(async () => [] as Array<{ name: string }>),
}));

vi.mock('@/lib/git/git-utils', () => ({
  getGitStatus: vi.fn(async () => undefined),
}));

const CLAUDE_FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/claude');
const CODEX_FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/codex');

let db: Database.Database;
let repo: string;
const wtId = 'wt-model-1783';
const tempDirs: string[] = [];

const asReq = (req: Request) => req as unknown as NextRequest;

/** A captured payload with only `cwd` filled in, so the rest stays wire-true. */
function payload(dir: string, name: string): Record<string, unknown> {
  const body = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  body.cwd = repo;
  return body;
}

async function postHook(
  body: unknown,
  query: Record<string, string>
): Promise<Response> {
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

/** The shape the client actually receives. */
type WorktreeResponse = {
  sessionStatusByInstance?: Record<
    string,
    {
      isRunning: boolean;
      isWaitingForResponse: boolean;
      isProcessing: boolean;
      model?: string | null;
      // Issue #1786's waiting taxonomy, always present. Declared here so the
      // whole-object assertion below stays a whole-object assertion.
      waitingKind?: string | null;
      waitingSince?: number | null;
      awaitingInstruction?: boolean;
    }
  >;
};

async function getWorktree(): Promise<WorktreeResponse> {
  const { GET } = await import('@/app/api/worktrees/[id]/route');
  const response = await GET(
    asReq(new Request(`http://localhost/api/worktrees/${wtId}`)),
    { params: Promise.resolve({ id: wtId }) }
  );
  expect(response.status).toBe(200);
  return (await response.json()) as WorktreeResponse;
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAgentStopEvents();

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'agent-model-1783-')));
  tempDirs.push(repo);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });

  upsertWorktree(db, {
    id: wtId,
    name: 'feature/1783',
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
  });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  clearAgentStopEvents();
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) removeTempDir(dir);
  }
});

describe('GET /api/worktrees/:id — sessionStatusByInstance[…].model', () => {
  it('carries no model key at all before any hook has fired', async () => {
    // `toEqual` rather than a field check, and deliberately so: the absence of
    // the key IS the contract. An unconditional `model: null` would break the
    // suites that compare this object whole — `worktree-status-helper-status-
    // mapping.test.ts` is one — so this asserts the exact payload rather than
    // `model` being falsy, which `undefined` and `null` would both satisfy.
    //
    // The three waiting fields are Issue #1786's and are always present (that
    // Issue chose to publish them null rather than omit them). Listing them
    // keeps the assertion exhaustive: adding `model` unconditionally would
    // still fail here, which is the whole point of comparing whole.
    const body = await getWorktree();
    expect(body.sessionStatusByInstance?.claude).toEqual({
      isRunning: false,
      isWaitingForResponse: false,
      isProcessing: false,
      waitingKind: null,
      waitingSince: null,
      awaitingInstruction: false,
    });
  });

  it("reports claude's model after its SessionStart hook, and keeps it afterwards", async () => {
    const query = { tool: 'claude', worktreeId: wtId, instanceId: 'claude' };

    expect((await postHook(payload(CLAUDE_FIXTURES, 'session-start.json'), query)).status).toBe(202);
    expect((await getWorktree()).sessionStatusByInstance?.claude?.model).toBe('claude-opus-5[1m]');

    // The events that follow carry no model. This is the join that would have
    // silently regressed if the route recorded the newest value rather than the
    // store latching the last non-null one.
    expect((await postHook(payload(CLAUDE_FIXTURES, 'user-prompt-submit.json'), query)).status).toBe(202);
    expect((await getWorktree()).sessionStatusByInstance?.claude?.model).toBe('claude-opus-5[1m]');

    expect((await postHook(payload(CLAUDE_FIXTURES, 'stop.json'), query)).status).toBe(202);
    expect((await getWorktree()).sessionStatusByInstance?.claude?.model).toBe('claude-opus-5[1m]');
  });

  it("reports codex's model under its own key, and leaves the other tools alone", async () => {
    // The second half of "which key holds it is the source's business": codex
    // and claude both spell it `model`, but the route must not be reading it
    // itself — it reads whatever that tool's source normalised.
    expect(
      (
        await postHook(payload(CODEX_FIXTURES, 'session-start.json'), {
          tool: 'codex',
          worktreeId: wtId,
          instanceId: 'codex',
        })
      ).status
    ).toBe(202);

    const body = await getWorktree();
    expect(body.sessionStatusByInstance?.codex?.model).toBe('gpt-5.6-sol');
    expect(body.sessionStatusByInstance?.claude?.model).toBeUndefined();
    expect(body.sessionStatusByInstance?.gemini?.model).toBeUndefined();
  });

  it('keeps alias instances apart', async () => {
    // `claude` and `claude-2` share a directory and differ only by the id in the
    // injected URL, which is exactly the case #1722 added instance correlation
    // for. A model filed against the wrong one would be invisible in a
    // single-instance test.
    await postHook(payload(CLAUDE_FIXTURES, 'session-start.json'), {
      tool: 'claude',
      worktreeId: wtId,
      instanceId: 'claude-2',
    });

    const body = await getWorktree();
    expect(body.sessionStatusByInstance?.claude?.model).toBeUndefined();
    // The alias instance is only probed when it is on the roster; the store,
    // however, is keyed by the id the hook carried.
    const { getLastKnownAgentModel } = await import('@/lib/session/agent-event-state');
    expect(getLastKnownAgentModel(wtId, 'claude', 'claude-2')).toBe('claude-opus-5[1m]');
  });
});
