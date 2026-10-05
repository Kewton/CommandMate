/**
 * Issue #3293 — the pre-send flush must not save codex's or vibe-local's
 * startup screen as a pending reply (path B).
 *
 * `savePendingAssistantResponse` saves everything past `lastCapturedLine`. On
 * the first send of a session that cursor is 0, so "everything" was the whole
 * startup screen, and the cleaner only drops the input box and the rows its
 * skip patterns name. Measured in the Epic #3207 UAT (vibe-local):
 *
 * ```text
 * [cli-tools/vibe-local] started-vibe-local-session:sessionname
 * [assistant-response-saver] response:saved {"fromLine":0,"toLine":1001}
 * ```
 *
 * Driven through the real function against an in-memory database, on captures
 * of the real tools (`tests/fixtures/startup-screen-3293/README.md`): what is
 * asserted is the `chat_messages` row and the cursor, not a helper's verdict.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, getMessages, getSessionState, updateSessionState } from '@/lib/db';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { CACHE_MAX_CAPTURE_LINES } from '@/lib/tmux/tmux-capture-cache';

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  isSessionRunning: vi.fn(),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { broadcastMessage } from '@/lib/ws-server';
import { savePendingAssistantResponse } from '@/lib/assistant-response-saver';
import { cleanScrollbackResponse } from '@/lib/response-cleaner';

const mockCaptureSessionOutput = vi.mocked(captureSessionOutput);

const FIXTURES = join(process.cwd(), 'tests/fixtures');
const read = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf8');

const CODEX_BOOT = read('startup-screen-3293/codex-0.160.0-boot-idle.txt');
const CODEX_BOOT_TYPED = read('startup-screen-3293/codex-0.160.0-boot-typed.txt');
const CODEX_TURN_REPLY = read('startup-screen-3293/codex-0.160.0-first-turn-reply.txt');
const CODEX_0153_BOOT = read('codex-live-2310/idle-composer.txt');
const CODEX_0153_SATURATED_TAIL = read('codex-live-2310/saturated-idle-tail.txt').split('\n');
const CODEX_0155_TURN = read('codex-idle-composer-0155/idle-after-turn.txt');
const VIBE_BOOT = read('startup-screen-3293/vibe-local-1.3.3-boot-idle.txt');
const VIBE_TURN_DONE = read('startup-screen-3293/vibe-local-1.3.3-first-turn-done.txt');

const WORKTREE = 'test-worktree';

/** Rows of a capture with the padding tmux adds below the content removed. */
function contentRows(capture: string): number {
  const rows = capture.split('\n');
  let length = rows.length;
  while (length > 0 && rows[length - 1].trim() === '') length--;
  return length;
}

describe('[#3293] savePendingAssistantResponse and the startup screen', () => {
  let db: Database.Database;

  const flush = (cliToolId: CLIToolType, capture: string) => {
    mockCaptureSessionOutput.mockResolvedValue(capture);
    return savePendingAssistantResponse(db, WORKTREE, cliToolId, new Date());
  };
  const assistantRows = (): string[] =>
    getMessages(db, WORKTREE)
      .filter(message => message.role === 'assistant')
      .map(message => message.content);
  const cursor = (cliToolId: CLIToolType): number | undefined =>
    getSessionState(db, WORKTREE, cliToolId)?.lastCapturedLine;

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

  describe('the first flush of a session writes no row', () => {
    it.each([
      ['codex', 'codex 0.160.0', CODEX_BOOT],
      ['codex', 'codex 0.160.0, a message typed and not sent', CODEX_BOOT_TYPED],
      ['codex', 'codex 0.153 (inline layout)', CODEX_0153_BOOT],
      ['vibe-local', 'vibe-local 1.3.3', VIBE_BOOT],
    ] as const)('%s (%s)', async (cliToolId, _name, capture) => {
      expect(await flush(cliToolId, capture)).toBeNull();

      expect(assistantRows()).toEqual([]);
      expect(broadcastMessage).not.toHaveBeenCalled();
      // The screen has been read: the cursor is where the banner save used to
      // leave it, so the first reply is read from the same row as before.
      expect(cursor(cliToolId)).toBe(contentRows(capture));
    });

    it('also after a session restart, when the cursor is reset to 0', async () => {
      // `detectBufferReset`: a cursor far past a pane that is small again.
      const restarted = CODEX_0153_BOOT;
      updateSessionState(db, WORKTREE, 'codex', 500);
      expect(contentRows(restarted)).toBeLessThan(50);

      expect(await flush('codex', restarted)).toBeNull();
      expect(assistantRows()).toEqual([]);
    });
  });

  describe('an ordinary reply is saved as before (陰性対照)', () => {
    it('vibe-local: startup screen, then the first turn — one row, the reply', async () => {
      await flush('vibe-local', VIBE_BOOT);
      const saved = await flush('vibe-local', VIBE_TURN_DONE);

      expect(saved).not.toBeNull();
      expect(assistantRows()).toHaveLength(1);
      expect(assistantRows()[0]).toContain('assistant: OK-3293');
      expect(assistantRows()[0]).not.toContain('Ollama: http://localhost:11434');
      expect(cursor('vibe-local')).toBe(contentRows(VIBE_TURN_DONE));
    });

    it('codex 0.155.1: the rows past the cursor are saved', async () => {
      const afterFirstEcho = CODEX_0155_TURN.split('\n').findIndex(row => stripAnsi(row) === '› a') + 1;
      updateSessionState(db, WORKTREE, 'codex', afterFirstEcho);

      const saved = await flush('codex', CODEX_0155_TURN);

      expect(saved?.content).toContain('How can I help?');
      expect(saved?.content).not.toContain('Ask Codex to do anything');
    });

    it('codex 0.160.0: a pane with an echoed message is not a startup screen', async () => {
      const saved = await flush('codex', CODEX_TURN_REPLY);

      expect(saved?.content).toContain('UAT-OK-CODEX');
    });
  });

  describe('a clipped capture is not asked (#1670)', () => {
    // The reply and the chrome of a real saturated codex pane, without the echo
    // above them: the window of a turn longer than the capture window.
    const echoRow = CODEX_0153_SATURATED_TAIL.findIndex(row => stripAnsi(row).startsWith('› Reply with exactly'));
    const replyAndChrome = CODEX_0153_SATURATED_TAIL.slice(echoRow + 1);
    const pane = (windowLines: number): string =>
      [
        ...Array.from({ length: windowLines - replyAndChrome.length }, (_, i) => `transcript row ${i + 1}`),
        ...replyAndChrome,
      ].join('\n');

    it('a saturated window with no echo in it still saves the reply', async () => {
      const saved = await flush('codex', pane(CACHE_MAX_CAPTURE_LINES));

      expect(saved?.content).toContain('A worktree is a working directory for a Git repository.');
    });

    it('対照: the same rows in a window that is not clipped read as "no turn yet"', async () => {
      expect(echoRow).toBeGreaterThanOrEqual(0);
      expect(await flush('codex', pane(300))).toBeNull();
    });
  });
});

describe('[#3293] cleanScrollbackResponse is asked about the pane, not about the rows past the cursor', () => {
  const paneLines = VIBE_TURN_DONE.split('\n');
  const replyRow = paneLines.findIndex(row => stripAnsi(row).startsWith('assistant: '));

  it('rows past the cursor with no echo among them are still a reply', () => {
    // The ordinary case, and why the pending rows cannot answer the question
    // themselves: the echo of the turn they belong to sits above the cursor.
    const pending = paneLines.slice(replyRow).join('\n');
    expect(pending).not.toMatch(/ctx:\d+%\s*❯\s*\S/);

    expect(cleanScrollbackResponse(pending, 'vibe-local', paneLines)).toContain('assistant: OK-3293');
  });

  it('対照: without the pane the cleaner cannot tell, and the banner rows stay', () => {
    // The unfixed reading, kept reachable on purpose — a caller that has only a
    // slice must not have it emptied because the slice holds no echo.
    expect(cleanScrollbackResponse(CODEX_BOOT, 'codex')).toContain('OpenAI Codex (v0.160.0)');
    expect(cleanScrollbackResponse(VIBE_BOOT, 'vibe-local')).toContain('Ollama: http://localhost:11434');
  });

  it('with the pane, both startup screens clean away', () => {
    expect(cleanScrollbackResponse(CODEX_BOOT, 'codex', CODEX_BOOT.split('\n'))).toBe('');
    expect(cleanScrollbackResponse(VIBE_BOOT, 'vibe-local', VIBE_BOOT.split('\n'))).toBe('');
  });
});
