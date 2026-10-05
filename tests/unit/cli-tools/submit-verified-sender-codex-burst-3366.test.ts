/**
 * Issue #3366: codex kept the body in its composer and the send said `Message sent.`
 *
 * Measured on codex-cli 0.160.0 at the production 200x1000 geometry
 * (`tests/fixtures/codex-send-burst-3366/README.md`): codex holds fast
 * keystrokes back as a "paste burst" and draws them only when the burst ends —
 * ~380 ms for the 78-character body of the report — and an Enter that arrives
 * before that becomes a newline under the body. The sender pressed Enter 100 ms
 * after typing, read the pane back 200 ms later, still saw the dim idle
 * placeholder (the body had not been drawn yet) and took it for "the message
 * left the composer".
 *
 * What is pinned here:
 *   - the frames: the in-burst frame the old read-back accepted, the stuck frame
 *     it turns into, and the frames of a send that worked;
 *   - on a simulated codex that behaves as measured, the send submits the body
 *     (fails on the pre-#3366 sender, which resolved with the body unsent);
 *   - a body that never appears THROWS before Enter, so the caller cannot print
 *     `Message sent.`;
 *   - without `awaitTypedBody`, and for a tool whose composer is not read, the
 *     send is the old fixed-wait send.
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

const loggerSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ ...loggerSpies, withContext: () => loggerSpies }),
}));

import { sendMessageWithSubmitVerification, classifySubmit } from '@/lib/cli-tools/submit-verified-sender';
import { extractComposerText } from '@/lib/detection/composer-text';
import { sendKeys, sendSpecialKeys, capturePane, clearComposerLine } from '@/lib/tmux/tmux';
import type { CLIToolType } from '@/lib/cli-tools/types';

const SESSION = 'mcbd-codex-burst';
const FIXTURES = path.resolve(__dirname, '../../fixtures/codex-send-burst-3366');
const frame = (name: string): string => readFileSync(path.join(FIXTURES, `${name}.capture`), 'utf8');

/** 100 ms after `send-keys`: the body is still held in the burst. */
const TYPED_IN_BURST = frame('typed-in-burst');
/** 200 ms after an Enter pressed in the burst — the frame the old read-back accepted. */
const VERIFY_AFTER_ENTER_IN_BURST = frame('verify-after-enter-in-burst');
/** 1.5 s later: the body is drawn, with the Enter as a newline under it, unsent. */
const STUCK = frame('stuck-after-enter-in-burst');
/** The body drawn, before Enter. */
const BODY_LANDED = frame('body-landed');
/** Enter pressed on {@link BODY_LANDED}: codex is working. */
const SUBMITTED = frame('submitted-working');

/** The Issue's body. Measured: drawn ~380 ms after `send-keys`. */
const BODY_5 = "Run the shell command 'sleep 15 && ls', then reply with the single word WORD5.";
const BODY_6 = "Run the shell command 'sleep 15 && ls', then reply with the single word WORD6.";

/**
 * {@link BODY_LANDED} with the body of the stuck frame, so one simulated send
 * goes through the frames of one body. Only the word differs; both frames are
 * live captures of the same composer.
 */
const BODY_LANDED_5 = BODY_LANDED.replace('WORD6.', 'WORD5.');

/** When the simulated codex draws a typed body, ms after `send-keys`. */
const DRAWN_AFTER_MS = 380;

const enterCount = (): number =>
  vi.mocked(sendSpecialKeys).mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'Enter').length;

/**
 * A codex that behaves as measured: the body is drawn {@link DRAWN_AFTER_MS}
 * after it was typed; an Enter before that is a newline (the stuck frame), an
 * Enter after it submits. `drawn: false` is a codex that never draws the body.
 */
function simulateCodex(options: { drawn?: boolean } = {}): { submitted: () => boolean } {
  const drawn = options.drawn ?? true;
  let typedAt: number | null = null;
  let enterInBurst = false;
  let submitted = false;
  const isDrawn = (): boolean => drawn && typedAt !== null && Date.now() - typedAt >= DRAWN_AFTER_MS;

  vi.mocked(sendKeys).mockImplementation((async () => {
    typedAt = Date.now();
  }) as never);
  vi.mocked(sendSpecialKeys).mockImplementation((async (_s: string, keys: string[]) => {
    if (keys[0] !== 'Enter') return;
    if (isDrawn()) submitted = true;
    else enterInBurst = true;
  }) as never);
  vi.mocked(capturePane).mockImplementation((async (_s: string, arg?: unknown) => {
    // The pre-send clear (`capturePane(name, 200)`) finds an idle composer.
    if (typeof arg === 'number' || typedAt === null) return TYPED_IN_BURST;
    if (submitted) return SUBMITTED;
    if (!isDrawn()) return enterInBurst ? VERIFY_AFTER_ENTER_IN_BURST : TYPED_IN_BURST;
    return enterInBurst ? STUCK : BODY_LANDED_5;
  }) as never);

  return { submitted: () => submitted };
}

async function send(message: string, cliToolId: CLIToolType, extra: { awaitTypedBody?: boolean } = {}): Promise<void> {
  const p = sendMessageWithSubmitVerification({ sessionName: SESSION, message, cliToolId, ...extra });
  const settled = p.then(() => undefined, (error: unknown) => { throw error; });
  settled.catch(() => undefined);
  await vi.runAllTimersAsync();
  return settled;
}

describe('submit-verified-sender: codex paste burst (Issue #3366)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(clearComposerLine).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the live frames', () => {
    it('reads the in-burst frames as an idle composer: the body is not on screen yet', () => {
      expect(extractComposerText(TYPED_IN_BURST, 'codex').state).toBe('ghost');
      expect(extractComposerText(VERIFY_AFTER_ENTER_IN_BURST, 'codex').state).toBe('ghost');
    });

    it('is the frame the pre-#3366 read-back took for a sent message', () => {
      // The reason the defect said `Message sent.`: after Enter, this frame
      // cannot be told from a real submit by the composer alone.
      expect(classifySubmit(VERIFY_AFTER_ENTER_IN_BURST, 'codex', BODY_5)).toBe('submitted');
    });

    it('reads the stuck frame as unsent: the body is still in the composer', () => {
      expect(extractComposerText(STUCK, 'codex')).toEqual({ text: BODY_5, state: 'content' });
      expect(classifySubmit(STUCK, 'codex', BODY_5)).toBe('pending');
    });

    it('reads a send that worked as sent', () => {
      expect(extractComposerText(BODY_LANDED, 'codex')).toEqual({ text: BODY_6, state: 'content' });
      expect(classifySubmit(SUBMITTED, 'codex', BODY_6)).toBe('submitted');
    });
  });

  describe('send', () => {
    it('submits the body: Enter waits until codex has drawn it', async () => {
      const codex = simulateCodex();

      await send(BODY_5, 'codex', { awaitTypedBody: true });

      // Before #3366 this resolved with `submitted() === false`: Enter at 100 ms
      // was a newline, and the 300 ms read-back saw the placeholder.
      expect(codex.submitted()).toBe(true);
      expect(enterCount()).toBe(1);
    });

    it('throws without pressing Enter when the body never appears', async () => {
      const codex = simulateCodex({ drawn: false });

      await expect(send(BODY_5, 'codex', { awaitTypedBody: true })).rejects.toThrow(
        /did not appear in the composer.*Enter was not pressed/
      );
      expect(enterCount()).toBe(0);
      expect(codex.submitted()).toBe(false);
      expect(loggerSpies.error).toHaveBeenCalledWith('typed-body-not-landed', expect.objectContaining({ cliToolId: 'codex' }));
    });

    it('does not take a prefix of the body for the body', async () => {
      const partial = BODY_LANDED.replace('WORD6.', '');
      vi.mocked(capturePane).mockImplementation((async (_s: string, arg?: unknown) =>
        typeof arg === 'number' ? TYPED_IN_BURST : partial) as never);

      await expect(send(BODY_6, 'codex', { awaitTypedBody: true })).rejects.toThrow(/did not appear/);
      expect(enterCount()).toBe(0);
    });

    it('resends Enter when the body is still in the composer after Enter', async () => {
      // The stuck frame is "pending", so the bounded resend runs — a manual
      // Enter is what sent it in the report.
      let enters = 0;
      vi.mocked(sendSpecialKeys).mockImplementation((async () => {
        enters++;
      }) as never);
      vi.mocked(capturePane).mockImplementation((async (_s: string, arg?: unknown) => {
        if (typeof arg === 'number') return TYPED_IN_BURST;
        if (enters === 0) return BODY_LANDED_5;
        return enters === 1 ? STUCK : SUBMITTED;
      }) as never);

      await send(BODY_5, 'codex', { awaitTypedBody: true });
      expect(enters).toBe(2);
    });

    it('without awaitTypedBody, presses Enter after the fixed wait as before', async () => {
      simulateCodex();

      await send(BODY_5, 'codex');

      const enterAt = vi.mocked(sendSpecialKeys).mock.invocationCallOrder[0];
      const readsBeforeEnter = vi
        .mocked(capturePane)
        .mock.calls.filter((c, i) => typeof c[1] !== 'number' && vi.mocked(capturePane).mock.invocationCallOrder[i] < enterAt);
      expect(readsBeforeEnter).toHaveLength(0);
    });

    it('ignores awaitTypedBody for a tool whose composer is not read', async () => {
      vi.mocked(capturePane).mockResolvedValue('> ');

      await send('hello', 'gemini', { awaitTypedBody: true });

      expect(enterCount()).toBe(1);
      expect(capturePane).toHaveBeenCalledTimes(1);
    });
  });
});
