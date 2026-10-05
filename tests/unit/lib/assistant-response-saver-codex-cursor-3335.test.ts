/**
 * Issue #3335 — on codex 0.160.0 the pre-send flush must not save the rows at
 * and below the composer (path B).
 *
 * codex 0.160.0 draws in the alternate screen: the capture is 1000 rows whatever
 * the transcript holds, the composer is pinned to row 996, and below it are only
 * the status bar (998) and `? for shortcuts` (999). The cursor the flush keeps
 * is a row count of that pane, so it settles at 999 or 1000 after the first
 * read and never moves again. Its writers:
 *
 *  - the flush itself, on the startup screen (`countCapturedLines`: 1000, or
 *    999 when `? for shortcuts` is not drawn — a message typed into the composer);
 *  - the poller, at the composer row (996);
 *  - `advanceCapturedLineForTranscriptTurn`, after codex's own transcript wrote
 *    the turn (`hooks/sources/codex/history.ts`), with the same row count.
 *
 * Decided here (option (a) of the Issue): the screen read does not take the
 * reply from such a pane. codex's reply reaches History from its transcript.
 * What the flush must not do is save what lies past a cursor parked in the
 * chrome — before this Issue, a cursor of 999 saved `? for shortcuts` and 997
 * or 998 saved the status bar as the agent's reply.
 *
 * Driven through the real function against an in-memory database, on captures
 * of the real tool (`tests/fixtures/startup-screen-3293/README.md`).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, getMessages, getSessionState, updateSessionState } from '@/lib/db';
import { stripAnsi } from '@/lib/detection/cli-patterns';

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  isSessionRunning: vi.fn(),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { savePendingAssistantResponse } from '@/lib/assistant-response-saver';
import { buildCodexLongReplyPane } from '../../fixtures/startup-screen-3293/codex-0.160.0-long-reply-pane';

const mockCaptureSessionOutput = vi.mocked(captureSessionOutput);

const FIXTURES = join(process.cwd(), 'tests/fixtures');
const read = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf8');

const CODEX_BOOT_TYPED = read('startup-screen-3293/codex-0.160.0-boot-typed.txt');
const CODEX_TURN_INTERRUPTED = read('startup-screen-3293/codex-0.160.0-first-turn-interrupted.txt');
const CODEX_TURN_REPLY = read('startup-screen-3293/codex-0.160.0-first-turn-reply.txt');
const CODEX_OVERFLOW = read('startup-screen-3293/codex-0.160.0-overflow-interrupted.txt');
const CODEX_LONG_REPLY = buildCodexLongReplyPane();
const CODEX_0155_TURN = read('codex-idle-composer-0155/idle-after-turn.txt');

const WORKTREE = 'test-worktree';

/** Row index of the first row whose stripped text starts with `prefix`. */
function rowOf(capture: string, prefix: string): number {
  const index = capture.split('\n').findIndex(row => stripAnsi(row).startsWith(prefix));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe('[#3335] savePendingAssistantResponse: a codex cursor parked at or below the composer', () => {
  let db: Database.Database;

  const flush = (capture: string) => {
    mockCaptureSessionOutput.mockResolvedValue(capture);
    return savePendingAssistantResponse(db, WORKTREE, 'codex', new Date());
  };
  const assistantRows = (): string[] =>
    getMessages(db, WORKTREE)
      .filter(message => message.role === 'assistant')
      .map(message => stripAnsi(message.content));
  const cursor = (): number | undefined => getSessionState(db, WORKTREE, 'codex')?.lastCapturedLine;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    upsertWorktree(db, {
      id: WORKTREE,
      name: 'Test Worktree',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  it('the fixture premise: the composer is on row 996 and only chrome is below it', () => {
    for (const capture of [CODEX_TURN_REPLY, CODEX_TURN_INTERRUPTED, CODEX_OVERFLOW]) {
      const rows = capture.split('\n').map(stripAnsi);
      expect(rowOf(capture, '› Ask Codex to do anything')).toBe(996);
      expect(rows[999].trim()).toMatch(/^\? for shortcuts/);
    }
    // The flush's cursor after the startup screen with a message typed: no
    // `? for shortcuts` row, so the count is 999, one row short of the frames above.
    const typed = CODEX_BOOT_TYPED.split('\n');
    expect(typed.length - 1).toBe(1000);
    expect(typed[999].trim()).toBe('');
  });

  it.each([
    ['the first reply', CODEX_TURN_REPLY],
    ['an interrupted turn', CODEX_TURN_INTERRUPTED],
    ['an overflowed transcript', CODEX_OVERFLOW],
    ['a reply longer than the pane', CODEX_LONG_REPLY],
  ])('codex 0.160.0, %s: no row is saved from a cursor on rows 996-1000', async (_name, capture) => {
    for (const parked of [996, 997, 998, 999, 1000]) {
      updateSessionState(db, WORKTREE, 'codex', parked);

      expect(await flush(capture)).toBeNull();
    }

    expect(assistantRows()).toEqual([]);
  });

  it('codex 0.160.0: startup screen with a message typed, then the first reply — no row', async () => {
    // The sequence that saved `? for shortcuts` as the reply before this Issue.
    expect(await flush(CODEX_BOOT_TYPED)).toBeNull();
    expect(cursor()).toBe(999);

    expect(await flush(CODEX_TURN_REPLY)).toBeNull();

    expect(assistantRows()).toEqual([]);
    expect(cursor()).toBe(1000);
  });

  it('the cursor still moves to the row count, as the empty-after-clean branch did', async () => {
    updateSessionState(db, WORKTREE, 'codex', 997);

    await flush(CODEX_TURN_REPLY);

    expect(cursor()).toBe(1000);
  });

  describe('陰性対照: a cursor above the composer reads as it did', () => {
    it('codex 0.160.0: from the row under the echo, the reply is saved', async () => {
      updateSessionState(db, WORKTREE, 'codex', rowOf(CODEX_TURN_REPLY, '› Reply with exactly') + 1);

      const saved = await flush(CODEX_TURN_REPLY);

      expect(stripAnsi(saved?.content ?? '')).toContain('UAT-OK-CODEX');
      expect(stripAnsi(saved?.content ?? '')).not.toContain('? for shortcuts');
    });

    it('codex 0.160.0, measured: an overflowed transcript from cursor 990 keeps its last rows', async () => {
      updateSessionState(db, WORKTREE, 'codex', 990);

      const saved = await flush(CODEX_OVERFLOW);

      expect(stripAnsi(saved?.content ?? '')).toContain('probe body line 1100 of 1100');
    });

    it('codex 0.155.1 (inline layout): the reply under the first echo is saved', async () => {
      updateSessionState(db, WORKTREE, 'codex', rowOf(CODEX_0155_TURN, '› a') + 1);

      const saved = await flush(CODEX_0155_TURN);

      expect(stripAnsi(saved?.content ?? '')).toContain('How can I help?');
    });

    it('codex 0.155.1 (inline layout): from the composer row down, nothing is a reply', async () => {
      updateSessionState(db, WORKTREE, 'codex', rowOf(CODEX_0155_TURN, '› Ask Codex to do anything'));

      expect(await flush(CODEX_0155_TURN)).toBeNull();
      expect(assistantRows()).toEqual([]);
    });
  });
});
