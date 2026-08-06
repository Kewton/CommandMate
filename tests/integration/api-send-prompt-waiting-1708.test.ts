/**
 * Issue #1708: `send` must refuse to type into an open prompt dialog.
 *
 * A prompt dialog does not forward keystrokes to the agent — text typed while
 * one is up accumulates in the dialog's own input line. Issue #1708's dispatch
 * runner did exactly that: it read "no progress", sent a nudge, and left a
 * half-typed message sitting under the dialog. The next `respond` then had to
 * answer a prompt whose input line already contained somebody else's text,
 * which is how an "answer" gets delivered as a message instead.
 *
 * The guard is deliberately ASYMMETRIC and that asymmetry is tested here:
 *
 *   - `send` is refused, because a send has no business arriving mid-prompt.
 *   - `respond` / `special-keys` / `prompt-response` are NOT, because they are
 *     the only ways out of this state. Blocking them would trade a lost message
 *     for a session nobody can unblock.
 *   - It only fires when the prompt IS detected. A frame that slips past
 *     detection is not covered here at all — that is what the `wait` dwell
 *     (Issue #1708 B-1) is for.
 *
 * The "prompt on screen" fixture is the live capture from the detection half of
 * this Issue, so the two halves are wired to the same reality.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

vi.mock('@/lib/session/claude-session', () => ({
  startClaudeSession: vi.fn(),
  isClaudeRunning: vi.fn(() => Promise.resolve(true)),
  sendMessageToClaude: vi.fn(),
  isClaudeInstalled: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@/lib/session/cli-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/session/cli-session')>();
  return { ...actual, captureSessionOutput: vi.fn() };
});

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
      mockDb = null;
    },
  };
});

import { POST as sendMessage } from '@/app/api/worktrees/[id]/send/route';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { sendMessageToClaude } from '@/lib/session/claude-session';
import { PROMPT_WAITING_CODE } from '@/lib/session/prompt-waiting-guard';

const FIXTURE_DIR = fileURLToPath(
  new URL('../unit/lib/detection/fixtures/claude-live-1708/', import.meta.url)
);

/** A live Claude frame with an unanswered permission dialog on it. */
const PROMPT_FRAME = readFileSync(`${FIXTURE_DIR}bash-approval-taskpanel.txt`, 'utf8');
/** The same session, idle at its composer. */
const IDLE_FRAME = readFileSync(`${FIXTURE_DIR}idle-taskpanel.txt`, 'utf8');

const WORKTREE_ID = 'wt-send-guard';

function post(body: unknown) {
  const request = new Request(`http://localhost:3000/api/worktrees/${WORKTREE_ID}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return sendMessage(request as unknown as import('next/server').NextRequest, {
    params: Promise.resolve({ id: WORKTREE_ID }),
  });
}

describe('POST /send refuses while a prompt is waiting (Issue #1708)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as {
      setMockDb: (d: Database.Database) => void;
    };
    setMockDb(db);
    vi.clearAllMocks();

    const worktree: Worktree = {
      id: WORKTREE_ID,
      name: 'Send Guard',
      path: '/path/to/send-guard',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('returns 409 PROMPT_WAITING and does not touch the session', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);

    const response = await post({ content: 'nudge: are you still working?' });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe(PROMPT_WAITING_CODE);
    // The refusal has to name the way out, or a runner just retries the nudge.
    expect(body.error).toContain('respond');

    // The whole point: nothing was typed into the dialog's input line.
    expect(sendMessageToClaude).not.toHaveBeenCalled();
  });

  it('records no chat message for the refused send', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);
    await post({ content: 'nudge' });

    const { getMessages } = await import('@/lib/db');
    expect(getMessages(db, WORKTREE_ID, { limit: 10 })).toHaveLength(0);
  });

  it('sends normally when the session is idle at its composer', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_FRAME);

    const response = await post({ content: 'go ahead' });

    expect(response.status).toBe(201);
    expect(sendMessageToClaude).toHaveBeenCalledWith(WORKTREE_ID, 'go ahead', undefined);
  });

  it('fails open when the pane cannot be captured', async () => {
    // A capture failure must not make the session unwritable: the cost of a
    // missed guard is the pre-#1708 behaviour, the cost of a false refusal is a
    // session nobody can talk to.
    vi.mocked(captureSessionOutput).mockRejectedValue(new Error('tmux gone'));

    const response = await post({ content: 'go ahead' });

    expect(response.status).toBe(201);
    expect(sendMessageToClaude).toHaveBeenCalled();
  });
});

describe('sendUserMessage itself refuses, so scheduled sends are covered too (Issue #1708)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);
    const { setMockDb } = (await import('@/lib/db/db-instance')) as unknown as {
      setMockDb: (d: Database.Database) => void;
    };
    setMockDb(db);
    vi.clearAllMocks();
    upsertWorktree(db, {
      id: WORKTREE_ID,
      name: 'Send Guard',
      path: '/path/to/send-guard',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    });
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('refuses at the service layer, which is what the timer manager calls', async () => {
    // src/lib/timer-manager.ts calls sendUserMessage directly. A guard placed in
    // the send route would have left a scheduled message firing into an open
    // dialog on its own timetable, with nobody watching.
    vi.mocked(captureSessionOutput).mockResolvedValue(PROMPT_FRAME);
    const { sendUserMessage } = await import('@/lib/session/send-user-message');

    const result = await sendUserMessage(db, {
      worktreeId: WORKTREE_ID,
      content: 'scheduled nudge',
      cliToolId: 'claude',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe('prompt_waiting');
    expect(result.ok === false && result.error).toContain('respond');
    expect(sendMessageToClaude).not.toHaveBeenCalled();
    // The timer manager persists `[stage] error` as the timer's failure reason,
    // so the refusal explains itself in the UI with no change on its side.
  });

  it('sends at the service layer when nothing is waiting', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(IDLE_FRAME);
    const { sendUserMessage } = await import('@/lib/session/send-user-message');

    const result = await sendUserMessage(db, {
      worktreeId: WORKTREE_ID,
      content: 'scheduled nudge',
      cliToolId: 'claude',
    });

    expect(result.ok).toBe(true);
    expect(sendMessageToClaude).toHaveBeenCalled();
  });
});

describe('the guard covers every message-send path and no answer path (Issue #1708)', () => {
  // Structural, and deliberately so. The guard sits in sendUserMessage() because
  // that is the choke point for typing a message at an agent. Two invariants keep
  // it honest, and neither is visible from any single file:
  //
  //   1. Everything that types a message goes through sendUserMessage(). The
  //      timer manager calls it directly, and a guard placed in the send route
  //      would have let scheduled sends fire into open dialogs.
  //   2. respond / special-keys / prompt-response do NOT go through it. They are
  //      the only way out of this state; if they ever start routing through
  //      sendUserMessage they will begin refusing too, and the session becomes
  //      unblockable — the one failure worse than the one being fixed.
  const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

  /**
   * Files that IMPORT `module`. Matched on the import statement rather than on
   * the bare name, so a mention in a comment does not count as a dependency —
   * the first cut of this test did, and reported two prose references as
   * callers.
   */
  function importersOf(module: string): string[] {
    const importRe = new RegExp(`from\\s+['"][^'"]*${module}['"]`);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && importRe.test(readFileSync(full, 'utf8'))) {
          hits.push(relative(SRC, full));
        }
      }
    };
    walk(SRC);
    return hits.sort();
  }

  it('is called only from sendUserMessage', () => {
    expect(importersOf('prompt-waiting-guard')).toEqual([
      'app/api/worktrees/[id]/send/route.ts', // PROMPT_WAITING_CODE only, see below
      'lib/session/send-user-message.ts',
    ]);
    // The route imports the status code to map the refusal, not the check
    // itself. Re-adding a pre-check there would mean two capture passes per
    // send and two places to keep in step.
    const route = readFileSync(join(SRC, 'app/api/worktrees/[id]/send/route.ts'), 'utf8');
    expect(route).not.toContain('isPromptWaiting');
  });

  it('names every caller of sendUserMessage, so a new one is a decision', () => {
    expect(importersOf('send-user-message')).toEqual([
      'app/api/worktrees/[id]/send/route.ts',
      'lib/timer-manager.ts',
    ]);
  });

  it('keeps the answer routes off that path entirely', () => {
    for (const route of ['respond', 'special-keys', 'prompt-response']) {
      const source = readFileSync(
        join(SRC, 'app/api/worktrees/[id]', route, 'route.ts'),
        'utf8'
      );
      expect(source).not.toContain('prompt-waiting-guard');
      expect(source).not.toContain('send-user-message');
    }
  });
});
