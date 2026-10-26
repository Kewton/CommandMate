/**
 * Issue #3937: a codex paste drawn after the 2-second wait was left in the composer.
 *
 * On 2026-10-25 a 7,464-byte / 58-line `ask` to codex 0.164.0 failed as
 * `paste-not-landed {"state":"unseen"}` — the idle placeholder for the whole
 * 2 s — and afterwards `[Pasted Content 3575 chars]` sat in the composer, where
 * nothing withdrew it. What is pinned here, by scripting the frames the send
 * reads:
 *
 *   - after an `unseen` verdict the composer is watched for
 *     `PASTE_LATE_ARRIVAL_WINDOW_MS` inside the send, BEFORE it throws;
 *   - a placeholder that shows up in that window is withdrawn (`C-e`+`BSpace`);
 *   - one that never shows up gets no key at all, and the send still fails;
 *   - one that cannot be withdrawn is logged after `paste-not-landed` and named
 *     in the error.
 *
 * Plus the count check behind the 3,575 of a 7,464-byte body: a placeholder's
 * `N chars` is compared with the body's code points, so a Japanese body is
 * `landed` at its character count and `pasting` below it.
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
  clearComposerPasteToken: vi.fn().mockResolvedValue(undefined),
  exactTarget: (name: string) => `=${name}:`,
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

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
  classifyPasteLanded,
  PASTE_LATE_ARRIVAL_WINDOW_MS,
} from '@/lib/cli-tools/submit-verified-sender';
import {
  sendKeys,
  sendSpecialKeys,
  capturePane,
  clearComposerLine,
  clearComposerPasteToken,
  clearInputLine,
} from '@/lib/tmux/tmux';
import { MAX_COMPOSER_CLEAR_PASSES } from '@/lib/session/composer-clear';

const SESSION = 'mcbd-codex-late-paste';
const FIXTURES = path.resolve(__dirname, '../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const IDLE = read('long-body-2464/codex-idle.capture');
const LIVE_TOKEN = read('long-body-2464/codex-pasted-content.capture');

/** The live frame with its placeholder redrawn at `chars` (same row, same ANSI). */
const tokenFrame = (chars: number): string =>
  LIVE_TOKEN.replace('[Pasted Content 12288 chars]', `[Pasted Content ${chars} chars]`);

/** A Japanese-heavy brief of about the reported size: 58 lines, three-byte characters. */
const JA_BODY = Array.from(
  { length: 58 },
  (_, i) => `L${String(i + 1).padStart(2, '0')} 整合性レビューの依頼です。差分を読み、指摘を書いてください。`
).join('\n');
const JA_CHARS = [...JA_BODY].length;

const enterCount = (): number =>
  vi.mocked(sendSpecialKeys).mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'Enter').length;

/** tmux argv of every execFile call (load-buffer / paste-buffer). */
let tmuxCalls: string[][] = [];

/**
 * Script the pane. `clearReads` serve clearComposer's numeric-signature reads
 * (the pre-send clear, then the withdrawal); `verifyReads` serve the sender's
 * `{ startLine }` reads — the 2-second wait, then the late-arrival watch. The
 * last frame of each list repeats.
 */
function scriptPane(options: { clearReads: string[]; verifyReads: string[] }): void {
  let clearIndex = 0;
  let verifyIndex = 0;
  vi.mocked(capturePane).mockImplementation((async (_session: string, arg?: unknown) => {
    if (typeof arg === 'number') return options.clearReads[Math.min(clearIndex++, options.clearReads.length - 1)];
    return options.verifyReads[Math.min(verifyIndex++, options.verifyReads.length - 1)];
  }) as never);
}

const verifyReadCount = (): number =>
  vi.mocked(capturePane).mock.calls.filter((c) => typeof c[1] !== 'number').length;

/** Runs the send to completion; `events` records when the promise settled. */
async function send(events: string[]): Promise<Error | null> {
  const p = sendMessageWithSubmitVerification({ sessionName: SESSION, message: JA_BODY, cliToolId: 'codex' });
  const settled = p.then(
    () => { events.push('settled'); return null; },
    (error: unknown) => { events.push('settled'); return error as Error; }
  );
  await vi.runAllTimersAsync();
  return settled;
}

const unseenWait = (): string[] => Array(20).fill(IDLE);

describe('submit-verified-sender: a paste drawn late (Issue #3937)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    tmuxCalls = [];
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null) => void
    ) => {
      tmuxCalls.push(args);
      queueMicrotask(() => callback(null));
      return { stdin: { end: () => undefined } };
    }) as never);
    vi.mocked(sendKeys).mockResolvedValue(undefined);
    vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);
    vi.mocked(clearInputLine).mockResolvedValue(undefined);
    vi.mocked(clearComposerLine).mockResolvedValue(undefined);
    vi.mocked(clearComposerPasteToken).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the body is pasted (over LITERAL_SEND_MAX_BYTES) and its bytes are not its characters', () => {
    expect(Buffer.byteLength(JA_BODY, 'utf8')).toBeGreaterThan(5000);
    expect(JA_CHARS).toBeLessThan(Buffer.byteLength(JA_BODY, 'utf8') / 2);
  });

  describe('classifyPasteLanded() counts a Japanese body in characters', () => {
    it('landed when the placeholder counts every character', () => {
      expect(classifyPasteLanded(tokenFrame(JA_CHARS), 'codex', JA_BODY)).toBe('landed');
    });

    it('pasting when it counts fewer', () => {
      expect(classifyPasteLanded(tokenFrame(JA_CHARS - 100), 'codex', JA_BODY)).toBe('pasting');
    });

    it('not landed at the byte count', () => {
      expect(classifyPasteLanded(tokenFrame(Buffer.byteLength(JA_BODY, 'utf8')), 'codex', JA_BODY)).toBe('mismatch');
    });
  });

  it('a placeholder drawn inside the window is withdrawn before the send fails', async () => {
    const events: string[] = [];
    vi.mocked(clearComposerPasteToken).mockImplementation(async () => { events.push('bspace'); });
    scriptPane({
      // pre-send clear: idle. Withdrawal: the late placeholder, then idle.
      clearReads: [IDLE, tokenFrame(JA_CHARS), IDLE],
      verifyReads: [...unseenWait(), IDLE, IDLE, tokenFrame(JA_CHARS)],
    });

    const error = await send(events);

    expect(error?.message).toMatch(/never appeared in the composer/);
    expect(error?.message).toMatch(/Enter was not pressed, so nothing was submitted/);
    expect(error?.message).toMatch(/It appeared 750ms later and was taken back out\./);
    expect(enterCount()).toBe(0);
    expect(events).toEqual(['bspace', 'settled']);
    expect(clearComposerLine).not.toHaveBeenCalled();
    expect(loggerSpies.error).toHaveBeenCalledWith(
      'paste-not-landed',
      expect.objectContaining({ cliToolId: 'codex', state: 'unseen' })
    );
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      'paste-late-withdrawn',
      expect.objectContaining({ lateState: 'landed', afterMs: 750, passes: 1 })
    );
    expect(loggerSpies.error).not.toHaveBeenCalledWith('paste-late-withdraw-failed', expect.anything());
  });

  it('nothing drawn inside the window: no key is sent, and the send fails', async () => {
    const events: string[] = [];
    scriptPane({ clearReads: [IDLE], verifyReads: [IDLE] });

    const error = await send(events);

    expect(error?.message).toMatch(/never appeared in the composer/);
    expect(error?.message).not.toMatch(/appeared \d+ms later/);
    expect(enterCount()).toBe(0);
    expect(clearComposerLine).not.toHaveBeenCalled();
    expect(clearComposerPasteToken).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
    expect(tmuxCalls.map((args) => args[0])).toEqual(['load-buffer', 'paste-buffer']);
    // The whole window was watched: 2 s of the wait, then the window.
    expect(verifyReadCount()).toBe(20 + PASTE_LATE_ARRIVAL_WINDOW_MS / 250);
    expect(loggerSpies.warn).not.toHaveBeenCalledWith('paste-late-withdrawn', expect.anything());
    expect(loggerSpies.error).not.toHaveBeenCalledWith('paste-late-withdraw-failed', expect.anything());
  });

  it('a late placeholder that cannot be withdrawn is logged after paste-not-landed and named in the error', async () => {
    const events: string[] = [];
    scriptPane({
      clearReads: [IDLE, tokenFrame(3575)],
      verifyReads: [...unseenWait(), tokenFrame(3575)],
    });

    const error = await send(events);

    expect(error?.message).toMatch(/It appeared 250ms later and could not be taken back out/);
    expect(enterCount()).toBe(0);
    expect(clearComposerPasteToken).toHaveBeenCalledTimes(MAX_COMPOSER_CLEAR_PASSES);
    const names = loggerSpies.error.mock.calls.map((c) => c[0]);
    expect(names.indexOf('paste-not-landed')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('paste-late-withdraw-failed')).toBeGreaterThan(names.indexOf('paste-not-landed'));
    expect(loggerSpies.error).toHaveBeenCalledWith(
      'paste-late-withdraw-failed',
      expect.objectContaining({
        lateState: 'mismatch', // 3,575 is more than this body's characters
        passes: MAX_COMPOSER_CLEAR_PASSES,
        remainingState: 'content',
        remainingText: '[Pasted Content 3575 chars]',
      })
    );
  });

  it('a paste that lands within the 2 s is still sent with one Enter, without the window', async () => {
    const events: string[] = [];
    vi.mocked(capturePane).mockImplementation((async (_session: string, arg?: unknown) => {
      if (typeof arg === 'number') return IDLE;
      return enterCount() > 0 ? IDLE : tokenFrame(JA_CHARS);
    }) as never);

    const error = await send(events);

    expect(error).toBeNull();
    expect(enterCount()).toBe(1);
    expect(clearComposerPasteToken).not.toHaveBeenCalled();
  });
});
