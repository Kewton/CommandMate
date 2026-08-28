/**
 * Deciding WHICH opencode session an instance was in, before the pane that
 * knows dies (Issue #2038).
 *
 * The case that makes this module more than a getter is the sub-agent. One
 * opencode server carries several sessions at once and a `task` sub-agent runs
 * in one of its own, whose frames arrive on the same stream (#1758 §5.6.1,
 * #1900) — so "the last sessionID CommandMate saw" is, after a delegated turn,
 * the delegate's. Resuming that would drop the operator into the middle of a
 * sub-task. The turn gate already knows better, but its answer dies with the SSE
 * connection, so the parentage is re-established from opencode's own
 * `Session.parentID` while the server is still up.
 *
 * The second is the directory guard: the recorded path is opencode's
 * `Session.directory`, checked against the port assignment's worktree, so the
 * comparison is the agent's answer against CommandMate's.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { discardAgentEventState, recordAgentEvent } from '@/lib/session/agent-event-state';
import {
  captureOpencodeSessionMemory,
  resolveOpencodeCurrentSessionId,
} from '@/lib/session/opencode-session-recall';
import {
  getRememberedOpencodeSession,
  rememberOpencodeSession,
  resetOpencodeSessionMemories,
} from '@/lib/session/opencode-session-store';

const WORKTREE_ID = 'wt-recall-2038';
const WORKTREE_PATH = '/tmp/wt-recall-2038';
const PORT = 4233;
const ROOT_ID = 'ses_root00000000000000000000';
const CHILD_ID = 'ses_child0000000000000000000';

const target: AgentInstanceRef = { worktreeId: WORKTREE_ID, cliToolId: 'opencode' };

let sandbox: string;
const savedEnv: Record<string, string | undefined> = {};

function session(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    slug: 'slug',
    projectID: 'global',
    directory: WORKTREE_PATH,
    title: `title of ${id}`,
    version: '1.18.22',
    time: { created: 1, updated: 1 },
    ...extra,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

/** Serve a fixed set of sessions by id; anything else 404s. */
function serve(sessions: Record<string, Record<string, unknown>>) {
  const fetchMock = vi.fn(async (url: string) => {
    const id = new URL(url).pathname.split('/').pop() ?? '';
    const body = sessions[id];
    return body ? jsonResponse(body) : jsonResponse({ name: 'NotFoundError' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The instance's last structured event named this session. */
function observe(sessionId: string): void {
  recordAgentEvent(WORKTREE_ID, 'opencode', undefined, {
    event: 'stop',
    at: Date.now(),
    detail: null,
    sessionId,
  });
}

beforeEach(() => {
  sandbox = makeTempDir('opencode-recall-2038-');
  for (const key of ['CM_OPENCODE_PORT_FILE', 'CM_OPENCODE_SESSION_FILE'] as const) {
    savedEnv[key] = process.env[key];
  }
  process.env.CM_OPENCODE_PORT_FILE = join(sandbox, 'opencode-ports.json');
  process.env.CM_OPENCODE_SESSION_FILE = join(sandbox, 'opencode-sessions.json');
  resetOpencodePortAssignments();
  resetOpencodeSessionMemories();
  // `lastAgentEvent` is a `globalThis` singleton (#1736), so one test's
  // observation would otherwise be the next one's starting state.
  discardAgentEventState(WORKTREE_ID, 'opencode');
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetOpencodePortAssignments();
  resetOpencodeSessionMemories();
  discardAgentEventState(WORKTREE_ID, 'opencode');
  removeTempDir(sandbox);
});

describe('captureOpencodeSessionMemory', () => {
  it('records the session the instance was in, with opencode own title', async () => {
    rememberOpencodePort(target, PORT, WORKTREE_PATH);
    observe(ROOT_ID);
    serve({ [ROOT_ID]: session(ROOT_ID) });

    const outcome = await captureOpencodeSessionMemory(target);
    expect(outcome).toMatchObject({ captured: true });
    expect(getRememberedOpencodeSession(target)).toMatchObject({
      sessionId: ROOT_ID,
      title: `title of ${ROOT_ID}`,
      worktreePath: WORKTREE_PATH,
    });
  });

  it('walks up parentID, so a sub-agent turn does not become the resumed session', async () => {
    rememberOpencodePort(target, PORT, WORKTREE_PATH);
    // The last thing on the stream was the delegate's completion.
    observe(CHILD_ID);
    serve({
      [CHILD_ID]: session(CHILD_ID, { parentID: ROOT_ID }),
      [ROOT_ID]: session(ROOT_ID),
    });

    const outcome = await captureOpencodeSessionMemory(target);
    expect(outcome).toMatchObject({ captured: true });
    expect(getRememberedOpencodeSession(target)?.sessionId).toBe(ROOT_ID);
  });

  it('refuses a session opencode says lives in another directory', async () => {
    rememberOpencodePort(target, PORT, WORKTREE_PATH);
    observe(ROOT_ID);
    serve({ [ROOT_ID]: session(ROOT_ID, { directory: '/tmp/somewhere-else' }) });

    expect(await captureOpencodeSessionMemory(target)).toEqual({
      captured: false,
      skipped: 'directory-mismatch',
    });
    expect(getRememberedOpencodeSession(target)).toBeNull();
  });

  it('skips when no port was assigned — there is nothing to verify against', async () => {
    observe(ROOT_ID);
    const fetchMock = serve({ [ROOT_ID]: session(ROOT_ID) });

    expect(await captureOpencodeSessionMemory(target)).toEqual({
      captured: false,
      skipped: 'no-port',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when nothing on the stream ever named a session', async () => {
    rememberOpencodePort(target, PORT, WORKTREE_PATH);
    serve({});
    expect(await captureOpencodeSessionMemory(target)).toEqual({
      captured: false,
      skipped: 'no-session-observed',
    });
  });

  it('skips when the server can no longer describe the session', async () => {
    rememberOpencodePort(target, PORT, WORKTREE_PATH);
    observe(ROOT_ID);
    serve({});
    expect(await captureOpencodeSessionMemory(target)).toEqual({
      captured: false,
      skipped: 'session-unreadable',
    });
  });
});

describe('resolveOpencodeCurrentSessionId', () => {
  it('prefers the live root session', async () => {
    rememberOpencodePort(target, PORT, WORKTREE_PATH);
    observe(CHILD_ID);
    serve({
      [CHILD_ID]: session(CHILD_ID, { parentID: ROOT_ID }),
      [ROOT_ID]: session(ROOT_ID),
    });
    await expect(resolveOpencodeCurrentSessionId(target)).resolves.toBe(ROOT_ID);
  });

  it('falls back to what was persisted when nothing is live', async () => {
    rememberOpencodeSession(target, { sessionId: ROOT_ID, worktreePath: WORKTREE_PATH });
    serve({});
    await expect(resolveOpencodeCurrentSessionId(target)).resolves.toBe(ROOT_ID);
  });

  it('answers null when neither knows', async () => {
    serve({});
    await expect(resolveOpencodeCurrentSessionId(target)).resolves.toBeNull();
  });
});
