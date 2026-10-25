/**
 * Issue #3798, design 規則 6: `/api/hooks/claude-done` closes the wait it was
 * about, and only that one.
 *
 * The legacy endpoint names no agent session and awaits a capture (`:58`) and
 * a conversation log (`:72`) before it is done. So it fixes the episode and
 * generation it is about right after the worktree lookup, before the first of
 * those awaits, and closes the episode at the end only if it is still the open
 * one, the generation is the same, and no hook `stop` of this generation
 * already speaks for the end of turns (the double close the rule forbids).
 *
 * The body read (`:34`) comes before that and cannot be helped — the worktree
 * id is in the body. The `limit:` case pins what that costs.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';

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

vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

/** The two awaits after the target is fixed, each held when a case asks. */
const gates = vi.hoisted(() => ({ capture: null as Promise<void> | null, log: null as Promise<void> | null }));
vi.mock('@/lib/session/claude-session', () => ({
  captureClaudeOutput: vi.fn(async () => {
    if (gates.capture) await gates.capture;
    return 'agent finished\n';
  }),
}));
vi.mock('@/lib/conversation-logger', () => ({
  recordClaudeConversation: vi.fn(async () => {
    if (gates.log) await gates.log;
  }),
}));
vi.mock('@/lib/hooks/stop-history-capture', () => ({
  resolveStopTranscriptCapture: vi.fn(async () => ({ status: 'unavailable', settled: Promise.resolve(false) })),
}));

import { POST as postClaudeDoneRoute } from '@/app/api/hooks/claude-done/route';
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  recordAgentEvent,
} from '@/lib/session/agent-event-state';
import {
  clearWaitingEpisodes,
  clearWaitingTransitionListeners,
  getWaitingEpisode,
  getWaitingEpisodeRecord,
  observeWaitingEdge,
} from '@/lib/session/waiting-episode-state';

const WT = 'wt-3798-claude-done';
const TOOL = 'claude' as const;

let db: Database.Database;

function request(body: unknown | Promise<unknown>): NextRequest {
  return { json: () => Promise.resolve(body) } as unknown as NextRequest;
}

async function claudeDone(): Promise<Response> {
  return postClaudeDoneRoute(request({ worktreeId: WT }));
}

function waits(): void {
  observeWaitingEdge({ worktreeId: WT, cliToolId: TOOL, waiting: true, kind: 'prompt' });
}

function hook(event: 'user_prompt_submit' | 'stop', at = Date.now()): void {
  recordAgentEvent(WT, TOOL, TOOL, { event, at, detail: null, sessionId: 's' });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: 'feature/3798',
    path: '/path/to/3798',
    repositoryPath: '/path/to/repo',
    repositoryName: 'fixture',
  });
  gates.capture = null;
  gates.log = null;
  clearAgentStopEvents();
  clearWaitingEpisodes();
  clearWaitingTransitionListeners();
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  gates.capture = null;
  gates.log = null;
  clearAgentStopEvents();
  clearWaitingEpisodes();
});

describe('[#3798] claude-done closes the wait it was about', () => {
  it('positive: no hooks at all — the open wait closes', async () => {
    waits();
    expect((await claudeDone()).status).toBe(200);
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();
  });

  it('#5: a previous generation reported hook stops, this one only claude-done — the open wait closes', async () => {
    hook('user_prompt_submit', Date.now() - 20_000);
    hook('stop', Date.now() - 15_000);
    beginAgentEventGeneration(WT, TOOL, TOOL, Date.now() - 10_000);
    waits();
    await claudeDone();
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();
  });

  it('start hooks only (stop on claude-done): the wait of the hook turn closes', async () => {
    hook('user_prompt_submit');
    waits();
    expect(getWaitingEpisodeRecord(WT, TOOL)?.binding.kind).toBe('turn');
    await claudeDone();
    expect(getWaitingEpisode(WT, TOOL)).toBeNull();
  });

  it('a hook stop of this generation speaks for the turn — claude-done leaves the next wait alone', async () => {
    hook('user_prompt_submit', Date.now() - 5_000);
    hook('stop', Date.now() - 4_000);
    waits();
    await claudeDone();
    expect(getWaitingEpisode(WT, TOOL)).not.toBeNull();
  });

  for (const which of ['capture', 'log'] as const) {
    describe(`while the ${which === 'capture' ? 'capture (:58)' : 'conversation log (:72)'} is awaited`, () => {
      it('a hook stop closes A and B opens — B is left', async () => {
        hook('user_prompt_submit', Date.now() - 5_000);
        waits();
        const gate = deferred();
        gates[which] = gate.promise;
        const pending = claudeDone();
        await flush();

        hook('stop');
        expect(getWaitingEpisode(WT, TOOL)).toBeNull();
        waits();
        const b = getWaitingEpisodeRecord(WT, TOOL)!;

        gate.resolve();
        await pending;
        expect(getWaitingEpisodeRecord(WT, TOOL)?.episodeId).toBe(b.episodeId);
      });

      it('the generation changes — nothing is closed', async () => {
        waits();
        const gate = deferred();
        gates[which] = gate.promise;
        const pending = claudeDone();
        await flush();

        // A new process; the screen shows a wait again before any hook.
        beginAgentEventGeneration(WT, TOOL, TOOL, Date.now());
        waits();
        const b = getWaitingEpisodeRecord(WT, TOOL)!;

        gate.resolve();
        await pending;
        expect(getWaitingEpisodeRecord(WT, TOOL)?.episodeId).toBe(b.episodeId);
      });

      it('positive: nothing happens — A closes', async () => {
        waits();
        const gate = deferred();
        gates[which] = gate.promise;
        const pending = claudeDone();
        await flush();
        expect(getWaitingEpisode(WT, TOOL)).not.toBeNull();
        gate.resolve();
        await pending;
        expect(getWaitingEpisode(WT, TOOL)).toBeNull();
      });
    });
  }

  it('limit: body read swap closes the new wait', async () => {
    // The worktree id is in the body, so nothing can be fixed before it is
    // read. A wait that ends and a new one that opens while the body is still
    // arriving is the one this stop closes — the limit design §8 records.
    waits();
    const body = deferred();
    const pending = postClaudeDoneRoute({
      json: async () => {
        await body.promise;
        return { worktreeId: WT };
      },
    } as unknown as NextRequest);
    await flush();

    observeWaitingEdge({ worktreeId: WT, cliToolId: TOOL, waiting: false });
    waits();
    const b = getWaitingEpisodeRecord(WT, TOOL)!;
    body.resolve();
    await pending;
    expect(getWaitingEpisodeRecord(WT, TOOL)).toBeNull();
    expect(b.episodeId).toBeDefined();
  });
});
