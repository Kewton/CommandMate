/**
 * Issue #2464: a long body sent to Claude Code arrived as its last few bytes.
 *
 * Measured on claude 2.1.268 through the production send path: a 1 KB brief
 * arrived as its final 2 bytes, a 4 KB one as its final 8, a 12 KB one (in one
 * run) as its final 24 — each time `sendMessageWithSubmitVerification` resolved
 * and `commandmate send` printed `Message sent.`. tmux delivered every byte; the
 * TUI kept only the last pty read of the unbracketed stream
 * (`docs/design/2464-long-body-repro-matrix.md`).
 *
 * What is pinned here:
 *   - a body longer than one keystroke read goes in as ONE bracketed paste
 *     (`load-buffer` on stdin + `paste-buffer -p -r -d`), never `send-keys`;
 *   - Enter is not pressed while the composer shows a placeholder counting
 *     fewer lines than the body (paste中のplaceholderでEnterを打たない);
 *   - a composer holding anything but the whole body THROWS before Enter —
 *     which is what makes the send route answer 500 and `commandmate send`
 *     exit non-zero instead of printing `Message sent.`
 *     (到達不足でexit 0を返さない);
 *   - the verify window starts at the last drawn row, so codex, Command Code
 *     and agy — which draw from the top of a 1000-row pane — are read at all.
 *
 * The composer frames are live captures at the production 200x1000 geometry
 * (`tests/fixtures/long-body-2464/README.md`), trailing blank rows included:
 * those rows are the reason the old window never saw a composer on three of the
 * four tools.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
  clearInputLine: vi.fn().mockResolvedValue(undefined),
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
  exactTarget: (name: string) => `=${name}:`,
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

// `load-buffer` / `paste-buffer` go through execFile directly; the stub records
// each argv and what was written to its stdin.
vi.mock('child_process', () => ({ execFile: vi.fn() }));

const loggerSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ ...loggerSpies, withContext: () => loggerSpies }),
}));

import { execFile } from 'child_process';
import {
  sendMessageWithSubmitVerification,
  classifySubmit,
  classifyPasteLanded,
  LITERAL_SEND_MAX_BYTES,
} from '@/lib/cli-tools/submit-verified-sender';
import { sendKeys, sendSpecialKeys, capturePane, clearComposerLine, clearInputLine } from '@/lib/tmux/tmux';
import type { CLIToolType } from '@/lib/cli-tools/types';

const SESSION = 'mcbd-claude-long-body';
const FIXTURES = path.resolve(__dirname, '../../fixtures/long-body-2464');

const frame = (name: string): string => readFileSync(path.join(FIXTURES, `${name}.capture`), 'utf8');
const body = (name: string): string => readFileSync(path.join(FIXTURES, `${name}.body`), 'utf8');

/** 60 lines / 12,288 bytes — the size of brief #2464 was reported on. */
const BRIEF_60 = body('P12knl');
/** 30 lines / 4,096 bytes. */
const BRIEF_30 = body('P4knl');
/** One line / 12,288 bytes. */
const BRIEF_FLAT = body('P12kflat');

const CLAUDE_TAIL_ONLY = frame('claude-tail-only-after-send-keys');
const CLAUDE_PASTED_60 = frame('claude-pasted-60-lines');
const CLAUDE_PASTED_30 = frame('claude-pasted-30-lines');
const CLAUDE_PASTED_ONE_LINE = frame('claude-pasted-one-line');
const CLAUDE_IDLE = frame('claude-idle');
const CODEX_PASTED = frame('codex-pasted-content');
const CODEX_IDLE = frame('codex-idle');
const AGY_PASTED_60 = frame('antigravity-pasted-60-lines');
const AGY_PASTED_CHARS = frame('antigravity-pasted-chars');
const AGY_IDLE = frame('antigravity-idle');
const CC_PASTED_60 = frame('command-code-pasted-60L');
const CC_IDLE = frame('command-code-idle');

interface TmuxCall {
  args: string[];
  stdin?: string;
}

let tmuxCalls: TmuxCall[] = [];

/** Every execFile('tmux', …) succeeds unless its subcommand is `failOn`. */
function stubExecFile(failOn?: string): void {
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null) => void
  ) => {
    const call: TmuxCall = { args };
    tmuxCalls.push(call);
    const error = failOn !== undefined && args[0] === failOn ? new Error(`tmux ${failOn} failed`) : null;
    queueMicrotask(() => callback(error));
    return { stdin: { end: (data: string) => { call.stdin = data; } } };
  }) as never);
}

const enterCount = (): number =>
  vi.mocked(sendSpecialKeys).mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'Enter').length;

/**
 * Script the pane. The composer-clear path reads with the legacy numeric
 * signature (`capturePane(name, 200)`), the sender's own reads with
 * `{ startLine }` — so the two are scripted separately: `clearReads` for the
 * former, `beforeEnter` for the latter until the first Enter, `afterEnter` from
 * then on. The last frame of a list repeats.
 */
function scriptPane(options: { clearReads: string[]; beforeEnter: string[]; afterEnter: string }): void {
  let clearIndex = 0;
  let verifyIndex = 0;
  vi.mocked(capturePane).mockImplementation((async (_session: string, arg?: unknown) => {
    if (typeof arg === 'number') {
      return options.clearReads[Math.min(clearIndex++, options.clearReads.length - 1)];
    }
    if (enterCount() > 0) return options.afterEnter;
    return options.beforeEnter[Math.min(verifyIndex++, options.beforeEnter.length - 1)];
  }) as never);
}

const verifyReads = (): number =>
  vi.mocked(capturePane).mock.calls.filter((c) => typeof c[1] !== 'number').length;

async function send(message: string, cliToolId: CLIToolType): Promise<void> {
  const p = sendMessageWithSubmitVerification({ sessionName: SESSION, message, cliToolId });
  // Attach the handler before the timers run so a rejection is never unhandled.
  const settled = p.then(() => undefined, (error: unknown) => { throw error; });
  settled.catch(() => undefined);
  await vi.runAllTimersAsync();
  return settled;
}

describe('submit-verified-sender: long bodies (Issue #2464)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    tmuxCalls = [];
    stubExecFile();
    vi.mocked(sendKeys).mockResolvedValue(undefined);
    vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);
    vi.mocked(clearInputLine).mockResolvedValue(undefined);
    vi.mocked(clearComposerLine).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // What the composer shows after a paste, on real captures
  // -------------------------------------------------------------------------
  describe('classifyPasteLanded() on live captures', () => {
    it.each([
      // The #2464 frame itself: send-keys typed 12,288 bytes; claude kept the last read.
      ['claude', CLAUDE_TAIL_ONLY, BRIEF_60, 'mismatch'],
      ['claude', CLAUDE_PASTED_60, BRIEF_60, 'landed'],
      // `+29 lines` of a 60-line brief: the paste is still coming in.
      ['claude', CLAUDE_PASTED_30, BRIEF_60, 'pasting'],
      ['claude', CLAUDE_PASTED_30, BRIEF_30, 'landed'],
      ['claude', CLAUDE_PASTED_ONE_LINE, BRIEF_FLAT, 'landed'],
      // A dim ghost suggestion is not the body.
      ['claude', CLAUDE_IDLE, BRIEF_60, 'unseen'],
      ['codex', CODEX_PASTED, BRIEF_60, 'landed'],
      // 12,288 characters shown for a 4,096-character body: more than was sent.
      ['codex', CODEX_PASTED, BRIEF_30, 'mismatch'],
      ['codex', CODEX_IDLE, BRIEF_60, 'unseen'],
      // agy counts `+60 lines` for 60 lines where claude counts 59.
      ['antigravity', AGY_PASTED_60, BRIEF_60, 'landed'],
      ['antigravity', AGY_PASTED_CHARS, BRIEF_FLAT, 'landed'],
      ['antigravity', AGY_IDLE, BRIEF_60, 'unseen'],
      ['command-code', CC_PASTED_60, BRIEF_60, 'landed'],
      // Command Code echoes the paste's first ten characters: `PROBE P12k` is not this body.
      ['command-code', CC_PASTED_60, BRIEF_30, 'mismatch'],
      ['command-code', CC_IDLE, BRIEF_60, 'unseen'],
    ] as const)('%s: %#', (cliToolId, pane, message, expected) => {
      expect(classifyPasteLanded(pane, cliToolId, message)).toBe(expected);
    });

    it('is a mismatch when the composer holds two pastes, or a paste plus other text', () => {
      expect(classifyPasteLanded('❯ [Pasted text #1 +29 lines][Pasted text #2 +29 lines]', 'claude', BRIEF_60)).toBe('mismatch');
      expect(classifyPasteLanded('❯ echo PREFILLED[Pasted text #2 +59 lines]', 'claude', BRIEF_60)).toBe('mismatch');
    });

    it('accepts the #N-less placeholder of #1469\'s version drift', () => {
      expect(classifyPasteLanded('❯ [Pasted text +59 lines]', 'claude', BRIEF_60)).toBe('landed');
    });
  });

  // -------------------------------------------------------------------------
  // The verify window reads what is drawn, not the padding under it
  // -------------------------------------------------------------------------
  describe('classifySubmit() on top-anchored TUIs', () => {
    it.each([
      ['codex', CODEX_PASTED],
      ['antigravity', AGY_PASTED_60],
      ['command-code', CC_PASTED_60],
    ] as const)('%s: a paste still in the composer after Enter is pending', (cliToolId, pane) => {
      // ~700 blank rows sit under this composer. Reading the last twelve rows of
      // the capture found nothing and returned `submitted` for every send.
      expect(pane.split('\n').slice(-12).every((row) => row.trim() === '')).toBe(true);
      expect(classifySubmit(pane, cliToolId, BRIEF_60)).toBe('pending');
    });

    it.each([
      ['codex', CODEX_IDLE],
      ['antigravity', AGY_IDLE],
      ['command-code', CC_IDLE],
    ] as const)('%s: an idle composer is still submitted', (cliToolId, pane) => {
      expect(classifySubmit(pane, cliToolId, BRIEF_60)).toBe('submitted');
    });
  });

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------
  describe('transport', () => {
    it('pastes a long body as one bracketed paste and never types it', async () => {
      scriptPane({ clearReads: [CODEX_IDLE], beforeEnter: [CODEX_PASTED], afterEnter: CODEX_IDLE });

      await send(BRIEF_60, 'codex');

      expect(sendKeys).not.toHaveBeenCalled();
      const [load, paste] = tmuxCalls;
      expect(load.args).toEqual(['load-buffer', '-b', expect.stringMatching(/^cm-send-\d+-\d+$/), '-']);
      expect(load.stdin).toBe(BRIEF_60);
      // -p brackets it (only if the TUI asked), -r keeps LF from becoming an
      // Enter per line, -d leaves no copy of the body in the tmux server.
      expect(paste.args).toEqual(['paste-buffer', '-p', '-r', '-d', '-b', load.args[2], '-t', `=${SESSION}:`]);
      expect(enterCount()).toBe(1);
    });

    it('keeps typing bodies up to LITERAL_SEND_MAX_BYTES, and pastes one byte more', async () => {
      scriptPane({ clearReads: [CLAUDE_IDLE], beforeEnter: [CLAUDE_IDLE], afterEnter: CLAUDE_IDLE });
      const typed = 'a'.repeat(LITERAL_SEND_MAX_BYTES);
      await send(typed, 'claude');
      expect(sendKeys).toHaveBeenCalledWith(SESSION, typed, false, { literal: true });
      expect(tmuxCalls).toEqual([]);

      vi.clearAllMocks();
      tmuxCalls = [];
      stubExecFile();
      const pasted = 'a'.repeat(LITERAL_SEND_MAX_BYTES + 1);
      scriptPane({ clearReads: [CLAUDE_IDLE], beforeEnter: [`❯ ${pasted.slice(0, 150)}`], afterEnter: CLAUDE_IDLE });
      await send(pasted, 'claude');
      expect(sendKeys).not.toHaveBeenCalled();
      expect(tmuxCalls[0].stdin).toBe(pasted);
    });

    it('measures the limit in bytes, so 171 three-byte characters are pasted', async () => {
      const kana = 'あ'.repeat(171); // 513 bytes, 171 characters
      scriptPane({ clearReads: [CLAUDE_IDLE], beforeEnter: [`❯ ${kana.slice(0, 60)}`], afterEnter: CLAUDE_IDLE });
      await send(kana, 'claude');
      expect(sendKeys).not.toHaveBeenCalled();
      expect(tmuxCalls[0].stdin).toBe(kana);
    });

    it('drops the buffer and throws, without Enter, when load-buffer fails', async () => {
      stubExecFile('load-buffer');
      scriptPane({ clearReads: [CLAUDE_IDLE], beforeEnter: [CLAUDE_IDLE], afterEnter: CLAUDE_IDLE });

      await expect(send(BRIEF_60, 'claude')).rejects.toThrow(/Failed to paste message into tmux session/);

      expect(tmuxCalls.map((c) => c.args[0])).toEqual(['load-buffer', 'delete-buffer']);
      expect(enterCount()).toBe(0);
      expect(verifyReads()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Enter waits for the whole body
  // -------------------------------------------------------------------------
  describe('Enter waits for the whole body', () => {
    it('does not press Enter while the placeholder counts fewer lines than the body (paste中のplaceholderでEnterを打たない)', async () => {
      scriptPane({
        // pre-send read, then the withdraw loop: one pass, then empty
        clearReads: [CLAUDE_IDLE, CLAUDE_PASTED_30, CLAUDE_IDLE],
        beforeEnter: [CLAUDE_PASTED_30],
        afterEnter: CLAUDE_IDLE,
      });

      await expect(send(BRIEF_60, 'claude')).rejects.toThrow(
        /did not arrive intact.*had not finished arriving.*\[Pasted text #\d+ \+29 lines\].*12288 bytes \/ 60 lines/
      );

      expect(enterCount()).toBe(0);
      // The whole wait was spent reading, not pressing.
      expect(verifyReads()).toBe(20);
      // The half-pasted body was taken back out of the composer.
      expect(clearComposerLine).toHaveBeenCalledWith(SESSION);
      expect(loggerSpies.error).toHaveBeenCalledWith(
        'paste-not-landed',
        expect.objectContaining({ state: 'pasting', bytes: 12288, lines: 60 })
      );
    });

    it('presses Enter once the placeholder reaches the body\'s line count', async () => {
      scriptPane({
        clearReads: [CLAUDE_IDLE],
        beforeEnter: [CLAUDE_PASTED_30, CLAUDE_PASTED_60],
        afterEnter: CLAUDE_IDLE,
      });

      await send(BRIEF_60, 'claude');

      expect(enterCount()).toBe(1);
      const verifyOrders = vi.mocked(capturePane).mock.calls
        .map((c, i) => ({ numeric: typeof c[1] === 'number', order: vi.mocked(capturePane).mock.invocationCallOrder[i] }))
        .filter((c) => !c.numeric)
        .map((c) => c.order);
      // The complete placeholder was read (2nd read) before the one Enter.
      expect(verifyOrders[1]).toBeLessThan(vi.mocked(sendSpecialKeys).mock.invocationCallOrder[0]);
    });

    it('throws without Enter when only the tail arrived (到達不足でexit 0を返さない)', async () => {
      // `commandmate send` reports what the send route answers; this throw is the
      // route's 500 and the CLI's `Error: Server error: …` / exit 99. Before this
      // Issue the same frame was pressed Enter on, submitted as a 24-byte message,
      // and reported as `Message sent.`.
      scriptPane({
        clearReads: [CLAUDE_IDLE, CLAUDE_TAIL_ONLY, CLAUDE_IDLE],
        beforeEnter: [CLAUDE_TAIL_ONLY],
        afterEnter: CLAUDE_IDLE,
      });

      await expect(send(BRIEF_60, 'claude')).rejects.toThrow(
        /did not arrive intact.*does not hold the message as sent.*"key xray yankee zulu al\.".*12288 bytes \/ 60 lines.*Enter was not pressed/
      );

      expect(enterCount()).toBe(0);
      // No waiting it out: a tail never becomes the message.
      expect(verifyReads()).toBe(1);
      expect(clearComposerLine).toHaveBeenCalledWith(SESSION);
    });

    it('throws without Enter when the paste never shows in a composer this module reads (claude)', async () => {
      scriptPane({ clearReads: [CLAUDE_IDLE], beforeEnter: [CLAUDE_IDLE], afterEnter: CLAUDE_IDLE });

      await expect(send(BRIEF_60, 'claude')).rejects.toThrow(/never appeared in the composer/);
      expect(enterCount()).toBe(0);
    });

    it('proceeds with a warning when an unmeasured composer shows nothing (gemini)', async () => {
      scriptPane({ clearReads: ['> '], beforeEnter: ['> '], afterEnter: '> ' });

      await send(BRIEF_60, 'gemini');

      expect(enterCount()).toBe(1);
      expect(loggerSpies.warn).toHaveBeenCalledWith(
        'paste-landed-unverified',
        expect.objectContaining({ cliToolId: 'gemini', bytes: 12288 })
      );
    });

    it.each([
      ['codex', CODEX_IDLE, CODEX_PASTED, CODEX_IDLE],
      ['antigravity', AGY_IDLE, AGY_PASTED_60, AGY_IDLE],
      ['command-code', CC_IDLE, CC_PASTED_60, CC_IDLE],
    ] as const)('%s: sends the 60-line brief once its placeholder is complete', async (cliToolId, idle, pasted, after) => {
      scriptPane({ clearReads: [idle], beforeEnter: [pasted], afterEnter: after });

      await send(BRIEF_60, cliToolId);

      expect(tmuxCalls[0].stdin).toBe(BRIEF_60);
      expect(enterCount()).toBe(1);
    });

    it('codex: a paste still in the composer after Enter gets one more Enter', async () => {
      // Unreachable before: the verify window was the blank rows under codex's
      // composer, so this frame classified as submitted.
      let reads = 0;
      vi.mocked(capturePane).mockImplementation((async (_s: string, arg?: unknown) => {
        if (typeof arg === 'number') return CODEX_IDLE;
        reads++;
        return reads <= 2 ? CODEX_PASTED : CODEX_IDLE;
      }) as never);

      await send(BRIEF_60, 'codex');

      expect(enterCount()).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Arrival, in bytes: the measured matrix and the model it calibrates
  // -------------------------------------------------------------------------
  describe('arrival in bytes (tests/fixtures/long-body-2464/matrix.json)', () => {
    interface MatrixRow {
      tool: string;
      path: 'send-keys' | 'paste';
      body: string;
      sentBytes: number;
      arrivedBytes: number;
      identical: boolean;
    }
    const matrix = JSON.parse(readFileSync(path.join(FIXTURES, 'matrix.json'), 'utf8')) as {
      ptyReadBytes: number;
      rows: MatrixRow[];
    };

    /**
     * What claude 2.1.268's composer keeps of the bytes a pane delivers: a
     * bracketed paste is read as one unit; unbracketed input keeps only its last
     * pty read. Calibrated by the first test below against the transcripts.
     */
    function claudeKeeps(delivered: Buffer): Buffer {
      const open = Buffer.from('\x1b[200~');
      const close = Buffer.from('\x1b[201~');
      if (delivered.subarray(0, open.length).equals(open) && delivered.subarray(-close.length).equals(close)) {
        return delivered.subarray(open.length, delivered.length - close.length);
      }
      const lastRead = delivered.length % matrix.ptyReadBytes || matrix.ptyReadBytes;
      return delivered.subarray(delivered.length - lastRead);
    }

    it('every claude loss on the send-keys path is exactly the last pty read', () => {
      const losses = matrix.rows.filter((r) => r.tool === 'claude' && r.path === 'send-keys' && !r.identical);
      expect(losses.length).toBeGreaterThanOrEqual(4);
      for (const row of losses) {
        expect(row.arrivedBytes).toBe(row.sentBytes % matrix.ptyReadBytes);
        expect(claudeKeeps(Buffer.alloc(row.sentBytes, 0x61)).length).toBe(row.arrivedBytes);
      }
    });

    it('the paste path delivered every body whole, on every tool', () => {
      const pasted = matrix.rows.filter((r) => r.path === 'paste');
      for (const tool of ['claude', 'codex', 'command-code', 'antigravity']) {
        const brief = pasted.find((r) => r.tool === tool && r.body === 'P12knl');
        expect(brief, `${tool} P12knl`).toMatchObject({ identical: true, arrivedBytes: 12288 });
      }
      for (const row of pasted) {
        expect(row, `${row.tool} ${row.body}`).toMatchObject({ identical: true, arrivedBytes: row.sentBytes });
      }
    });

    it('types only what fits in one pty read', () => {
      expect(LITERAL_SEND_MAX_BYTES).toBeLessThan(matrix.ptyReadBytes);
    });

    it('what the sender hands tmux arrives whole under the measured model', async () => {
      scriptPane({ clearReads: [CLAUDE_IDLE], beforeEnter: [CLAUDE_PASTED_60], afterEnter: CLAUDE_IDLE });

      await send(BRIEF_60, 'claude');

      // paste-buffer -p wraps the buffer in bracket codes for a TUI that asked
      // for them (claude does); -r leaves its bytes as they were loaded.
      const loaded = Buffer.from(tmuxCalls[0].stdin ?? '', 'utf8');
      const delivered = Buffer.concat([Buffer.from('\x1b[200~'), loaded, Buffer.from('\x1b[201~')]);
      expect(claudeKeeps(delivered).equals(Buffer.from(BRIEF_60, 'utf8'))).toBe(true);
      expect(claudeKeeps(delivered).length).toBe(Buffer.byteLength(BRIEF_60, 'utf8'));
      // The same bytes typed with send-keys -l reproduce the reported loss.
      expect(claudeKeeps(Buffer.from(BRIEF_60, 'utf8')).toString()).toBe('key xray yankee zulu al.');
    });
  });
});
