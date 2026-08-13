/**
 * Copilot's events and verdicts, end to end through the two receivers
 * (Issue #1761).
 *
 * The unit suites prove that the source maps payloads and encodes verdicts.
 * What is only visible here is that the *route* reaches that source: the whole
 * of #1759's design is that `POST /api/hooks/agent-event` reads `tool` and asks
 * a registry, so a copilot source that exists and is never consulted would pass
 * every unit test in the phase and deliver nothing.
 *
 * It would also not be obvious. An unregistered tool falls back to the legacy
 * relay source, whose CamelCase table is the same one copilot uses — so five of
 * the six events below would still map, and only the permission path would be
 * quietly wrong. Hence the verdict assertions, which are the half the fallback
 * gets wrong: it answers in *Claude's* spelling, which copilot accepts, ignores,
 * and shows a dialog for.
 *
 * Both request shapes copilot can produce are exercised, because CommandMate
 * generates both: the relay script posts `{tool, event, cwd, worktreeId, …}`
 * and the inline-`curl` fallback posts copilot's own payload with the
 * correlation keys in the query string.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';

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

vi.mock('@/lib/polling/auto-yes-policy', () => ({
  getSessionAutoYesPolicy: () => null,
  invalidateSessionAutoYesPolicy: () => {},
  clearAutoYesPolicyCache: () => {},
}));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: (...a: unknown[]) => isRunning(...a) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));

import { POST as agentEvent } from '@/app/api/hooks/agent-event/route';
import { POST as permissionRequest } from '@/app/api/hooks/permission-request/route';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  clearAgentStopEvents,
  getLastAgentEvent,
  getStructuredSessionState,
} from '@/lib/session/agent-event-state';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/copilot');
const WT = 'wt-copilot-1761';
const WT_PATH = process.cwd();
const ONE_HOUR_MS = 3_600_000;

/** No generation indicator in it, so the scraper cannot decide anything. */
const UNREADABLE_FRAME = 'working\n';

let db: Database.Database;

const asReq = (req: Request) => req as unknown as NextRequest;

/** One payload copilot actually sent, with `cwd` pointed at the test worktree. */
function payload(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
  return { ...raw, cwd: WT_PATH };
}

/**
 * Post copilot's own payload with the keys in the query string — what the
 * inline-`curl` command does when the relay script is not on disk.
 */
async function postNativePayload(name: string, instanceId = 'copilot') {
  const response = await agentEvent(
    asReq(
      new Request(
        `http://127.0.0.1:3000/api/hooks/agent-event?tool=copilot&worktreeId=${WT}&instanceId=${instanceId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload(name)),
        }
      )
    )
  );
  return { status: response.status, body: await response.json() };
}

/** Post the body `scripts/hooks/cmate-agent-event.sh` builds from that payload. */
async function postRelayBody(event: string, detail: string | null, instanceId = 'copilot') {
  const response = await agentEvent(
    asReq(
      new Request('http://127.0.0.1:3000/api/hooks/agent-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'copilot',
          event,
          cwd: WT_PATH,
          sessionId: '00000000-0000-4000-8000-000000000000',
          worktreeId: WT,
          instanceId,
          ...(detail === null ? {} : { detail }),
        }),
      })
    )
  );
  return { status: response.status, body: await response.json() };
}

async function postPermission(body: unknown, instanceId = 'copilot') {
  const response = await permissionRequest(
    asReq(
      new Request(
        `http://127.0.0.1:3000/api/hooks/permission-request?tool=copilot&worktreeId=${WT}&instanceId=${instanceId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      )
    )
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  const worktree: Worktree = {
    id: WT,
    name: 'issue-1761',
    path: WT_PATH,
    repositoryPath: WT_PATH,
    repositoryName: 'CommandMate',
  };
  upsertWorktree(db, worktree);

  vi.clearAllMocks();
  clearAgentStopEvents();
  clearAllAutoYesStates();
  clearPolicySuppressions();
  globalThis.__agentEventLast?.clear();
  globalThis.__agentEventGenerationStartedAt?.clear();
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue(UNREADABLE_FRAME);
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  db.close();
  clearAgentStopEvents();
  clearAllAutoYesStates();
  clearPolicySuppressions();
});

describe('every captured copilot payload reaches the event store', () => {
  const CASES: ReadonlyArray<[string, string, string | null]> = [
    ['session-start', 'session_start', 'new'],
    ['user-prompt-submit', 'user_prompt_submit', null],
    ['pre-tool-use', 'pre_tool_use', 'Bash'],
    ['post-tool-use', 'post_tool_use', 'Bash'],
    ['stop', 'stop', null],
    ['session-end', 'session_end', 'complete'],
  ];

  it.each(CASES)('%s arrives as %s (detail %s)', async (name, event, detail) => {
    const { status, body } = await postNativePayload(name);

    expect(status).toBe(202);
    expect(body).toEqual({ accepted: true });
    const last = getLastAgentEvent(WT, 'copilot', 'copilot');
    expect(last?.event).toBe(event);
    expect(last?.detail).toBe(detail);
  });

  it('reads the same words out of the relay script’s body shape', async () => {
    // The relay resolves the word itself and posts CommandMate's shape; the
    // route hands that word to the source rather than re-deriving it. Both
    // paths exist in the generated config, so both are exercised.
    const { status } = await postRelayBody('stop', null);

    expect(status).toBe(202);
    expect(getLastAgentEvent(WT, 'copilot', 'copilot')?.event).toBe('stop');
  });

  it('refuses a spelling copilot does not have, without 500ing', async () => {
    const response = await agentEvent(
      asReq(
        new Request(
          `http://127.0.0.1:3000/api/hooks/agent-event?tool=copilot&worktreeId=${WT}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hook_event_name: 'BeforeAgent', cwd: WT_PATH }),
          }
        )
      )
    );

    // `BeforeAgent` is gemini's. Filing it under something adjacent would
    // publish a meaning nothing agreed to, so it is a 400 the operator can see.
    expect(response.status).toBe(400);
  });
});

describe('the events become a session verdict', () => {
  it('a Stop makes the session ready, for hook_stop reasons', async () => {
    const before = await buildCurrentOutput(db, WT, 'copilot', 'copilot');
    expect(before.sessionStatus).toBe('running');

    await postNativePayload('stop');

    const after = await buildCurrentOutput(db, WT, 'copilot', 'copilot');
    expect(after.sessionStatus).toBe('ready');
    expect(after.sessionStatusReason).toBe('hook_stop');
    expect(after.structuredEvents.lastEventType).toBe('stop');
  });

  it('a UserPromptSubmit keeps it running even though SessionStart has not arrived', async () => {
    // Copilot fires these two the other way round from every other tool
    // (20.813Z vs 20.915Z). A verdict that waited for `session_start` first
    // would be wrong for the whole of copilot's first turn.
    await postNativePayload('user-prompt-submit');

    const payloadOut = await buildCurrentOutput(db, WT, 'copilot', 'copilot');
    expect(payloadOut.sessionStatus).toBe('running');
    expect(payloadOut.sessionStatusReason).toBe('hook_prompt_submit');
  });

  it('keeps two instances of one worktree apart', async () => {
    // The reason the correlation keys travel in the agent's environment: one
    // global settings.json serves both, so nothing in the file distinguishes
    // them and everything in the request has to.
    await postNativePayload('stop', 'copilot');
    await postNativePayload('user-prompt-submit', 'copilot-2');

    expect(getStructuredSessionState(WT, 'copilot', 'copilot')?.status).toBe('ready');
    expect(getStructuredSessionState(WT, 'copilot', 'copilot-2')?.status).toBe('running');
    expect((await buildCurrentOutput(db, WT, 'copilot', 'copilot-2')).sessionStatusReason).toBe(
      'hook_prompt_submit'
    );
  });
});

describe('approvals are answered in copilot’s spelling', () => {
  /** What the hook's stdout has to be for copilot to run the call unattended. */
  const COPILOT_ALLOW_BODY = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  };

  it('approves a PreToolUse when Auto-Yes is on', async () => {
    setAutoYesEnabled(WT, 'copilot', true, ONE_HOUR_MS);

    const { status, body } = await postPermission(payload('pre-tool-use'));

    expect(status).toBe(200);
    expect(body).toEqual(COPILOT_ALLOW_BODY);
  });

  it('does not answer in Claude’s spelling, which copilot ignores in silence', async () => {
    // The failure the registry lookup prevents: an unregistered copilot falls
    // back to the legacy source, which encodes `decision: {behavior: 'allow'}`.
    // Copilot accepts that body, does nothing with it, and shows the dialog —
    // an Auto-Yes that reports success and approves nothing.
    setAutoYesEnabled(WT, 'copilot', true, ONE_HOUR_MS);

    const { body } = await postPermission(payload('pre-tool-use'));

    expect((body as Record<string, Record<string, unknown>>).hookSpecificOutput.decision)
      .toBeUndefined();
  });

  it('abstains as the empty object when Auto-Yes is off', async () => {
    const { status, body } = await postPermission(payload('pre-tool-use'));

    expect(status).toBe(200);
    expect(body).toEqual({});
  });

  it('abstains for an instance whose Auto-Yes is off, next to one where it is on', async () => {
    setAutoYesEnabled(WT, 'copilot', true, ONE_HOUR_MS, undefined, 'copilot-2');

    expect((await postPermission(payload('pre-tool-use'), 'copilot-2')).body).toEqual(
      COPILOT_ALLOW_BODY
    );
    expect((await postPermission(payload('pre-tool-use'), 'copilot')).body).toEqual({});
  });

  it('abstains on a payload it cannot read, rather than guessing', async () => {
    setAutoYesEnabled(WT, 'copilot', true, ONE_HOUR_MS);

    // `Stop` is not a request for permission to do anything.
    expect((await postPermission(payload('stop'))).body).toEqual({});
  });
});
