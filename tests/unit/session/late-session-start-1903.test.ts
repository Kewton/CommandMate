/**
 * Issue #1903: a `SessionStart` that arrives *after* the turn it belongs to.
 *
 * copilot 1.0.80 fires `UserPromptSubmit` and then `SessionStart` — 12-15 s
 * later on a first turn, measured twice (`10:55:10` -> `10:55:21`, and a `send`
 * at `20:02:56` whose `capture --json` read `lastEv=session_start` at
 * `20:03:11`). The captured payload says the same thing from the other side: the
 * copilot `SessionStart` fixture carries `initial_prompt` with the text of the
 * prompt that had already been submitted.
 *
 * Under the "newest event is the verdict" model that arrival erased the turn's
 * own `running / hook_prompt_submit`, because `agentEventToSessionStatus`
 * answers null for `session_start`. The pane fell back to the scraper, which
 * reads a *generating* copilot frame as `ready / input_prompt` (#1885), so
 * `commandmate wait` started inside that window exited 0 with
 * `basis=scraper_ready` on a session that was still thinking — `PreToolUse` was
 * 13 s away and `Stop` 30 s away.
 *
 * The fix reads the declared
 * {@link AgentSourceCapabilities.sessionStartMayArriveLate} (#1924, §4 D3),
 * in the same shape #1901 reads `permissionHookPredictsDialog` and #1899 reads
 * `eventIdentity`.
 *
 * ## What this suite has to prove
 *
 * "Hold the frame" is trivially passed by "never record `session_start` at all",
 * and that would break `/clear`, a hand-relaunched agent, and the generation
 * fence #1723 shipped. So every hold below is paired with a release:
 *
 *  - **through the route**, because a state machine that reads a capability the
 *    receiver never passes is a fix that ships turned off. The two halves are
 *    `POST /api/hooks/agent-event` (here) and `sources/opencode/ingest` (which
 *    declares `false`, so it has nothing to hold);
 *  - **both directions of the capability**: flipping copilot to `false` puts the
 *    overwrite back, and flipping claude to `true` holds *its* late frame. That
 *    pair is what separates "the declared value is read" from "copilot is
 *    hard-coded";
 *  - **the turn has to be open**: a `session_start` first, after a `stop`, or
 *    past the staleness bound is recorded exactly as before, generation bump
 *    included;
 *  - **the bounds still bite**: a held frame does not extend the turn, and
 *    `beginAgentEventGeneration` still clears it. Those are what stop a genuine
 *    restart from pinning the instance to a dead process's `running`.
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
import { getAgentEventSource } from '@/lib/hooks/sources';
import type { AgentEventSource, AgentSourceCapabilities } from '@/lib/hooks/sources';
import {
  beginAgentEventGeneration,
  clearAgentStopEvents,
  getAgentEventGenerationStartedAt,
  getLastAgentEvent,
  getLastKnownAgentModel,
  getStructuredPromptWaiting,
  getStructuredSessionState,
  recordAgentEvent,
  STRUCTURED_STATE_MAX_AGE_MS,
} from '@/lib/session/agent-event-state';
import { HOOK_STATUS_REASON } from '@/lib/session/status-mapping';
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

const WORKTREE_ID = 'wt-1903';
const COPILOT_FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/copilot');
const CLAUDE_FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/claude');

/** The id every copilot fixture was captured under. */
const SESSION_A = '00000000-0000-4000-8000-000000000000';
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

/**
 * Run `body` with one source's declared capabilities overridden.
 *
 * The mutation lever. Same helper shape as #1901's forecast suite, and the same
 * purpose: the assertions it wraps are the ones that would still pass if the
 * fix were `cliToolId === 'copilot'`.
 */
async function withCapabilities(
  source: AgentEventSource,
  overrides: Partial<AgentSourceCapabilities>,
  body: () => Promise<void>
): Promise<void> {
  const declared = source.capabilities;
  Object.defineProperty(source, 'capabilities', {
    value: { ...declared, ...overrides },
    configurable: true,
  });
  try {
    await body();
  } finally {
    Object.defineProperty(source, 'capabilities', { value: declared, configurable: true });
  }
}

const structured = (tool: CLIToolType, now?: number) =>
  getStructuredSessionState(WORKTREE_ID, tool, tool, now);
const lastEvent = (tool: CLIToolType) => getLastAgentEvent(WORKTREE_ID, tool, tool);

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
  clearAgentStopEvents();

  repo = realpathSync(mkdtempSync(join(tmpdir(), 'late-session-start-1903-')));
  tempDirs.push(repo);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  upsertWorktree(db, {
    id: WORKTREE_ID,
    name: 'fix/1903',
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

describe('the late SessionStart, through POST /api/hooks/agent-event (Issue #1903)', () => {
  it('keeps the turn running when copilot reports SessionStart after UserPromptSubmit', async () => {
    expect((await post(copilot('user-prompt-submit.json'), 'copilot')).status).toBe(202);
    expect((await post(copilot('session-start.json'), 'copilot')).status).toBe(202);

    // The verdict the scraper would have taken over from. Before this Issue it
    // was null here, and `mergeStructuredStatus` published the scraper's
    // `ready / input_prompt` on a copilot that was still generating.
    expect(structured('copilot')).toMatchObject({
      status: 'running',
      reason: HOOK_STATUS_REASON.PROMPT_SUBMIT,
      event: 'user_prompt_submit',
    });

    // The displayed event too, and that is not decoration: `wait`'s
    // `adoptTurnStart` reads `structuredEvents.lastEventType` and only adopts a
    // turn from `user_prompt_submit` / `pre_tool_use` / `post_tool_use`
    // (#1839). A `wait` that starts inside this window adopts the turn again.
    expect(lastEvent('copilot')?.event).toBe('user_prompt_submit');

    // Held, so the frame did not open a generation either — bumping it would
    // have fenced the still-current turn out on age instead of on verdict, and
    // the symptom would have been identical.
    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'copilot', 'copilot')).toBeNull();
  });

  it('lets claude, which declares the ordinary ordering, overwrite exactly as before', async () => {
    expect((await post(claude('user-prompt-submit.json'), 'claude')).status).toBe(202);
    expect((await post(claude('session-start.json'), 'claude')).status).toBe(202);

    // The control. Nothing about the fix is "session_start no longer counts":
    // on the five sources that declare `false` this is the pre-#1903 behaviour,
    // verdict handed back to the scraper and a fresh generation opened.
    expect(structured('claude')).toBeNull();
    expect(lastEvent('claude')?.event).toBe('session_start');
    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'claude', 'claude')).not.toBeNull();
  });

  it('records copilot SessionStart normally once the turn has been closed by Stop', async () => {
    await post(copilot('user-prompt-submit.json'), 'copilot');
    await post(copilot('stop.json'), 'copilot');
    expect(structured('copilot')?.status).toBe('ready');

    expect((await post(copilot('session-start.json'), 'copilot')).status).toBe(202);

    expect(lastEvent('copilot')?.event).toBe('session_start');
    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'copilot', 'copilot')).toBe(
      lastEvent('copilot')?.at
    );
  });

  it('records copilot SessionStart normally when it is the first event of the session', async () => {
    expect((await post(copilot('session-start.json'), 'copilot')).status).toBe(202);

    expect(lastEvent('copilot')?.event).toBe('session_start');
    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, 'copilot', 'copilot')).toBe(
      lastEvent('copilot')?.at
    );
  });

  it('records a SessionStart that names a different agent session — a real relaunch', async () => {
    await post(copilot('user-prompt-submit.json', { sessionId: SESSION_A }), 'copilot');
    await post(copilot('session-start.json', { sessionId: SESSION_B }), 'copilot');

    // The turn was open and copilot declares the capability, so the only thing
    // separating this from the first case is the id. A relaunched process must
    // not inherit the dead one's `running`.
    expect(lastEvent('copilot')?.event).toBe('session_start');
    expect(structured('copilot')).toBeNull();
  });

  it('holds a SessionStart that carries no session id at all', async () => {
    await post(copilot('user-prompt-submit.json', { sessionId: SESSION_A }), 'copilot');
    await post(copilot('session-start.json', { sessionId: null }), 'copilot');

    // "No id" is what a hand-configured #1549 relay hook posts, and the fix has
    // to survive it. Bounded by the staleness rule below rather than by the id.
    expect(structured('copilot')?.status).toBe('running');
  });
});

describe('the capability is what is read, not the tool id (Issue #1903)', () => {
  it('puts the overwrite back when copilot declares sessionStartMayArriveLate: false', async () => {
    await withCapabilities(
      getAgentEventSource('copilot'),
      { sessionStartMayArriveLate: false },
      async () => {
        await post(copilot('user-prompt-submit.json'), 'copilot');
        await post(copilot('session-start.json'), 'copilot');

        expect(structured('copilot')).toBeNull();
        expect(lastEvent('copilot')?.event).toBe('session_start');
      }
    );
  });

  it('holds claude’s late SessionStart when claude declares sessionStartMayArriveLate: true', async () => {
    await withCapabilities(
      getAgentEventSource('claude'),
      { sessionStartMayArriveLate: true },
      async () => {
        await post(claude('user-prompt-submit.json'), 'claude');
        await post(claude('session-start.json'), 'claude');

        expect(structured('claude')).toMatchObject({
          status: 'running',
          reason: HOOK_STATUS_REASON.PROMPT_SUBMIT,
        });
      }
    );
  });
});

/**
 * The state machine on its own, with the timestamps written out.
 *
 * The route stamps `Date.now()`, so the bounds — 30 minutes of staleness, the
 * generation fence — are only reachable by calling `recordAgentEvent` directly.
 * The capability is passed here the same way the route passes it.
 */
describe('what stops a held frame from pinning a dead process (Issue #1903)', () => {
  const TOOL: CLIToolType = 'copilot';
  const LATE = { sessionStartMayArriveLate: true } as const;
  const T0 = 1_700_000_000_000;

  const submit = (at: number, sessionId: string | null = SESSION_A) =>
    recordAgentEvent(
      WORKTREE_ID,
      TOOL,
      TOOL,
      { event: 'user_prompt_submit', at, detail: null, sessionId },
      LATE
    );

  const sessionStart = (at: number, sessionId: string | null = SESSION_A, model?: string) =>
    recordAgentEvent(
      WORKTREE_ID,
      TOOL,
      TOOL,
      { event: 'session_start', at, detail: null, sessionId, model },
      LATE
    );

  it('reports the hold to its caller instead of dropping it silently', () => {
    expect(submit(T0)).toEqual({ recorded: true });
    expect(sessionStart(T0 + 12_000)).toEqual({ recorded: false, skipped: 'late-session-start' });
  });

  it('does not extend the turn it held the frame for', () => {
    submit(T0);
    sessionStart(T0 + 12_000);

    // The held frame is not the record, so the staleness bound is still measured
    // from the `UserPromptSubmit`. One millisecond before the bound the verdict
    // stands; at the bound the scraper has the session back. Without this an
    // agent killed mid-turn would publish `running` from a fresh 30-minute
    // clock every time it reported a start.
    expect(structured(TOOL, T0 + STRUCTURED_STATE_MAX_AGE_MS - 1)?.status).toBe('running');
    expect(structured(TOOL, T0 + STRUCTURED_STATE_MAX_AGE_MS)).toBeNull();
  });

  it('records the frame once the turn it would have joined has gone stale', () => {
    submit(T0);
    const late = T0 + STRUCTURED_STATE_MAX_AGE_MS + 1;

    expect(sessionStart(late)).toEqual({ recorded: true });
    expect(getAgentEventGenerationStartedAt(WORKTREE_ID, TOOL, TOOL)).toBe(late);
  });

  it('still lets beginAgentEventGeneration take the instance back', () => {
    submit(T0);
    sessionStart(T0 + 12_000);
    expect(structured(TOOL, T0 + 13_000)?.status).toBe('running');

    // Every session CommandMate itself (re)starts goes through here, so the
    // hold never survives a restart this server performed — only one performed
    // by hand inside the pane, which is what the staleness bound is for.
    beginAgentEventGeneration(WORKTREE_ID, TOOL, TOOL, T0 + 20_000);
    expect(structured(TOOL, T0 + 21_000)).toBeNull();
  });

  it('treats an open dialog as an open turn, and leaves the dialog standing', () => {
    recordAgentEvent(
      WORKTREE_ID,
      TOOL,
      TOOL,
      {
        event: 'notification',
        at: T0,
        detail: 'permission_prompt',
        sessionId: SESSION_A,
        message: 'needs your permission to use Bash',
      },
      LATE
    );
    expect(structured(TOOL, T0 + 1)?.status).toBe('waiting');

    expect(sessionStart(T0 + 12_000)).toEqual({ recorded: false, skipped: 'late-session-start' });
    // `session_start` is a release in `applyPromptWaitingTransition`. Holding the
    // frame has to hold that too, or the fix would answer `running` for a pane
    // with an approval box on it — the state #1725 exists to publish.
    expect(getStructuredPromptWaiting(WORKTREE_ID, TOOL, TOOL, T0 + 12_001)).not.toBeNull();
    expect(structured(TOOL, T0 + 12_001)?.status).toBe('waiting');
  });

  it('latches a model reported on a held frame', () => {
    submit(T0);
    sessionStart(T0 + 12_000, SESSION_A, 'claude-sonnet-4.5');

    // The model is not part of the turn. `SessionStart` is the one event Claude
    // puts a model on (#1783), so a source that declared this capability and
    // reported one would otherwise be the single place where the value is
    // extracted and then dropped.
    expect(getLastKnownAgentModel(WORKTREE_ID, TOOL, TOOL)).toBe('claude-sonnet-4.5');
  });
});
