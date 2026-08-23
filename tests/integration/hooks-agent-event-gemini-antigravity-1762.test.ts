/**
 * `POST /api/hooks/agent-event` end to end for gemini and antigravity
 * (Issue #1762).
 *
 * The unit tests prove each source reads its own payloads. This proves the
 * whole path: the request a real hook would make, through the receiver, into
 * `agent-event-state`, out the other side as the status a `wait` and a sidebar
 * read. Nothing below the route is mocked except the database handle — real
 * SQLite, real worktrees on disk, real captured payloads.
 *
 * Two things here can only be caught at this level:
 *
 *  - **Registration.** Take either source out of `registry.ts` and the receiver
 *    silently falls back to the compatibility relay, which speaks Claude's
 *    CamelCase table. gemini's `BeforeAgent` then becomes a 400 and
 *    antigravity's payload stops being readable at all — with the tool, the
 *    request and the fixtures all unchanged.
 *  - **The two shapes of request.** gemini's hook posts the agent's own payload
 *    with `hook_event_name` in it; antigravity's cannot, because its payloads
 *    have no event-name field, so the word arrives in the body the relay builds.
 *    Both have to land on the same state.
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
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  getLastAgentEvent,
  getLastStopEventAt,
  getStructuredSessionState,
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

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks');
const WT = 'wt-1762-integration';

let db: Database.Database;
let repo: string;
const tempDirs: string[] = [];

const asReq = (req: Request) => req as unknown as NextRequest;

/** A captured payload, with only the placeholders a real session would fill in. */
function fixture(tool: string, name: string): Record<string, unknown> {
  const payload = JSON.parse(readFileSync(join(FIXTURES, tool, `${name}.json`), 'utf8'));
  if (payload.cwd !== undefined) payload.cwd = repo;
  return payload;
}

/** POST, with the correlation keys where the injected config puts them. */
async function post(body: unknown, query: Record<string, string> = {}): Promise<Response> {
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

/**
 * What `scripts/hooks/cmate-agent-event.sh` sends for antigravity.
 *
 * The relay builds this body itself — `tool`, the `--event` word, a `cwd` and
 * the session id it found in the payload — because agy's payload can supply
 * none of it. `cwd` is `~/.gemini/config`, the directory agy runs hooks in,
 * which is why the query string has to carry the worktree.
 */
function relayBody(event: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    tool: 'antigravity',
    event,
    cwd: join(tmpdir(), '.gemini', 'config'),
    sessionId: payload.conversationId,
  };
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAgentStopEvents();
  globalThis.__agentEventGenerationStartedAt?.clear();

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'agent-event-1762-')));
  tempDirs.push(repo);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  upsertWorktree(db, {
    id: WT,
    name: 'feature/1762',
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

describe('gemini payloads reach agent-event-state', () => {
  it('files each captured payload under the right word', async () => {
    const expected: Record<string, string> = {
      'session-start': 'session_start',
      'before-agent': 'user_prompt_submit',
      'session-end': 'session_end',
    };

    for (const [name, event] of Object.entries(expected)) {
      clearAgentStopEvents();
      const response = await post(fixture('gemini', name), {
        tool: 'gemini',
        worktreeId: WT,
        instanceId: 'gemini',
      });

      expect(response.status, `${name} rejected`).toBe(202);
      expect(getLastAgentEvent(WT, 'gemini', 'gemini')?.event, name).toBe(event);
    }
  });

  it('turns AfterAgent into the completion `commandmate wait` returns on', async () => {
    // gemini's spelling of `Stop`. The compatibility source does not know it, so
    // a gemini source missing from the registry fails right here with a 400.
    const response = await post(
      { session_id: 'gm-1', hook_event_name: 'AfterAgent', cwd: repo },
      { tool: 'gemini', worktreeId: WT, instanceId: 'gemini' }
    );

    expect(response.status).toBe(202);
    expect(getLastStopEventAt(WT, 'gemini', 'gemini')).not.toBeNull();
  });

  it('turns BeforeAgent into `running` and AfterAgent into `ready`', async () => {
    const now = Date.now();
    beginAgentEventGeneration(WT, 'gemini', 'gemini', now - 60_000);

    const opening = fixture('gemini', 'before-agent');
    await post(opening, { tool: 'gemini', worktreeId: WT, instanceId: 'gemini' });
    expect(getStructuredSessionState(WT, 'gemini', 'gemini', Date.now())?.status).toBe('running');

    // Issue #1930: the closing frame has to name the SAME conversation as the
    // opening one, because a `stop` now closes only the turn of the session
    // that sent it (§4 D3 決定 2 — opencode publishes `session.idle` for every
    // session its server holds, other processes' included). Real gemini carries
    // one `session_id` through a turn; this used to be hand-written as `gm-1`
    // against a fixture whose id is a UUID, which no live session does.
    const closing = {
      session_id: opening.session_id,
      hook_event_name: 'AfterAgent',
      cwd: repo,
    };
    await post(closing, { tool: 'gemini', worktreeId: WT, instanceId: 'gemini' });
    expect(getStructuredSessionState(WT, 'gemini', 'gemini', Date.now())?.status).toBe('ready');
  });

  it('does not let an AfterAgent from another conversation close this turn', async () => {
    // The rule the case above now depends on, asserted directly rather than
    // left as an incidental property of a fixture. `commandmate wait` is
    // unaffected either way: its completion gate reads `lastStopEventAt`, which
    // `applyAgentStopEvent` writes for every delivery.
    beginAgentEventGeneration(WT, 'gemini', 'gemini', Date.now() - 60_000);

    await post(fixture('gemini', 'before-agent'), {
      tool: 'gemini',
      worktreeId: WT,
      instanceId: 'gemini',
    });
    await post(
      { session_id: 'a-different-conversation', hook_event_name: 'AfterAgent', cwd: repo },
      { tool: 'gemini', worktreeId: WT, instanceId: 'gemini' }
    );

    expect(getStructuredSessionState(WT, 'gemini', 'gemini', Date.now())?.status).toBe('running');
  });

  it('turns a ToolPermission notification into `waiting`', async () => {
    // The translation in `gemini/event-vocabulary` earning its keep: the
    // consumers compare `detail` against Claude's `permission_prompt`, and
    // gemini's only notification type is spelled `ToolPermission`.
    beginAgentEventGeneration(WT, 'gemini', 'gemini', Date.now() - 60_000);

    const response = await post(
      {
        session_id: 'gm-1',
        hook_event_name: 'Notification',
        notification_type: 'ToolPermission',
        message: 'Allow run_shell_command?',
        cwd: repo,
      },
      { tool: 'gemini', worktreeId: WT, instanceId: 'gemini' }
    );

    expect(response.status).toBe(202);
    expect(getLastAgentEvent(WT, 'gemini', 'gemini')?.detail).toBe('permission_prompt');
    expect(getStructuredSessionState(WT, 'gemini', 'gemini', Date.now())?.status).toBe('waiting');
  });

  it('refuses a gemini-only event rather than filing it as something adjacent', async () => {
    const response = await post(fixture('gemini', 'pre-compress'), {
      tool: 'gemini',
      worktreeId: WT,
    });
    expect(response.status).toBe(400);
  });

  it('keeps two instances in the same worktree apart', async () => {
    // `.gemini/settings.json` is per worktree, so both instances' hooks are the
    // same handler; the instance comes off the URL, which is why the launch
    // command carries it.
    await post(fixture('gemini', 'before-agent'), {
      tool: 'gemini',
      worktreeId: WT,
      instanceId: 'gemini',
    });
    await post(
      { session_id: 'gm-2', hook_event_name: 'AfterAgent', cwd: repo },
      { tool: 'gemini', worktreeId: WT, instanceId: 'gemini-2' }
    );

    expect(getLastAgentEvent(WT, 'gemini', 'gemini')?.event).toBe('user_prompt_submit');
    expect(getLastAgentEvent(WT, 'gemini', 'gemini-2')?.event).toBe('stop');
    expect(getLastStopEventAt(WT, 'gemini', 'gemini')).toBeNull();
    expect(getLastStopEventAt(WT, 'gemini', 'gemini-2')).not.toBeNull();
  });
});

describe('antigravity payloads reach agent-event-state', () => {
  it('files each captured payload under the word the relay was told to send', async () => {
    const expected: Record<string, string> = {
      'session-start': 'session_start',
      'post-tool-use': 'post_tool_use',
      stop: 'stop',
    };

    for (const [name, event] of Object.entries(expected)) {
      clearAgentStopEvents();
      const payload = fixture('antigravity', name);
      const response = await post(relayBody(event, payload), {
        tool: 'antigravity',
        worktreeId: WT,
        instanceId: 'antigravity',
      });

      expect(response.status, `${name} rejected`).toBe(202);
      expect(getLastAgentEvent(WT, 'antigravity', 'antigravity')?.event, name).toBe(event);
    }
  });

  it('resolves the worktree from the URL, because agy’s cwd is not the worktree', async () => {
    // agy runs hooks with a working directory of `~/.gemini/config` and its
    // payload has no `cwd` at all, so the query string is the only thing that
    // can say where the event came from.
    const response = await post(relayBody('stop', fixture('antigravity', 'stop')), {
      tool: 'antigravity',
      worktreeId: WT,
      instanceId: 'antigravity',
    });

    expect(response.status).toBe(202);
    expect(getLastStopEventAt(WT, 'antigravity', 'antigravity')).not.toBeNull();
  });

  it('drops an event it cannot attribute instead of guessing a worktree', async () => {
    // A session started outside CommandMate: no `CM_HOOK_URL`, so no query
    // string, and a cwd that belongs to no worktree. Accepted and dropped —
    // fail-open, and never filed against somebody else's session.
    const response = await post(relayBody('stop', fixture('antigravity', 'stop')));

    expect(response.status).toBe(202);
    expect(getLastAgentEvent(WT, 'antigravity', 'antigravity')).toBeNull();
  });

  it('turns post_tool_use into `running` and stop into `ready`', async () => {
    // agy emits no `user_prompt_submit`, so `PostToolUse` is the only structured
    // signal that the agent is mid-turn. That is why it is registered despite
    // costing a round trip per tool step.
    beginAgentEventGeneration(WT, 'antigravity', 'antigravity', Date.now() - 60_000);

    await post(relayBody('post_tool_use', fixture('antigravity', 'post-tool-use')), {
      tool: 'antigravity',
      worktreeId: WT,
      instanceId: 'antigravity',
    });
    expect(getStructuredSessionState(WT, 'antigravity', 'antigravity', Date.now())?.status).toBe(
      'running'
    );

    await post(relayBody('stop', fixture('antigravity', 'stop')), {
      tool: 'antigravity',
      worktreeId: WT,
      instanceId: 'antigravity',
    });
    expect(getStructuredSessionState(WT, 'antigravity', 'antigravity', Date.now())?.status).toBe(
      'ready'
    );
  });

  it('keeps two instances in the same worktree apart', async () => {
    // The hardest case for agy: one global config file, two live sessions. The
    // instance can only come from `CM_HOOK_URL`, which is per process.
    await post(relayBody('post_tool_use', fixture('antigravity', 'post-tool-use')), {
      tool: 'antigravity',
      worktreeId: WT,
      instanceId: 'antigravity',
    });
    await post(relayBody('stop', fixture('antigravity', 'stop')), {
      tool: 'antigravity',
      worktreeId: WT,
      instanceId: 'antigravity-2',
    });

    expect(getLastAgentEvent(WT, 'antigravity', 'antigravity')?.event).toBe('post_tool_use');
    expect(getLastAgentEvent(WT, 'antigravity', 'antigravity-2')?.event).toBe('stop');
    expect(getLastStopEventAt(WT, 'antigravity', 'antigravity')).toBeNull();
  });

  it('refuses a payload with no event word, rather than defaulting one', async () => {
    // agy's payload cannot say what it is. A request that also does not say is
    // unattributable, and inventing `stop` for it would end a `wait` early.
    const response = await post(
      { tool: 'antigravity', cwd: repo, ...fixture('antigravity', 'stop') },
      { tool: 'antigravity', worktreeId: WT }
    );
    expect(response.status).toBe(400);
  });
});
