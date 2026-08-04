/** @vitest-environment node */

/**
 * Issue #1671: a finished Codex turn must be saved even when its final message
 * is short.
 *
 * Codex renders inline (`alternate_on=0`), so every step it prints stays in the
 * pane scrollback forever. Completion detection asked "is Codex still working?"
 * by matching CODEX_THINKING_PATTERN — which lists `Ran` — against a fixed
 * 20-row tail. `• Ran <cmd>` is a *past-tense record*, so a turn that ended
 * within 20 rows of its last command kept that record inside the window and was
 * reported as "still thinking" on every poll tick, forever. Its reply was never
 * written to Message History. A turn whose final message happened to be longer
 * than 20 rows pushed the record out of the window and was saved — so whether a
 * reply survived depended on how long it was.
 *
 * Fixtures are verbatim `tmux capture-pane -p -e -S -10000 -E -` frames from
 * live codex-cli 0.146.0 sessions; only trailing pane padding was trimmed.
 * Nothing here is hand-written:
 *
 * - `turn-running-command.txt` / `turn-complete-short-message.txt` are two
 *   frames of one throwaway session (`codex --sandbox read-only
 *   --ask-for-approval untrusted`) driven through "Run the shell command: sleep
 *   30. Then reply with one short sentence." — captured at 13s (executing) and
 *   after it finished. A throwaway session is required: a live worker session
 *   carries half-typed text in its composer.
 * - `reported-session-tail.txt` is the tail of `mcbd-codex-commandagent-develop`
 *   itself, the pane the Issue was written from.
 *
 * Two facts drive the fix, both measured on those captures:
 *
 * 1. `• Ran` / `• Running` rows persist. The reported pane held 396 `• Ran` and
 *    11 `• Running` rows, every one of them a finished step.
 * 2. The live status row Codex pins above its composer —
 *    `• Working (13s • esc to interrupt) · …` — is repainted in place and erased
 *    when the turn ends. `esc to interrupt` occurred 0 times in that same
 *    11,000-line idle capture.
 *
 * So liveness is read off signal 2 (plus a composer-anchored marker check as a
 * version-agnostic backstop), not off the lingering records.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module boundary mocks, so the real checkForResponse() can be driven end to end
// ---------------------------------------------------------------------------

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const isSessionRunning = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...a),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m }));

/**
 * Stands in for the `session_states` row. Codex keeps real scrollback, so its
 * dedup cursor is `last_captured_line` — a mock that pinned it to one value
 * would make the "saved once" test pass for the wrong reason.
 */
let lastCapturedLine = 0;
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: () => ({ lastCapturedLine, inProgressMessageId: null }),
  updateSessionState: (_db: unknown, _wt: string, _cli: string, lineCount: number) => {
    lastCapturedLine = lineCount;
  },
  getWorktreeById: vi.fn(() => ({ id: 'wt-1', name: 'wt-1' })),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));

import { checkForResponse, extractResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { isCodexTurnActive, stripAnsi } from '@/lib/detection/cli-patterns';
import { detectSessionStatus } from '@/lib/detection/status-detector';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/codex-live-1671/', import.meta.url));

function frame(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}.txt`, 'utf8');
}

/** The tail window completion detection actually looks at (response-checker.ts). */
const CHECK_LINE_COUNT = 20;

function contentLines(raw: string): string[] {
  const lines = stripAnsi(raw).split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  return lines.slice(0, end);
}

function tailWindow(raw: string): string {
  const lines = contentLines(raw);
  return lines.slice(Math.max(0, lines.length - CHECK_LINE_COUNT)).join('\n');
}

const RUNNING = 'turn-running-command';
const COMPLETE = 'turn-complete-short-message';
const REPORTED = 'reported-session-tail';

/**
 * Where the poller had read up to when the turn under test started: the row of
 * the echoed user message in both session fixtures, so extraction covers the
 * assistant's turn and nothing above it.
 */
const CAPTURED_THROUGH_USER_TURN = 28;

beforeEach(() => {
  vi.clearAllMocks();
  stopPolling('wt-1', 'codex'); // reset the per-cycle content dedup cache
  isSessionRunning.mockResolvedValue(true);
  lastCapturedLine = CAPTURED_THROUGH_USER_TURN;
});

// ---------------------------------------------------------------------------
// Premise guards — without these the tests below could pass vacuously
// ---------------------------------------------------------------------------

describe('fixture premises', () => {
  it('the finished turn really does keep "• Ran" inside the 20-row window', () => {
    // This is the whole bug. If Codex ever stops leaving the record in the tail,
    // the regression tests would go green without the fix being needed.
    expect(tailWindow(frame(COMPLETE))).toMatch(/•\s*Ran\b/);
    expect(tailWindow(frame(REPORTED))).toMatch(/•\s*Ran\b/);
  });

  it('the finished turn really does end with a message shorter than the window', () => {
    // "Saved only when the reply is long" is the reported symptom, so the
    // fixture has to be on the short side of that threshold.
    const lines = contentLines(frame(COMPLETE));
    const ranIndex = lines.findIndex(l => /^•\s*Ran\b/.test(l));
    expect(ranIndex).toBeGreaterThanOrEqual(0);
    expect(lines.length - ranIndex).toBeLessThan(CHECK_LINE_COUNT);
    expect(lines.join('\n')).toContain('• The command finished successfully.');
  });

  it('the executing turn really is mid-command, with both markers on screen', () => {
    // Guards the other direction: this frame must contain a "• Ran"-family
    // record AND the live status row, so "still thinking" cannot be an accident
    // of the record simply being absent.
    const window = tailWindow(frame(RUNNING));
    expect(window).toMatch(/•\s*Running sleep 30/);
    expect(window).toMatch(/•\s*Working \(\d+s • esc to interrupt\)/);
  });

  it('the live status row never appears in a finished frame', () => {
    // The premise the fix rests on: "esc to interrupt" is repainted, not logged.
    expect(stripAnsi(frame(COMPLETE))).not.toContain('esc to interrupt');
    expect(stripAnsi(frame(REPORTED))).not.toContain('esc to interrupt');
  });
});

// ---------------------------------------------------------------------------
// The liveness predicate
// ---------------------------------------------------------------------------

describe('isCodexTurnActive', () => {
  it('reports a finished turn as inactive despite the lingering "• Ran" record', () => {
    expect(isCodexTurnActive(contentLines(frame(COMPLETE)), CHECK_LINE_COUNT)).toBe(false);
    expect(isCodexTurnActive(contentLines(frame(REPORTED)), CHECK_LINE_COUNT)).toBe(false);
  });

  it('reports a turn executing a command as active', () => {
    // Acceptance criterion: dropping "Ran" as a liveness signal must not make an
    // in-flight turn look finished.
    expect(isCodexTurnActive(contentLines(frame(RUNNING)), CHECK_LINE_COUNT)).toBe(true);
  });

  it('still reports "• Running" above the composer as active without the live row', () => {
    // Backstop for a Codex build whose status row drops the "esc to interrupt"
    // wording: derived from the real executing frame by deleting that one row,
    // which leaves "• Running sleep 30" as the only activity signal.
    const lines = contentLines(frame(RUNNING)).filter(l => !/esc to interrupt/.test(l));
    expect(lines.join('\n')).not.toContain('esc to interrupt');
    expect(lines.join('\n')).toMatch(/•\s*Running sleep 30/);

    expect(isCodexTurnActive(lines, CHECK_LINE_COUNT)).toBe(true);
  });

  it('still reports an unknown live status row as active', () => {
    // The other half of the pair: a Codex build that renames the status row to a
    // word CODEX_THINKING_PATTERN has never heard of. Derived from the real
    // executing frame by renaming "• Working" and dropping the "• Running"
    // record, so "esc to interrupt" is the only signal left. Without it this
    // frame would read as finished and a half-written reply would be saved.
    const lines = contentLines(frame(RUNNING))
      .filter(l => !/^•\s*Running\b/.test(l))
      .map(l => l.replace(/•\s*Working /, '• Generating '));
    expect(lines.join('\n')).not.toMatch(/•\s*(Running|Working|Ran)\b/);
    expect(lines.join('\n')).toContain('esc to interrupt');

    expect(isCodexTurnActive(lines, CHECK_LINE_COUNT)).toBe(true);
  });

  it('falls back to the whole tail window when no composer is on screen', () => {
    // A frame mid-redraw or behind an overlay is not a normal Codex layout, so
    // the predicate must keep erring towards "still active" there. Both the
    // composer and the live row are removed, leaving the wide-window
    // CODEX_THINKING_PATTERN fallback as the only thing that can answer.
    const lines = contentLines(frame(RUNNING))
      .filter(l => !/^›/.test(l) && !/esc to interrupt/.test(l));
    expect(lines.join('\n')).not.toContain('esc to interrupt');

    expect(isCodexTurnActive(lines, CHECK_LINE_COUNT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Completion detection and the save path
// ---------------------------------------------------------------------------

describe('completion detection', () => {
  it('reports the finished short-message turn as complete', () => {
    expect(extractResponse(frame(COMPLETE), CAPTURED_THROUGH_USER_TURN, 'codex')?.isComplete).toBe(true);
  });

  it('reports the reported production pane as complete', () => {
    // The exact frame the Issue was filed from: idle since 10:44, never saved.
    expect(extractResponse(frame(REPORTED), CAPTURED_THROUGH_USER_TURN, 'codex')?.isComplete).toBe(true);
  });

  it('does not report the executing turn as complete', () => {
    expect(extractResponse(frame(RUNNING), CAPTURED_THROUGH_USER_TURN, 'codex')?.isComplete).toBe(false);
  });
});

describe('checkForResponse', () => {
  function savedAssistantContents(): string[] {
    return createMessage.mock.calls
      .filter(([, m]) => m.role === 'assistant')
      .map(([, m]) => String(m.content));
  }

  it('saves the reply of a turn that ended with a short final message', async () => {
    captureSessionOutput.mockResolvedValue(frame(COMPLETE));

    const saved = await checkForResponse('wt-1', 'codex');

    expect(saved).toBe(true);
    expect(savedAssistantContents().join('\n')).toContain('The command finished successfully.');
  });

  it('saves nothing while the turn is still executing a command', async () => {
    captureSessionOutput.mockResolvedValue(frame(RUNNING));

    expect(await checkForResponse('wt-1', 'codex')).toBe(false);
    expect(savedAssistantContents()).toHaveLength(0);
  });

  it('does not re-save the same reply on later poll ticks', async () => {
    // The pane is frozen once the turn ends, and the poller keeps ticking every
    // 2s. Completing the turn must not turn into one message per tick.
    captureSessionOutput.mockResolvedValue(frame(COMPLETE));

    expect(await checkForResponse('wt-1', 'codex')).toBe(true);
    expect(await checkForResponse('wt-1', 'codex')).toBe(false);
    expect(await checkForResponse('wt-1', 'codex')).toBe(false);

    expect(savedAssistantContents()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The paired path: CODEX_THINKING_PATTERN also feeds status detection
// ---------------------------------------------------------------------------

describe('status detection is unchanged', () => {
  it('keeps reporting the executing turn as running', () => {
    expect(detectSessionStatus(frame(RUNNING), 'codex').status).toBe('running');
  });

  it('keeps reporting finished turns as ready', () => {
    // These already read "ready" before the fix — the sidebar showed the session
    // idle while the poller insisted it was thinking. The two now agree.
    expect(detectSessionStatus(frame(COMPLETE), 'codex').status).toBe('ready');
    expect(detectSessionStatus(frame(REPORTED), 'codex').status).toBe('ready');
  });
});
