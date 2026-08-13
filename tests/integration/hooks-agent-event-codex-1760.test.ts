/**
 * codex's events, end to end through the real receivers (Issue #1760).
 *
 * Nothing below the routes is mocked except the database handle: real SQLite,
 * the real registry, the real `agent-event-state`. That is the point — the
 * claim this Issue makes is that "the consuming half is already tool-agnostic,
 * so adding a source is enough", and the only way to show it is to post codex's
 * own captured payloads at the endpoints Claude's hooks post at and read the
 * state back out.
 *
 * Every request body is a fixture from `tests/fixtures/hooks/codex/`, captured
 * from a live codex-cli 0.147.0 session in Issue #1757. Both request shapes the
 * generated config can produce are exercised, because they take different paths
 * through the source:
 *
 *  - the relay's shape (`{tool, event, cwd, worktreeId, instanceId, detail}`),
 *    where the word is already resolved;
 *  - codex's own payload with `hook_event_name`, which the inline fallback
 *    posts verbatim and which only maps because the source knows the spelling.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  discardAgentEventState,
  getLastAgentEvent,
  getLastStopEventAt,
  getStructuredSessionState,
} from '@/lib/session/agent-event-state';
import { getUnknownEventTally, resetUnknownEventTallies } from '@/lib/hooks/sources';

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

/** The contract policy is a task lookup behind a TTL cache; keep it out of the way. */
vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicy: () => null,
  invalidateSessionAutoYesPolicy: () => {},
  clearAutoYesPolicyCache: () => {},
}));

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/codex');
const WT = 'wt-codex-1760';
/** The fixtures ship `"cwd": "<CWD>"`; the route validates every cwd it is sent. */
const WT_PATH = process.cwd();
const ONE_HOUR_MS = 3_600_000;

let db: Database.Database;

const asReq = (req: Request) => req as unknown as NextRequest;

function fixture(name: string): Record<string, unknown> {
  return { ...JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')), cwd: WT_PATH };
}

/** What `scripts/hooks/cmate-agent-event.sh` sends, given the generated hook. */
function relayBody(event: string, detail?: string, instanceId = 'codex') {
  return {
    tool: 'codex',
    event,
    cwd: WT_PATH,
    worktreeId: WT,
    instanceId,
    ...(detail === undefined ? {} : { detail }),
  };
}

async function postEvent(body: unknown, query = '') {
  const { POST } = await import('@/app/api/hooks/agent-event/route');
  const response = await POST(
    asReq(
      new Request(`http://localhost/api/hooks/agent-event${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  );
  return { status: response.status, body: await response.json() };
}

async function postPermission(body: unknown, query: string) {
  const { POST } = await import('@/app/api/hooks/permission-request/route');
  const response = await POST(
    asReq(
      new Request(`http://localhost/api/hooks/permission-request${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  upsertWorktree(db, {
    id: WT,
    name: 'feature/1760',
    path: WT_PATH,
    repositoryPath: WT_PATH,
    repositoryName: 'fixture',
  });
  clearAllAutoYesStates();
  clearAgentStopEvents();
  resetUnknownEventTallies();
  for (const instanceId of ['codex', 'codex-2']) {
    discardAgentEventState(WT, 'codex', instanceId);
  }
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  clearAllAutoYesStates();
});

describe('codex events reach agent-event-state', () => {
  it('is served by codex’s own source and not by the compatibility fallback', async () => {
    // Worth asserting explicitly, because the receivers cannot tell the two
    // apart: `legacy-relay` was built to preserve exactly this behaviour for
    // hand-configured #1549 hooks, so it maps the same names and encodes the
    // same allow. What it does not do is describe codex or launch it — and a
    // registry entry that quietly went missing would leave every test below
    // green while `startSession` stopped injecting anything at all.
    const { getAgentEventSource, hasAgentEventSource } = await import('@/lib/hooks/sources');
    expect(hasAgentEventSource('codex')).toBe(true);
    expect(getAgentEventSource('codex').capabilities.supportedEvents).toContain('stop');
  });

  it('records a turn, from the relay’s shape', async () => {
    expect((await postEvent(relayBody('user_prompt_submit'))).status).toBe(202);
    expect(getStructuredSessionState(WT, 'codex', 'codex')!.status).toBe('running');

    expect((await postEvent(relayBody('stop'))).status).toBe(202);
    const state = getStructuredSessionState(WT, 'codex', 'codex')!;
    expect(state.status).toBe('ready');
    expect(state.event).toBe('stop');
    // What `commandmate wait` reads to decide the turn is over.
    expect(getLastStopEventAt(WT, 'codex', 'codex')).not.toBeNull();
  });

  it('records codex’s own payload, which only maps through the source', async () => {
    // The inline fallback posts the hook payload verbatim; `hook_event_name` is
    // codex's spelling and the route no longer knows any spellings at all.
    const { status } = await postEvent(
      fixture('stop'),
      `?tool=codex&worktreeId=${WT}&instanceId=codex`
    );
    expect(status).toBe(202);
    expect(getLastAgentEvent(WT, 'codex', 'codex')!.event).toBe('stop');
    expect(getLastStopEventAt(WT, 'codex', 'codex')).not.toBeNull();
  });

  it('carries each captured payload’s subtype through to the record', async () => {
    for (const [name, event, detail] of [
      ['session-start', 'session_start', 'startup'],
      ['session-end', 'session_end', 'other'],
    ] as const) {
      await postEvent(fixture(name), `?tool=codex&worktreeId=${WT}&instanceId=codex`);
      const record = getLastAgentEvent(WT, 'codex', 'codex')!;
      expect(record.event).toBe(event);
      expect(record.detail).toBe(detail);
      expect(record.sessionId).toBe('00000000-0000-4000-8000-000000000000');
    }
  });

  it('keeps two instances of one worktree apart', async () => {
    // `cwd` is byte-identical for both, which is why the instance id has to
    // come from the launch environment. If it did not, `codex-2`'s stop would
    // end the wait on `codex`.
    await postEvent(relayBody('user_prompt_submit', undefined, 'codex'));
    await postEvent(relayBody('stop', undefined, 'codex-2'));

    expect(getStructuredSessionState(WT, 'codex', 'codex')!.status).toBe('running');
    expect(getStructuredSessionState(WT, 'codex', 'codex-2')!.status).toBe('ready');
    expect(getLastStopEventAt(WT, 'codex', 'codex')).toBeNull();
    expect(getLastStopEventAt(WT, 'codex', 'codex-2')).not.toBeNull();
  });

  it('ignores an event from before the session was created', async () => {
    // The fence `CodexTool.startSession` puts up. Without it the previous codex
    // process's last event would describe the new one.
    await postEvent(relayBody('user_prompt_submit'));
    beginAgentEventGeneration(WT, 'codex', 'codex', Date.now() + 1_000);
    expect(getStructuredSessionState(WT, 'codex', 'codex')).toBeNull();
  });

  it('refuses a codex event it has no word for, and counts it', async () => {
    // `PreCompact` is real (codex's review screen lists it) and has no
    // counterpart among the seven. Refusing beats filing it under something
    // adjacent; counting beats throwing.
    const { status } = await postEvent(
      { ...fixture('stop'), hook_event_name: 'PreCompact' },
      `?tool=codex&worktreeId=${WT}&instanceId=codex`
    );
    expect(status).toBe(400);
    expect(getUnknownEventTally('codex').names).toContain('PreCompact');
  });
});

describe('codex approvals are adjudicated in codex’s wire format', () => {
  const QUERY = `?tool=codex&worktreeId=${WT}&instanceId=codex`;

  it('answers Auto-Yes with the body the live session obeyed', async () => {
    setAutoYesEnabled(WT, 'codex', true, ONE_HOUR_MS);
    const { status, body } = await postPermission(fixture('permission-request'), QUERY);
    expect(status).toBe(200);
    expect(body).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
  });

  it('answers an empty object when Auto-Yes is off', async () => {
    // Measured on codex: `{}` produces the ordinary approval dialog, so
    // abstaining costs a dialog and nothing else.
    const { status, body } = await postPermission(fixture('permission-request'), QUERY);
    expect(status).toBe(200);
    expect(JSON.stringify(body)).toBe('{}');
  });

  it('adjudicates the instance the query names, not the primary', async () => {
    setAutoYesEnabled(WT, 'codex', true, ONE_HOUR_MS, undefined, 'codex-2');
    const primary = await postPermission(fixture('permission-request'), QUERY);
    const second = await postPermission(
      fixture('permission-request'),
      `?tool=codex&worktreeId=${WT}&instanceId=codex-2`
    );
    expect(JSON.stringify(primary.body)).toBe('{}');
    expect(second.body).toHaveProperty('hookSpecificOutput.decision.behavior', 'allow');
  });
});
