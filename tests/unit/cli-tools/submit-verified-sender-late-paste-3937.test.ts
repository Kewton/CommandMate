/**
 * Issue #3937: a codex paste drawn after the 2-second wait was left in the composer.
 *
 * On 2026-10-25 a 7,464-byte / 58-line `ask` to codex 0.164.0 failed as
 * `paste-not-landed {"state":"unseen"}` — the idle placeholder for the whole
 * 2 s — and afterwards `[Pasted Content 3575 chars]` sat in the composer.
 *
 * Watching for the late placeholder inside the failed send was tried and taken
 * back out of this Issue: without sends to one instance being serialised, what
 * the watch reads cannot be told apart from another send's paste (review of
 * 2026-10-27). What is pinned here:
 *
 *   - an `unseen` paste still fails right after the 2-second wait, with the
 *     withdrawal of #2464 and no extra watch (as on develop);
 *   - a placeholder left behind is taken out by the NEXT send's pre-send clear,
 *     with `C-e`+`BSpace` (the part of #3937 that stays);
 *   - the count check behind the 3,575 of a 7,464-byte body: a placeholder's
 *     `N chars` is compared with the body's code points.
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
import * as sender from '@/lib/cli-tools/submit-verified-sender';
import { sendMessageWithSubmitVerification, classifyPasteLanded } from '@/lib/cli-tools/submit-verified-sender';
import { sendSpecialKeys, capturePane, clearComposerLine, clearComposerPasteToken } from '@/lib/tmux/tmux';
import { classifySendFailure } from '@/lib/session/send-attempt-state';

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

/** Every pane read, in order: `clear` for clearComposer's reads, `verify` for the sender's. */
let reads: string[] = [];

/**
 * Script the pane. `clearReads` serve clearComposer's numeric-signature reads
 * (the pre-send clear, then the withdrawal); `verifyReads` serve the sender's
 * `{ startLine }` reads. The last frame of each list repeats.
 */
function scriptPane(options: { clearReads: string[]; verifyReads: string[] | ((enters: number) => string) }): void {
  let clearIndex = 0;
  let verifyIndex = 0;
  vi.mocked(capturePane).mockImplementation((async (_session: string, arg?: unknown) => {
    if (typeof arg === 'number') {
      reads.push('clear');
      return options.clearReads[Math.min(clearIndex++, options.clearReads.length - 1)];
    }
    reads.push('verify');
    const verifyReads = options.verifyReads;
    if (typeof verifyReads === 'function') return verifyReads(enterCount());
    return verifyReads[Math.min(verifyIndex++, verifyReads.length - 1)];
  }) as never);
}

async function send(): Promise<Error | null> {
  const settled = sendMessageWithSubmitVerification({ sessionName: SESSION, message: JA_BODY, cliToolId: 'codex' }).then(
    () => null,
    (error: unknown) => error as Error
  );
  await vi.runAllTimersAsync();
  return settled;
}

describe('submit-verified-sender: a paste drawn late (Issue #3937)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    reads = [];
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null) => void
    ) => {
      queueMicrotask(() => callback(null));
      return { stdin: { end: () => undefined } };
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the body is pasted (over LITERAL_SEND_MAX_BYTES) and its bytes are not its characters', () => {
    expect(Buffer.byteLength(JA_BODY, 'utf8')).toBeGreaterThan(sender.LITERAL_SEND_MAX_BYTES);
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

  it('an unseen paste fails right after the 2 s wait and is withdrawn, with no late watch', async () => {
    expect('PASTE_LATE_ARRIVAL_WINDOW_MS' in sender).toBe(false);
    scriptPane({ clearReads: [IDLE], verifyReads: [IDLE] });

    const error = await send();

    expect(error?.message).toMatch(/never appeared in the composer/);
    expect(error?.message).not.toMatch(/appeared \d+ms later/);
    expect(classifySendFailure(error)).toEqual({ state: 'indeterminate', reason: 'body-not-landed' });
    expect(enterCount()).toBe(0);
    // 20 reads of the 2-second wait, then the withdrawal's read — nothing in between.
    expect(reads).toEqual(['clear', ...Array(20).fill('verify'), 'clear']);
  });

  it('a placeholder left behind is taken out by the next send with C-e+BSpace, and that send goes through', async () => {
    scriptPane({
      // pre-send clear: the leftover placeholder, then idle after the BSpace pass.
      clearReads: [tokenFrame(3575), IDLE],
      verifyReads: (enters) => (enters > 0 ? IDLE : tokenFrame(JA_CHARS)),
    });

    const error = await send();

    expect(error).toBeNull();
    expect(clearComposerPasteToken).toHaveBeenCalledTimes(1);
    expect(clearComposerLine).not.toHaveBeenCalled();
    expect(enterCount()).toBe(1);
  });

  it('a paste that lands within the 2 s is still sent with one Enter', async () => {
    scriptPane({ clearReads: [IDLE], verifyReads: (enters) => (enters > 0 ? IDLE : tokenFrame(JA_CHARS)) });

    const error = await send();

    expect(error).toBeNull();
    expect(enterCount()).toBe(1);
    expect(clearComposerPasteToken).not.toHaveBeenCalled();
  });
});
