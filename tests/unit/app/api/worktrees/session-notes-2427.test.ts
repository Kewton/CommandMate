/**
 * The session note's three routes (Issue #2427).
 *
 * The note is written through ONE narrow endpoint
 * (`PUT /api/worktrees/:id/instances/notes`), read back on the list every client
 * already polls (`GET /api/worktrees`), and — this is the part worth a test of
 * its own — is invisible to `GET /api/worktrees/:id/resolve-target`.
 *
 * That last one is the Issue's second acceptance condition and it is not
 * self-evident: since Issue #2376 `?instance=レビュー担当` DOES resolve, through
 * `agent_instances.alias`. A note that looked like an alias would therefore be a
 * routing key the operator rewrites hourly, and `send` would start landing in
 * whichever pane happened to be described with the right words. The test below
 * puts a note on `codex-2`, asks the resolver for it by that exact text, and
 * pins that the answer is NOT `codex-2` — with a positive control immediately
 * beside it (the real alias, which does resolve) so the assertion cannot pass
 * because the resolver was broken outright.
 *
 * A real in-memory SQLite runs behind all three, so the roster gating, the
 * length limit and the notes map are exercised as the server executes them.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import {
  MAX_SESSION_NOTE_LENGTH,
  getSessionNote,
  setAgentInstances,
  setSessionNote,
} from '@/lib/db/agent-instances-db';
import type { Worktree } from '@/types/models';
import type { NextRequest } from 'next/server';

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

// The list route reaches tmux for the status half; `?includeStatus=0` is the
// documented way to ask for the DB half alone, and the notes ride the DB half.
vi.mock('@/lib/tmux/tmux', () => ({ listSessions: vi.fn(async () => []) }));

import { GET as getNotes, PUT as putNote } from '@/app/api/worktrees/[id]/instances/notes/route';
import { GET as getWorktrees } from '@/app/api/worktrees/route';
import { GET as resolveTarget } from '@/app/api/worktrees/[id]/resolve-target/route';

const WT = 'wt-2427-api';
const NOTE_TEXT = 'レビュー結果を待っている';
const ALIAS = 'レビュー担当';

function params(id: string = WT) {
  return { params: Promise.resolve({ id }) };
}

function putRequest(body: unknown): NextRequest {
  return new Request(`http://localhost:3000/api/worktrees/${WT}/instances/notes`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function notesRequest(): NextRequest {
  return new Request(
    `http://localhost:3000/api/worktrees/${WT}/instances/notes`
  ) as unknown as NextRequest;
}

/** The list route reads `request.nextUrl.searchParams`, so hand it one. */
function listRequest(query = ''): NextRequest {
  const url = new URL(`http://localhost:3000/api/worktrees${query}`);
  const request = new Request(url) as unknown as NextRequest;
  Object.defineProperty(request, 'nextUrl', { value: url, configurable: true });
  return request;
}

function resolveRequest(instance: string): NextRequest {
  return new Request(
    `http://localhost:3000/api/worktrees/${WT}/resolve-target?instance=${encodeURIComponent(instance)}`
  ) as unknown as NextRequest;
}

describe('/api/worktrees/:id/instances/notes (Issue #2427)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: WT,
      name: WT,
      path: `/tmp/${WT}`,
      repositoryPath: '/tmp/repo',
      repositoryName: 'repo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
    setAgentInstances(db, WT, [
      { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
      { id: 'codex-2', cliTool: 'codex', alias: ALIAS, order: 1 },
    ]);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
  });

  // ==========================================================================
  // PUT
  // ==========================================================================

  it('writes a note and answers it back', async () => {
    const response = await putNote(
      putRequest({ instanceId: 'codex-2', text: NOTE_TEXT }),
      params()
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.instanceId).toBe('codex-2');
    expect(body.note.text).toBe(NOTE_TEXT);
    expect(typeof body.note.updatedAt).toBe('number');
    expect(getSessionNote(db, WT, 'codex-2')?.text).toBe(NOTE_TEXT);
  });

  it('clears a note with an empty string and answers null', async () => {
    setSessionNote(db, WT, 'codex-2', NOTE_TEXT);

    const response = await putNote(putRequest({ instanceId: 'codex-2', text: '' }), params());

    expect(response.status).toBe(200);
    expect((await response.json()).note).toBeNull();
    expect(getSessionNote(db, WT, 'codex-2')).toBeNull();
  });

  it('refuses a note over the limit and stores nothing', async () => {
    const response = await putNote(
      putRequest({ instanceId: 'codex-2', text: 'a'.repeat(MAX_SESSION_NOTE_LENGTH + 1) }),
      params()
    );

    expect(response.status).toBe(400);
    expect((await response.json()).maxLength).toBe(MAX_SESSION_NOTE_LENGTH);
    expect(getSessionNote(db, WT, 'codex-2')).toBeNull();
  });

  it('refuses an instance the roster does not know', async () => {
    const response = await putNote(
      putRequest({ instanceId: 'codex-9', text: NOTE_TEXT }),
      params()
    );

    expect(response.status).toBe(404);
    expect(getSessionNote(db, WT, 'codex-9')).toBeNull();
  });

  it('refuses a body with no text, so a forgetful client cannot erase a note', async () => {
    setSessionNote(db, WT, 'codex-2', NOTE_TEXT);

    const response = await putNote(putRequest({ instanceId: 'codex-2' }), params());

    expect(response.status).toBe(400);
    expect(getSessionNote(db, WT, 'codex-2')?.text).toBe(NOTE_TEXT);
  });

  it('answers 404 for a worktree that does not exist', async () => {
    const response = await putNote(
      putRequest({ instanceId: 'claude', text: 'x' }),
      params('wt-nope')
    );
    expect(response.status).toBe(404);
  });

  // ==========================================================================
  // GET
  // ==========================================================================

  it('reads back only the sessions that have a note', async () => {
    setSessionNote(db, WT, 'codex-2', NOTE_TEXT, 1234);

    const response = await getNotes(notesRequest(), params());

    expect(response.status).toBe(200);
    expect((await response.json()).notes).toEqual({
      'codex-2': { text: NOTE_TEXT, updatedAt: 1234 },
    });
  });

  // ==========================================================================
  // The list, which is how another browser's edit arrives
  // ==========================================================================

  it('rides GET /api/worktrees as its own map, keyed by instance id', async () => {
    setSessionNote(db, WT, 'codex-2', NOTE_TEXT, 1234);

    const response = await getWorktrees(listRequest('?includeStatus=0'));
    const body = await response.json();
    const worktree = body.worktrees.find((entry: { id: string }) => entry.id === WT);

    expect(worktree.sessionNotes).toEqual({ 'codex-2': { text: NOTE_TEXT, updatedAt: 1234 } });
    // Emphatically NOT on the roster entries: `AgentInstance` is the roster
    // PATCH's input shape, and a note there would have to be echoed back by
    // every writer or be destroyed.
    for (const instance of worktree.agentInstances) {
      expect(instance).not.toHaveProperty('note');
      expect(instance).not.toHaveProperty('sessionNote');
    }
  });

  it('carries an empty map rather than an absent key when nothing is annotated', async () => {
    const response = await getWorktrees(listRequest('?includeStatus=0'));
    const body = await response.json();
    const worktree = body.worktrees.find((entry: { id: string }) => entry.id === WT);

    expect(worktree.sessionNotes).toEqual({});
  });

  // ==========================================================================
  // The note is not a routing key
  // ==========================================================================

  describe('resolution is blind to the note (Issue #2376 alias lookup)', () => {
    beforeEach(() => {
      setSessionNote(db, WT, 'codex-2', NOTE_TEXT);
    });

    it('does not resolve --instance <note text> to the noted instance', async () => {
      const response = await resolveTarget(resolveRequest(NOTE_TEXT), params());
      const body = await response.json();

      expect(body.instanceId).not.toBe('codex-2');
      expect(body.resolvedBy).not.toBe('alias');
    });

    it('still resolves --instance <alias>, which is the control', async () => {
      const response = await resolveTarget(resolveRequest(ALIAS), params());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.instanceId).toBe('codex-2');
      expect(body.cliToolId).toBe('codex');
    });

    it('still resolves --instance <id> with a note on it', async () => {
      const response = await resolveTarget(resolveRequest('codex-2'), params());
      const body = await response.json();

      expect(body.instanceId).toBe('codex-2');
      expect(body.cliToolId).toBe('codex');
    });

    it('does not change what an alias resolves to once a note exists', async () => {
      const before = await (await resolveTarget(resolveRequest(ALIAS), params())).json();
      setSessionNote(db, WT, 'claude', ALIAS);
      const after = await (await resolveTarget(resolveRequest(ALIAS), params())).json();

      // A note whose text is literally another instance's alias must not make
      // the lookup ambiguous — the resolver never sees it.
      expect(after).toEqual(before);
    });
  });
});
