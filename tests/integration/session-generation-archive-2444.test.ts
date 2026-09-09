/**
 * A new agent process retires the previous one's chat history (Issue #2444),
 * end to end: the real `beginAgentSession`, the real archive module, the real
 * `chat_messages` schema, and codex's real `launchSession` branches.
 *
 * The reported defect is what happens when a session ends *outside*
 * CommandMate — the tmux server went away, the CLI was `/exit`ed back to its
 * shell, the machine rebooted. `archived` had one writer, `kill-session`, and
 * that route returns 404 before reaching it once there is no live session left
 * to kill, so the dead session's rows stayed `archived = 0` and the chat
 * surface presented them as the current conversation indefinitely.
 *
 * What is deliberately NOT mocked here is the seam itself. The unit suites pin
 * the halves — `session-generation-archive-2444` the SQL scope,
 * `agent-session-lifecycle-1759` the wiring — and both mock the other side. This
 * file is the only place where a real `launchSession` reaches a real database,
 * which is where the two claims that matter live: a relaunch into the same pane
 * archives, and a reuse of the live process does not.
 *
 * `VITEST` is cleared per test because `resolveSessionArchiveDatabase` refuses
 * to open a database under Vitest — see its docblock; the point of the guard is
 * that a suite which never asked for a database cannot be handed the
 * developer's real one. Clearing it plus a mocked `getDbInstance` is how a suite
 * that *did* ask drives the production branch.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const dbHolder = vi.hoisted(() => ({ db: null as unknown }));
const broadcastMessage = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => dbHolder.db),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage }));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  getSessionWorkingDirectory: vi.fn().mockResolvedValue('/tmp/wt'),
}));
vi.mock('@/lib/cli-tools/validation', () => ({ validateSessionName: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('child_process', () => ({ exec: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return { ...actual, promisify: () => vi.fn().mockResolvedValue(undefined) };
});

import { runMigrations } from '@/lib/db/db-migrations';
import { createMessage, getMessages, upsertWorktree, getWorktreeById } from '@/lib/db';
import { beginAgentSession } from '@/lib/session/agent-session-lifecycle';
import { MESSAGES_INVALIDATED_EVENT_TYPE } from '@/lib/realtime/types';
import { CodexTool } from '@/lib/cli-tools/codex';
import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { hasSession, createSession, sendKeys, capturePane } from '@/lib/tmux/tmux';
import { LIVENESS_CONFIRM_DELAY_MS } from '@/config/cli-tool-timing-config';
import type { Worktree } from '@/types/models';

const FIXTURES = path.join(process.cwd(), 'tests/fixtures/tool-liveness-2070');
const READY = fs.readFileSync(path.join(FIXTURES, 'codex-ready-01491.txt'), 'utf-8');
const EXITED = fs.readFileSync(path.join(FIXTURES, 'codex-exited-01491.txt'), 'utf-8');

const WT = 'wt-2444-int';
let db: Database.Database;

function seed(content: string, instanceId: string, at: number, role: 'user' | 'assistant' = 'user') {
  createMessage(db, {
    worktreeId: WT,
    role,
    content,
    timestamp: new Date(at),
    messageType: 'normal',
    cliToolId: 'codex',
    instanceId,
  });
}

/** `getMessages` answers newest-first; these read chronologically. */
function activeContents(instanceId: string): string[] {
  return getMessages(db, WT, { instanceId })
    .map((m) => m.content)
    .reverse();
}

function archivedContents(instanceId: string): string[] {
  return getMessages(db, WT, { instanceId, includeArchived: true })
    .filter((m) => m.archived)
    .map((m) => m.content)
    .reverse();
}

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  runMigrations(db);
  dbHolder.db = db;
  const worktree: Worktree = {
    id: WT,
    name: WT,
    path: '/repo/wt',
    repositoryPath: '/repo',
    repositoryName: 'repo',
    cliToolId: 'codex',
  };
  upsertWorktree(db, worktree);
  globalThis.__agentEventGenerationStartedAt?.clear();
  globalThis.__agentEventLast?.clear();
  // See the module docblock: this is what puts `resolveSessionArchiveDatabase`
  // on its production branch.
  vi.stubEnv('VITEST', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

describe('[#2444] a new agent process retires the previous session', () => {
  it('archives the dead session and leaves only the rows written after it', async () => {
    seed('question the dead session answered', 'codex', 1_000);
    seed('the dead answer', 'codex', 1_100, 'assistant');

    beginAgentSession({ worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' });

    expect(activeContents('codex')).toEqual([]);
    expect(archivedContents('codex')).toEqual([
      'question the dead session answered',
      'the dead answer',
    ]);

    // The user row of the send that triggered the start is written afterwards
    // and is the only active row left — the acceptance criterion's shape.
    seed('the question that restarted it', 'codex', 2_000);
    expect(activeContents('codex')).toEqual(['the question that restarted it']);

    await vi.waitFor(() =>
      expect(broadcastMessage).toHaveBeenCalledWith(MESSAGES_INVALIDATED_EVENT_TYPE, {
        worktreeId: WT,
        cliToolId: 'codex',
        instanceId: 'codex',
        reason: 'session_generation',
      }),
    );
  });

  it('leaves a sibling instance of the same tool alone and recomputes the sidebar', () => {
    // The dead session wrote last, so the sidebar starts out quoting it —
    // `createMessage` sets `last_user_message` on every user row. Seeded the
    // other way round the recompute assertion below would pass without a
    // recompute happening at all.
    seed('codex-2 question', 'codex-2', 1_000);
    seed('codex question', 'codex', 2_000);
    expect(getWorktreeById(db, WT)?.lastUserMessage).toBe('codex question');

    beginAgentSession({ worktreeId: WT, cliToolId: 'codex', instanceId: 'codex' });

    // Restarting codex must not wipe codex-2: same worktree, same tool id, a
    // process that is still alive.
    expect(activeContents('codex-2')).toEqual(['codex-2 question']);
    // …and the sidebar now quotes the conversation that survived.
    expect(getWorktreeById(db, WT)?.lastUserMessage).toBe('codex-2 question');
  });

  describe('through codex’s real launchSession', () => {
    let tool: CodexTool;

    beforeEach(() => {
      tool = new CodexTool();
      seed('written by the process in this pane', 'codex', 1_000);
    });

    /** Fake the confirm delay, codex's init wait and its readiness poll. */
    async function start(): Promise<void> {
      vi.useFakeTimers();
      try {
        const started = tool.startSession(WT, '/tmp/wt');
        await vi.advanceTimersByTimeAsync(LIVENESS_CONFIRM_DELAY_MS + 10_000);
        await started;
      } finally {
        vi.useRealTimers();
      }
    }

    it('archives when the pane outlived its agent and the launch line is re-sent', async () => {
      // The `/exit`-to-a-shell ending: same tmux session, new codex process.
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane)
        .mockResolvedValueOnce(EXITED)
        .mockResolvedValueOnce(EXITED)
        .mockResolvedValue(READY);

      await start();

      expect(createSession).not.toHaveBeenCalled();
      expect(sendKeys).toHaveBeenCalled();
      expect(activeContents('codex')).toEqual([]);
      expect(archivedContents('codex')).toEqual(['written by the process in this pane']);
    });

    it('archives when a pane is created from nothing', async () => {
      // The tmux-server-went-away ending: the rows outlived the pane itself.
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(capturePane).mockResolvedValue(READY);

      await start();

      expect(createSession).toHaveBeenCalled();
      expect(activeContents('codex')).toEqual([]);
    });

    /**
     * MUTATION TARGET (acceptance criterion 「`beginAgentSession`が呼ばれない経路で
     * 行が減らないことを変異注入で確認する」): move the `beginAgentSession` call in
     * `codex.ts` above the healthy-reuse `return`, or add one to opencode's
     * live-reuse branch, and this goes red. It is the assertion that a `/send`
     * to a session that is alive does not delete the conversation it is in the
     * middle of.
     */
    it('archives NOTHING when the running agent is reused', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue(READY);

      await start();

      expect(sendKeys).not.toHaveBeenCalled();
      expect(activeContents('codex')).toEqual(['written by the process in this pane']);
      expect(archivedContents('codex')).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(broadcastMessage).not.toHaveBeenCalled();
    });
  });

  // vibe-local is the tool that never called `beginAgentSession` at all, so it
  // is the one whose creation path has to be shown reaching the database rather
  // than merely reaching the seam. Its unit suite asserts the call; this
  // asserts the rows.
  it('archives through vibe-local’s creation path too', async () => {
    const tool = new VibeLocalTool();
    createMessage(db, {
      worktreeId: WT,
      role: 'user',
      content: 'asked before vibe-local died',
      timestamp: new Date(1_000),
      messageType: 'normal',
      cliToolId: 'vibe-local',
      instanceId: 'vibe-local',
    });
    vi.mocked(hasSession).mockResolvedValue(false);

    vi.useFakeTimers();
    try {
      const started = tool.startSession(WT, '/tmp/wt');
      await vi.advanceTimersByTimeAsync(30_000);
      await started;
    } finally {
      vi.useRealTimers();
    }

    expect(activeContents('vibe-local')).toEqual([]);
    expect(archivedContents('vibe-local')).toEqual(['asked before vibe-local died']);
  });
});
