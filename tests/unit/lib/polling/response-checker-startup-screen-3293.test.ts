/**
 * Issue #3293 — the response poller must not save codex's or vibe-local's
 * startup screen as the agent's first reply (path A).
 *
 * ## What was measured
 *
 * Both startup screens are complete, idle frames: the input box is drawn and
 * nothing is working, so the completion rule (`hasPrompt && !isThinking`)
 * accepts them, and extraction starts at `lastCapturedLine`, which is 0 for a
 * new session. The "reply" was the banner — on codex 0.160.0 twenty rows, the
 * block-art logo included:
 *
 * ```text
 * >_ OpenAI Codex (v0.160.0)
 *    /private/tmp/…/scratchpad/repo
 * A long time ago, in a directory not so far away…
 * ```
 *
 * It needed nothing but a poll on that screen. In the Epic #3207 UAT that was
 * the tick after the folder-trust dialog had been answered with `respond`.
 *
 * ## What is pinned
 *
 *  1. the startup screen yields NO response — and still moves the cursor to
 *     where the banner save used to leave it, because these two tools read
 *     their next reply from the cursor (a cursor left at 0 would put the banner
 *     back, glued to the first reply);
 *  2. once a message has been echoed the reading is the one it was (陰性対照);
 *  3. a clipped capture is not asked (#1670): the echo of a turn longer than the
 *     window has scrolled out of it.
 *
 * The frames are captures of the real tools — codex-cli 0.160.0 and vibe-local
 * 1.3.3, 200x1000 — see `tests/fixtures/startup-screen-3293/README.md`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CACHE_MAX_CAPTURE_LINES } from '@/lib/tmux/tmux-capture-cache';
import { stripAnsi } from '@/lib/detection/cli-patterns';

// ---------------------------------------------------------------------------
// Module boundary mocks (the set the #2400 suite cuts)
// ---------------------------------------------------------------------------

const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const isSessionRunning = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...a),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m }));
const getSessionState = vi.fn();
const updateSessionState = vi.fn();
const getWorktreeById = vi.fn(() => ({ id: 'wt-1', name: 'wt-1' }));
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: (...a: unknown[]) => getSessionState(...a),
  updateSessionState: (...a: unknown[]) => updateSessionState(...a),
  getWorktreeById: (...a: unknown[]) => getWorktreeById(...(a as [])),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

const notifyPushSubscribers = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({
  notifyPushSubscribers: (...a: unknown[]) => notifyPushSubscribers(...a),
}));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));

import { checkForResponse, extractResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

const FIXTURES = join(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8');

const CODEX_BOOT = read('startup-screen-3293/codex-0.160.0-boot-idle.txt');
const CODEX_BOOT_TYPED = read('startup-screen-3293/codex-0.160.0-boot-typed.txt');
const CODEX_TRUST_DIALOG = read('startup-screen-3293/codex-0.160.0-dialog-trust.txt');
const CODEX_TURN_INTERRUPTED = read('startup-screen-3293/codex-0.160.0-first-turn-interrupted.txt');
const CODEX_TURN_REPLY = read('startup-screen-3293/codex-0.160.0-first-turn-reply.txt');
const CODEX_0153_BOOT = read('codex-live-2310/idle-composer.txt');
const CODEX_0153_SATURATED_TAIL = read('codex-live-2310/saturated-idle-tail.txt').split('\n');
const CODEX_0155_TURN = read('codex-idle-composer-0155/idle-after-turn.txt');
const VIBE_BOOT = read('startup-screen-3293/vibe-local-1.3.3-boot-idle.txt');
const VIBE_TURN_DONE = read('startup-screen-3293/vibe-local-1.3.3-first-turn-done.txt');

/** Row index of the first row whose stripped text starts with `prefix`. */
function rowOf(capture: string, prefix: string): number {
  const index = capture.split('\n').findIndex(row => stripAnsi(row).startsWith(prefix));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function savedAssistantContents(): string[] {
  return createMessage.mock.calls
    .filter(([, m]) => m.role === 'assistant')
    .map(([, m]) => stripAnsi(String(m.content)));
}

/** A session_states row that the tick reads and writes, as the real one would. */
function wireLiveSessionState(initial: number): { cursor: () => number } {
  let lastCapturedLine = initial;
  getSessionState.mockImplementation(() => ({ lastCapturedLine, inProgressMessageId: null }));
  updateSessionState.mockImplementation((...args: unknown[]) => {
    lastCapturedLine = args[3] as number;
  });
  return { cursor: () => lastCapturedLine };
}

beforeEach(() => {
  vi.clearAllMocks();
  stopPolling('wt-1', 'codex');
  stopPolling('wt-1', 'vibe-local');
  isSessionRunning.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// extractResponse
// ---------------------------------------------------------------------------

describe('[#3293] extractResponse: a startup screen is not a reply', () => {
  it('codex 0.160.0: nothing is extracted, and the cursor stops at the composer', () => {
    const result = extractResponse(CODEX_BOOT, 0, 'codex');

    expect(result?.response).toBe('');
    // Complete, not incomplete: an empty complete result is what moves the
    // cursor (`checkForResponse` writes `lineCount` and saves nothing).
    expect(result?.isComplete).toBe(true);
    expect(result?.lineCount).toBe(rowOf(CODEX_BOOT, '› Ask Codex to do anything'));
  });

  it('codex 0.160.0: a message typed into the composer and not sent changes nothing', () => {
    const result = extractResponse(CODEX_BOOT_TYPED, 0, 'codex');

    expect(result?.response).toBe('');
    expect(result?.isComplete).toBe(true);
  });

  it('codex 0.160.0: the frame the folder-trust dialog leaves behind is the startup screen', () => {
    // The UAT's trigger. The dialog itself is a prompt (asserted below); what
    // follows the answer is this frame, read here with the cursor the stored
    // prompt row leaves (the dialog's own row count).
    const dialogRows = extractResponse(CODEX_TRUST_DIALOG, 0, 'codex')!.lineCount;
    const result = extractResponse(CODEX_BOOT, dialogRows, 'codex');

    expect(dialogRows).toBeGreaterThan(0);
    expect(result?.response).toBe('');
    expect(result?.isComplete).toBe(true);
  });

  it('codex 0.153 (inline layout): the two notices under the banner box are not a reply', () => {
    const result = extractResponse(CODEX_0153_BOOT, 0, 'codex');

    expect(result?.response).toBe('');
    expect(result?.isComplete).toBe(true);
    expect(result?.lineCount).toBe(rowOf(CODEX_0153_BOOT, '› Ask Codex to do anything'));
  });

  it('vibe-local 1.3.3: nothing is extracted, and the cursor stops at the end of the pane', () => {
    const result = extractResponse(VIBE_BOOT, 0, 'vibe-local');

    expect(result?.response).toBe('');
    expect(result?.isComplete).toBe(true);
    expect(result?.lineCount).toBe(rowOf(VIBE_BOOT, ' ESC: stop') + 1);
  });
});

describe('[#3293] extractResponse: with an echo on the pane the reading is unchanged (陰性対照)', () => {
  it('codex 0.160.0: the rows under the echo are the reply', () => {
    const afterEcho = rowOf(CODEX_TURN_REPLY, '› Reply with exactly this text') + 1;
    const result = extractResponse(CODEX_TURN_REPLY, afterEcho, 'codex');

    expect(result?.isComplete).toBe(true);
    expect(stripAnsi(result!.response)).toContain('UAT-OK-CODEX');
  });

  it('codex 0.160.0: an interrupted turn is still read', () => {
    const afterEcho = rowOf(CODEX_TURN_INTERRUPTED, '› Say hello') + 1;
    const result = extractResponse(CODEX_TURN_INTERRUPTED, afterEcho, 'codex');

    expect(result?.isComplete).toBe(true);
    expect(stripAnsi(result!.response)).toContain('Conversation interrupted');
  });

  it('codex 0.155.1 (inline layout): the reply under the first echo is read', () => {
    const afterEcho = rowOf(CODEX_0155_TURN, '› a') + 1;
    const result = extractResponse(CODEX_0155_TURN, afterEcho, 'codex');

    expect(result?.isComplete).toBe(true);
    expect(stripAnsi(result!.response)).toContain('How can I help?');
  });

  it('vibe-local 1.3.3: the reply is read from the cursor the startup screen left', () => {
    const cursor = extractResponse(VIBE_BOOT, 0, 'vibe-local')!.lineCount;
    const result = extractResponse(VIBE_TURN_DONE, cursor, 'vibe-local');

    expect(result?.isComplete).toBe(true);
    expect(stripAnsi(result!.response)).toContain('assistant: OK-3293');
    expect(stripAnsi(result!.response)).not.toContain('Ollama: http://localhost:11434');
  });

  it('codex 0.160.0: the folder-trust dialog is a prompt, not a reply and not a startup screen', () => {
    const result = extractResponse(CODEX_TRUST_DIALOG, 0, 'codex');

    expect(result?.promptDetection?.isPrompt).toBe(true);
    expect(stripAnsi(result!.response)).toContain('Trust this folder?');
  });
});

describe('[#3293] extractResponse: a clipped capture is not asked (#1670)', () => {
  // The reply and the chrome of a real saturated codex pane, WITHOUT the echo
  // above them: the window of a turn longer than the capture window.
  const echoRow = CODEX_0153_SATURATED_TAIL.findIndex(row => stripAnsi(row).startsWith('› Reply with exactly'));
  const replyAndChrome = CODEX_0153_SATURATED_TAIL.slice(echoRow + 1);
  const filler = (n: number): string[] => Array.from({ length: n }, (_, i) => `transcript row ${i + 1}`);
  const pane = (windowLines: number): string =>
    [...filler(windowLines - replyAndChrome.length), ...replyAndChrome].join('\n');

  it('the fixture premise: composer on the pane, no echo above it', () => {
    const rows = pane(300).split('\n').map(stripAnsi);
    expect(echoRow).toBeGreaterThanOrEqual(0);
    expect(rows.some(row => row.startsWith('› Ask Codex to do anything'))).toBe(true);
    expect(rows.filter(row => /^›\s+\S/.test(row))).toHaveLength(1);
  });

  it('a saturated window with no echo in it still yields the reply', () => {
    const result = extractResponse(pane(CACHE_MAX_CAPTURE_LINES), CACHE_MAX_CAPTURE_LINES - 1, 'codex');

    expect(result?.captureWindowSaturated).toBe(true);
    expect(stripAnsi(result!.response)).toContain('A worktree is a working directory for a Git repository.');
  });

  it('対照: the same rows in a window that is not clipped read as "no turn yet"', () => {
    // What the guard decides. Not a frame a real pane produces — below the
    // window every echo since the session started is still in the capture.
    const result = extractResponse(pane(300), 0, 'codex');

    expect(result?.captureWindowSaturated).toBe(false);
    expect(result?.response).toBe('');
  });
});

// ---------------------------------------------------------------------------
// checkForResponse
// ---------------------------------------------------------------------------

describe('[#3293] checkForResponse: no row is written for a startup screen', () => {
  it.each([
    ['codex', 'codex 0.160.0', CODEX_BOOT, rowOf(CODEX_BOOT, '› Ask Codex to do anything')],
    ['codex', 'codex 0.153', CODEX_0153_BOOT, rowOf(CODEX_0153_BOOT, '› Ask Codex to do anything')],
    ['vibe-local', 'vibe-local 1.3.3', VIBE_BOOT, rowOf(VIBE_BOOT, ' ESC: stop') + 1],
  ] as const)('%s (%s): nothing saved, no completion push, cursor moved', async (cliToolId, _name, capture, cursorAfter) => {
    const state = wireLiveSessionState(0);
    captureSessionOutput.mockResolvedValue(capture);

    expect(await checkForResponse('wt-1', cliToolId)).toBe(false);

    expect(createMessage).not.toHaveBeenCalled();
    expect(notifyPushSubscribers).not.toHaveBeenCalled();
    expect(state.cursor()).toBe(cursorAfter);
  });

  it('the same screen on the following ticks is still not saved', async () => {
    wireLiveSessionState(0);
    captureSessionOutput.mockResolvedValue(VIBE_BOOT);

    for (let tick = 0; tick < 3; tick++) {
      expect(await checkForResponse('wt-1', 'vibe-local')).toBe(false);
    }

    expect(createMessage).not.toHaveBeenCalled();
  });

  it('says so once, when the cursor moves — not on every tick of an idle pane', async () => {
    wireLiveSessionState(0);
    captureSessionOutput.mockResolvedValue(VIBE_BOOT);

    for (let tick = 0; tick < 3; tick++) await checkForResponse('wt-1', 'vibe-local');

    const suppressed = mockLogger.info.mock.calls.filter(([message]) =>
      String(message).includes('startup screen')
    );
    expect(suppressed).toHaveLength(1);
  });

  it('vibe-local: startup screen, then the first turn — History gets the reply and only the reply', async () => {
    wireLiveSessionState(0);

    captureSessionOutput.mockResolvedValue(VIBE_BOOT);
    expect(await checkForResponse('wt-1', 'vibe-local')).toBe(false);

    captureSessionOutput.mockResolvedValue(VIBE_TURN_DONE);
    expect(await checkForResponse('wt-1', 'vibe-local')).toBe(true);

    const saved = savedAssistantContents();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain('assistant: OK-3293');
    expect(saved[0]).not.toContain('Ollama: http://localhost:11434');
    expect(saved[0]).not.toContain('O F F L I N E');
  });

  it('codex 0.160.0: startup screen, then the first turn — the banner never reaches History', async () => {
    wireLiveSessionState(0);

    captureSessionOutput.mockResolvedValue(CODEX_BOOT);
    await checkForResponse('wt-1', 'codex');
    captureSessionOutput.mockResolvedValue(CODEX_TURN_REPLY);
    await checkForResponse('wt-1', 'codex');

    for (const saved of savedAssistantContents()) {
      expect(saved).not.toContain('OpenAI Codex');
      expect(saved).not.toContain('What are we cooking up?');
    }
  });

  it('codex 0.155.1: a finished turn is saved as before (陰性対照)', async () => {
    wireLiveSessionState(rowOf(CODEX_0155_TURN, '› a') + 1);
    captureSessionOutput.mockResolvedValue(CODEX_0155_TURN);

    expect(await checkForResponse('wt-1', 'codex')).toBe(true);

    expect(savedAssistantContents().join('\n')).toContain('How can I help?');
  });
});
