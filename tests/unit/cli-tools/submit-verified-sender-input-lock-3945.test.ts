/**
 * Issue #3945: sends to one instance go one at a time, re-check the pane under
 * the lock, only ever take back their own text, and wait out a paste that may
 * still arrive.
 *
 * A fake codex pane per session stands in for tmux (`@/lib/tmux/tmux` and
 * `child_process.execFile` are mocked; nothing real is driven). Every key a send
 * sends is logged in order, with the fake clock's time, so the assertions are
 * about what reached the pane and when — not about which function ran.
 *
 * Gaps that cannot be closed from the screen are pinned under their names
 * (`ACCEPTED GAP: …`), so a change that moves them is a visible test change.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn(),
  sendSpecialKeys: vi.fn(),
  capturePane: vi.fn(),
  clearInputLine: vi.fn(),
  clearComposerLine: vi.fn(),
  clearComposerPasteToken: vi.fn(),
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
  type SubmitVerifiedSendParams,
} from '@/lib/cli-tools/submit-verified-sender';
import {
  sendKeys,
  sendSpecialKeys,
  capturePane,
  clearInputLine,
  clearComposerLine,
  clearComposerPasteToken,
} from '@/lib/tmux/tmux';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import {
  CARRIED_PASTE_MARK_TTL_MS,
  INSTANCE_INPUT_LOCK_WAIT_MS,
  LATE_PASTE_OBSERVE_MS,
  getCarriedPasteMark,
  invalidateInstanceInput,
  leaveCarriedPasteMark,
  resetInstanceInputLocks,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';

const S = 'mcbd-codex-wt-3945';
const FIXTURES = path.resolve(__dirname, '../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const IDLE = read('long-body-2464/codex-idle.capture');
const LIVE_TOKEN = read('long-body-2464/codex-pasted-content.capture');
const LIVE_TOKEN_ROW = '\u001b[38;5;6m[Pasted Content 12288 chars]\u001b[39m';
const ESC = '\u001b';

/** The live frame with its composer holding `text` (a placeholder, typed text, or both). */
const composerFrame = (text: string): string => LIVE_TOKEN.replace(LIVE_TOKEN_ROW, text);
const token = (chars: number): string => `[Pasted Content ${chars} chars]`;
const tokenFrame = (...counts: number[]): string => composerFrame(counts.map(token).join(''));

const CODEX_DIALOG_FRAME = [
  '  Would you like to make the following edits?',
  '',
  `${ESC}[1m${ESC}[38;5;6m› 1. Yes, proceed (y)${ESC}[0m`,
  "  2. Yes, and don't ask again for these files",
  '',
  '  Press enter to confirm or esc to cancel',
].join('\n');

/** An ASCII body of exactly `chars` characters (pasted: over 512 bytes). */
const body = (label: string, chars: number): string => `${label} `.padEnd(chars, label.toLowerCase());

// ---------------------------------------------------------------------------
// The fake pane
// ---------------------------------------------------------------------------

interface Op {
  t: number;
  session: string;
  op: string;
}

let ops: Op[] = [];
const frames = new Map<string, string>();
const buffers = new Map<string, string>();
/** What the pane does when a body is pasted into it (default: its placeholder is drawn). */
let onPaste: (session: string, text: string) => void;
/** What the pane does on Enter (default: whatever is in the composer is submitted). */
let onEnter: (session: string) => void;
/** Called after each read, with the frame it returned. */
let afterRead: (session: string, frame: string) => void;
let readFailure: ((session: string) => Error | null) | null;
/** ms before `load-buffer` reports back (0: next microtask). */
let loadDelayMs = 0;
/** Issue #4011: the error a tmux subcommand (`load-buffer`, `paste-buffer`) fails with, if any. */
let execFailure: ((sub: string) => Error | null) | null = null;

const frameOf = (session: string): string => frames.get(session) ?? IDLE;
const log = (session: string, op: string): void => {
  ops.push({ t: Date.now(), session, op });
};
const opsOf = (session = S): string[] => ops.filter((o) => o.session === session).map((o) => o.op);
const keyOps = (session = S): string[] => opsOf(session).filter((o) => o !== 'read');

function installPane(): void {
  vi.mocked(capturePane).mockImplementation((async (session: string) => {
    const failure = readFailure?.(session) ?? null;
    if (failure !== null) throw failure;
    log(session, 'read');
    const frame = frameOf(session);
    afterRead(session, frame);
    return frame;
  }) as never);
  vi.mocked(sendKeys).mockImplementation((async (session: string, text: string) => {
    log(session, `type:${text}`);
    frames.set(session, composerFrame(text));
  }) as never);
  vi.mocked(sendSpecialKeys).mockImplementation((async (session: string, keys: string[]) => {
    log(session, keys.join('+').toLowerCase());
    if (keys[0] === 'Enter') onEnter(session);
  }) as never);
  vi.mocked(clearComposerLine).mockImplementation((async (session: string) => {
    log(session, 'c-e+c-u');
    frames.set(session, IDLE);
  }) as never);
  vi.mocked(clearComposerPasteToken).mockImplementation((async (session: string) => {
    log(session, 'c-e+bspace');
    frames.set(session, IDLE);
  }) as never);
  vi.mocked(clearInputLine).mockImplementation((async (session: string) => {
    log(session, 'c-u');
    frames.set(session, IDLE);
  }) as never);
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null) => void
  ) => {
    const name = args[args.indexOf('-b') + 1];
    const failure = execFailure?.(args[0]) ?? null;
    if (args[0] === 'load-buffer') {
      return {
        stdin: {
          end: (data: string) => {
            if (failure !== null) {
              queueMicrotask(() => callback(failure));
              return;
            }
            buffers.set(name, data);
            if (loadDelayMs > 0) setTimeout(() => callback(null), loadDelayMs);
            else queueMicrotask(() => callback(null));
          },
        },
      };
    }
    if (args[0] === 'paste-buffer') {
      const session = args[args.indexOf('-t') + 1].replace(/^=|:$/g, '');
      const text = buffers.get(name) ?? '';
      buffers.delete(name);
      log(session, `paste:${text.length}:${text.slice(0, 2)}`);
      onPaste(session, text);
      if (failure !== null) {
        queueMicrotask(() => callback(failure));
        return { stdin: { end: () => undefined } };
      }
    }
    queueMicrotask(() => callback(null));
    return { stdin: { end: () => undefined } };
  }) as never);
}

function send(params: Partial<SubmitVerifiedSendParams> & { message: string }): Promise<Error | null> {
  return sendMessageWithSubmitVerification({ sessionName: S, cliToolId: 'codex', ...params }).then(
    () => null,
    (error: unknown) => error as Error
  );
}

const enters = (session = S): number => opsOf(session).filter((o) => o === 'enter').length;
const loggedEvents = (spy: typeof loggerSpies.error): string[] => spy.mock.calls.map((c) => String(c[0]));

describe('submit-verified-sender under the instance input lock (Issue #3945)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetInstanceInputLocks();
    ops = [];
    frames.clear();
    buffers.clear();
    readFailure = null;
    loadDelayMs = 0;
    execFailure = null;
    afterRead = () => undefined;
    onPaste = (session, text) => frames.set(session, tokenFrame(text.length));
    onEnter = (session) => frames.set(session, IDLE);
    installPane();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetInstanceInputLocks();
  });

  // -------------------------------------------------------------------------
  // Stage 1: one writer at a time
  // -------------------------------------------------------------------------
  describe('stage 1: one writer at a time', () => {
    it('a second send sends nothing until the first has finished its check and withdrawal', async () => {
      const A = body('A', 600);
      const B = 'hello from B';
      // A's paste is never drawn: unseen, late watch, withdrawal, failure.
      onPaste = (session, text) => {
        if (text === A) return;
        frames.set(session, tokenFrame(text.length));
      };
      let aSettledAt = -1;
      const a = send({ message: A }).finally(() => {
        aSettledAt = ops.length;
      });
      const b = send({ message: B });
      await vi.runAllTimersAsync();

      expect((await a)?.message).toMatch(/never appeared in the composer/);
      expect(await b).toBeNull();
      const firstB = ops.findIndex((o) => o.op === `type:${B}`);
      expect(firstB).toBeGreaterThanOrEqual(aSettledAt);
      // Before A settled: A's paste, A's reads, nothing of B.
      expect(ops.slice(0, aSettledAt).some((o) => o.op.includes('B'))).toBe(false);
      expect(enters()).toBe(1);
    });

    it('a send that throws releases the composer, and the next one goes through', async () => {
      vi.mocked(sendKeys).mockRejectedValueOnce(new Error('Failed to send keys to tmux session: boom'));
      const a = send({ message: 'first' });
      const b = send({ message: 'second' });
      await vi.runAllTimersAsync();
      expect((await a)?.message).toMatch(/boom/);
      expect(await b).toBeNull();
      expect(keyOps()).toEqual(['type:second', 'enter']);
    });

    it('sends to different sessions do not wait for each other', async () => {
      const OTHER = `${S}-other`;
      let release!: () => void;
      const held = withInstanceInputLock(S, () => new Promise<void>((resolve) => (release = resolve)));
      const other = sendMessageWithSubmitVerification({ sessionName: OTHER, cliToolId: 'codex', message: 'other' });
      await vi.runAllTimersAsync();
      await expect(other).resolves.toBeUndefined();
      expect(keyOps(OTHER)).toEqual(['type:other', 'enter']);
      release();
      await held;
    });

    it('a send not admitted within the wait types nothing and fails as not-sent', async () => {
      let release!: () => void;
      const held = withInstanceInputLock(S, () => new Promise<void>((resolve) => (release = resolve)));
      const b = send({ message: 'late' });
      await vi.advanceTimersByTimeAsync(INSTANCE_INPUT_LOCK_WAIT_MS);
      const error = await b;
      expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'input-lock-timeout' });
      expect(ops).toEqual([]);
      release();
      await held;
      // C after the owner releases: B is gone for good, C goes through.
      const c = send({ message: 'C' });
      await vi.runAllTimersAsync();
      expect(await c).toBeNull();
      expect(keyOps()).toEqual(['type:C', 'enter']);
    });
  });

  // -------------------------------------------------------------------------
  // Stage 2: re-check under the lock
  // -------------------------------------------------------------------------
  describe('stage 2: re-check once the composer is ours', () => {
    it('a dialog that opened while B queued: B types nothing and fails as prompt-waiting', async () => {
      let release!: () => void;
      const held = withInstanceInputLock(S, async () => {
        await new Promise<void>((resolve) => (release = resolve));
        frames.set(S, CODEX_DIALOG_FRAME);
      });
      const b = send({ message: 'B body' });
      await vi.advanceTimersByTimeAsync(10);
      release();
      await held;
      await vi.runAllTimersAsync();
      const error = await b;
      expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-waiting' });
      expect(keyOps()).toEqual([]);
    });

    it('negative: the same queueing with the screen unchanged sends normally', async () => {
      let release!: () => void;
      const held = withInstanceInputLock(S, () => new Promise<void>((resolve) => (release = resolve)));
      const b = send({ message: 'B body' });
      await vi.advanceTimersByTimeAsync(10);
      release();
      await held;
      await vi.runAllTimersAsync();
      expect(await b).toBeNull();
      expect(keyOps()).toEqual(['type:B body', 'enter']);
    });

    it('a pane that cannot be re-read: nothing typed, not-sent (recheck-failed)', async () => {
      let release!: () => void;
      const held = withInstanceInputLock(S, () => new Promise<void>((resolve) => (release = resolve)));
      const b = send({ message: 'B body' });
      await vi.advanceTimersByTimeAsync(10);
      readFailure = () => new Error('Command failed: tmux capture-pane -t =x: -p');
      release();
      await held;
      await vi.runAllTimersAsync();
      expect(classifySendFailure(await b)).toEqual({ state: 'not-sent', reason: 'recheck-failed' });
      expect(keyOps()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Stage 3: only the owner's keys reach the pane
  // -------------------------------------------------------------------------
  describe('stage 3: ownership before every key', () => {
    it('a withdrawal whose session was replaced sends no keys and says so', async () => {
      const A = body('A', 600);
      onPaste = () => undefined; // never drawn
      const a = send({ message: A });
      await vi.advanceTimersByTimeAsync(500);
      invalidateInstanceInput(S); // the session was recreated under A
      await vi.runAllTimersAsync();
      expect((await a)?.message).toMatch(/never appeared/);
      expect(keyOps()).toEqual([`paste:600:A `]);
      expect(loggedEvents(loggerSpies.error)).toContain('paste-withdraw-skipped-not-owner');
      // A stale send leaves no mark for the new session either.
      expect(getCarriedPasteMark(S)).toBeNull();
    });

    it('no Enter from a send whose session was replaced after its body landed', async () => {
      const A = body('A', 600);
      // From outside A's async context (a timer the test's clock runs), as a
      // recreate from another request would be; A itself relaunching keeps its ticket.
      afterRead = (_session, frame) => {
        if (frame.includes(token(600))) setTimeout(() => invalidateInstanceInput(S), 0);
      };
      const a = send({ message: A, textInputWaitMs: 500 });
      await vi.runAllTimersAsync();
      expect((await a)?.message).toMatch(/handed to another writer before Enter/);
      expect(enters()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Stage 4: the late watch, and the carried mark
  // -------------------------------------------------------------------------
  describe('stage 4: late watch', () => {
    const A = body('A', 700);

    it('a placeholder drawn inside the watch is taken out before the failure; nothing is carried', async () => {
      onPaste = () => {
        setTimeout(() => frames.set(S, tokenFrame(700)), 3_000);
      };
      const a = send({ message: A });
      await vi.runAllTimersAsync();
      const error = await a;
      expect(error?.message).toMatch(/appeared \d+ms after the 2000ms check and was taken back out/);
      expect(classifySendFailure(error)).toEqual({ state: 'indeterminate', reason: 'body-not-landed' });
      expect(keyOps()).toEqual(['paste:700:A ', 'c-e+bspace']);
      expect(enters()).toBe(0);
      expect(getCarriedPasteMark(S)).toBeNull();
    });

    it('nothing drawn within the watch: fails without other keys, and leaves a mark', async () => {
      onPaste = () => undefined;
      const a = send({ message: A });
      await vi.runAllTimersAsync();
      expect((await a)?.message).toMatch(/never appeared in the composer/);
      expect(keyOps()).toEqual(['paste:700:A ']);
      expect(getCarriedPasteMark(S)).not.toBeNull();
    });

    it('a read that throws during the watch: withdrawn, body-not-landed, mark left', async () => {
      onPaste = () => undefined;
      const t0 = Date.now();
      readFailure = () =>
        Date.now() - t0 > 2_500 && Date.now() - t0 < 2_700 ? new Error('capture-pane failed') : null;
      const a = send({ message: A });
      await vi.runAllTimersAsync();
      const error = await a;
      expect(error?.message).toMatch(/could not be read while the paste was checked/);
      expect(classifySendFailure(error)).toEqual({ state: 'indeterminate', reason: 'body-not-landed' });
      // The withdrawal still read the composer (and found it empty).
      expect(opsOf().at(-1)).toBe('read');
      expect(getCarriedPasteMark(S)).not.toBeNull();
    });

    it.each([
      ['within the first 2 s', 1_000],
      ['during the late watch', 3_000],
    ])('the tail of its own body (mismatch) is taken out %s', async (_when, at) => {
      onPaste = () => {
        setTimeout(() => frames.set(S, composerFrame(A.slice(200, 260))), at);
      };
      const a = send({ message: A });
      await vi.runAllTimersAsync();
      const error = await a;
      expect(classifySendFailure(error)).toEqual({ state: 'indeterminate', reason: 'body-not-landed' });
      expect(keyOps()).toEqual(['paste:700:A ', 'c-e+c-u']);
      expect(enters()).toBe(0);
    });

    it.each([
      ['fewer characters than A', 650],
      ['as many as A', 700],
      ['more than A', 900],
    ])('B sent during A\'s watch (%s) waits for it, and A\'s withdrawal never takes B\'s text', async (_label, bChars) => {
      const B = body('B', bChars);
      onPaste = (session, text) => {
        if (text === A) {
          setTimeout(() => frames.set(S, tokenFrame(700)), 3_000);
          return;
        }
        frames.set(session, tokenFrame(text.length));
      };
      let aSettledAt = -1;
      const a = send({ message: A }).finally(() => {
        aSettledAt = ops.length;
      });
      await vi.advanceTimersByTimeAsync(2_500); // inside A's watch
      const b = send({ message: B });
      await vi.runAllTimersAsync();

      expect((await a)?.message).toMatch(/taken back out/);
      expect(await b).toBeNull();
      const bPaste = ops.findIndex((o) => o.op.startsWith(`paste:${bChars}:B`));
      expect(bPaste).toBeGreaterThanOrEqual(aSettledAt);
      // A's one withdrawal came before B's paste; nothing was cleared after it.
      expect(keyOps()).toEqual(['paste:700:A ', 'c-e+bspace', `paste:${bChars}:B `, 'enter']);
    });
  });

  describe('stage 4: the carried mark', () => {
    const A = body('A', 700);

    async function leaveMark(): Promise<number> {
      onPaste = () => undefined;
      const a = send({ message: A });
      await vi.runAllTimersAsync();
      await a;
      const mark = getCarriedPasteMark(S);
      expect(mark).not.toBeNull();
      ops = [];
      onPaste = (session, text) => frames.set(session, tokenFrame(text.length));
      return mark!.expiresAt;
    }

    it.each([
      ['a pasted B', body('B', 800), {}],
      ['a typed B', 'typed B body', { awaitTypedBody: true }],
    ])('%s sends neither body nor Enter until the mark expires, then goes through', async (_label, B, extra) => {
      const expiresAt = await leaveMark();
      const b = send({ message: B, ...extra });
      await vi.runAllTimersAsync();
      expect(await b).toBeNull();
      const firstKey = ops.find((o) => o.op !== 'read');
      expect(firstKey!.t).toBeGreaterThanOrEqual(expiresAt);
      expect(enters()).toBe(1);
      expect(getCarriedPasteMark(S)).toBeNull();
    });

    it('A\'s same-count placeholder drawn during the wait is taken out; B is typed only after the expiry and Enter submits only B', async () => {
      const B = body('B', 700); // same count as A: indistinguishable on screen
      const expiresAt = await leaveMark();
      const submitted: string[] = [];
      onEnter = (session) => {
        submitted.push(frameOf(session).includes(token(700)) ? 'a-700-token' : 'other');
        frames.set(session, IDLE);
      };
      let bPasted = false;
      onPaste = (session, text) => {
        bPasted = true;
        frames.set(session, tokenFrame(text.length));
      };
      // A's late placeholder arrives 1 s into B's wait.
      const startedAt = Date.now();
      setTimeout(() => {
        if (!bPasted) frames.set(S, tokenFrame(700));
      }, 1_000);
      const b = send({ message: B });
      await vi.runAllTimersAsync();

      expect(await b).toBeNull();
      expect(keyOps()).toEqual(['c-e+bspace', 'paste:700:B ', 'enter']);
      const bspace = ops.find((o) => o.op === 'c-e+bspace')!;
      expect(bspace.t).toBeLessThan(expiresAt);
      expect(bspace.t).toBeGreaterThanOrEqual(startedAt + 1_000);
      expect(ops.find((o) => o.op.startsWith('paste:'))!.t).toBeGreaterThanOrEqual(expiresAt);
      // The one Enter went in after B's own paste — the placeholder it submitted is B's.
      expect(submitted).toHaveLength(1);
    });

    it('a dialog that opens during the wait: no clear, no body, no Enter; not-sent (prompt-waiting)', async () => {
      await leaveMark();
      setTimeout(() => frames.set(S, CODEX_DIALOG_FRAME), 1_000);
      const b = send({ message: body('B', 800) });
      await vi.runAllTimersAsync();
      expect(classifySendFailure(await b)).toEqual({ state: 'not-sent', reason: 'prompt-waiting' });
      expect(keyOps()).toEqual([]);
    });

    it('a refused send does not take the mark down or move its expiry', async () => {
      const expiresAt = await leaveMark();
      frames.set(S, CODEX_DIALOG_FRAME);
      // B queued behind an owner, so it re-checks at once and is refused.
      let release!: () => void;
      const held = withInstanceInputLock(S, () => new Promise<void>((resolve) => (release = resolve)));
      const b = send({ message: 'B' });
      await vi.advanceTimersByTimeAsync(10);
      release();
      await held;
      await vi.advanceTimersByTimeAsync(10);
      expect(classifySendFailure(await b).reason).toBe('prompt-waiting');
      expect(getCarriedPasteMark(S)?.expiresAt).toBe(expiresAt);
    });

    it('A\'s placeholder drawn after the expiry but before B: B\'s pre-send clear takes it (C-e+BSpace) and B goes through', async () => {
      await leaveMark();
      await vi.advanceTimersByTimeAsync(CARRIED_PASTE_MARK_TTL_MS);
      frames.set(S, tokenFrame(700));
      const b = send({ message: body('B', 800) });
      await vi.runAllTimersAsync();
      expect(await b).toBeNull();
      expect(keyOps()).toEqual(['c-e+bspace', 'paste:800:B ', 'enter']);
    });

    describe('A\'s placeholder drawn after B\'s pre-send clear, in a form B can tell apart', () => {
      async function thenC(): Promise<void> {
        ops = [];
        onPaste = (session, text) => frames.set(session, tokenFrame(text.length));
        frames.set(S, IDLE);
        const c = send({ message: body('C', 900) });
        await vi.runAllTimersAsync();
        expect(await c).toBeNull();
        expect(keyOps()).toEqual(['paste:900:C ', 'enter']);
      }

      it('two placeholders: no Enter, B withdraws and fails; C goes through', async () => {
        const B = body('B', 800);
        onPaste = (session, text) => frames.set(session, tokenFrame(700, text.length));
        const b = send({ message: B });
        await vi.runAllTimersAsync();
        expect(classifySendFailure(await b).reason).toBe('body-not-landed');
        expect(enters()).toBe(0);
        expect(keyOps()).toEqual(['paste:800:B ', 'c-e+c-u']);
        await thenC();
      });

      it.each([
        ['fewer', 600],
        ['more', 900],
      ])('a different count (%s than B), B\'s own never drawn: no Enter, B withdraws and fails; C goes through', async (_label, aChars) => {
        const B = body('B', 800);
        onPaste = () => frames.set(S, tokenFrame(aChars));
        const b = send({ message: B });
        await vi.runAllTimersAsync();
        expect(classifySendFailure(await b).reason).toBe('body-not-landed');
        expect(enters()).toBe(0);
        expect(keyOps()).toEqual(['paste:800:B ', 'c-e+bspace']);
        await thenC();
      });

      it('a typed B on codex: the composer is not exactly B, so no Enter; B withdraws and fails; C goes through', async () => {
        vi.mocked(sendKeys).mockImplementationOnce((async (session: string, text: string) => {
          log(session, `type:${text}`);
          frames.set(session, composerFrame(`${token(700)}${text}`));
        }) as never);
        const b = send({ message: 'typed B', awaitTypedBody: true });
        await vi.runAllTimersAsync();
        expect(classifySendFailure(await b).reason).toBe('body-not-landed');
        expect(enters()).toBe(0);
        expect(keyOps()).toEqual(['type:typed B', 'c-e+c-u']);
        await thenC();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Accepted gaps (pinned so they do not change silently)
  // -------------------------------------------------------------------------
  describe('accepted gaps', () => {
    it('ACCEPTED GAP SAME_COUNT_LATE_TOKEN_BEFORE_OWN_PASTE: after the mark expired, A\'s placeholder of B\'s count before B\'s own is drawn reads as B\'s', async () => {
      const B = body('B', 700);
      expect(classifyPasteLanded(tokenFrame(700), 'codex', B)).toBe('landed');
      // B's own paste is never drawn; A's same-count placeholder is: Enter goes in on it.
      onPaste = () => frames.set(S, tokenFrame(700));
      const b = send({ message: B });
      await vi.runAllTimersAsync();
      expect(await b).toBeNull();
      expect(enters()).toBe(1);
    });

    it('ACCEPTED GAP TOKEN_BETWEEN_CHECK_AND_ENTER: a placeholder drawn after B\'s check and before its Enter goes in with it', async () => {
      const B = body('B', 800);
      const atEnter: string[] = [];
      onEnter = (session) => {
        atEnter.push(classifyPasteLanded(frameOf(session), 'codex', B));
        frames.set(session, IDLE);
      };
      afterRead = (session, frame) => {
        if (frame === tokenFrame(800)) frames.set(session, tokenFrame(800, 700));
      };
      const b = send({ message: B });
      await vi.runAllTimersAsync();
      expect(await b).toBeNull();
      expect(atEnter).toEqual(['mismatch']); // two placeholders, submitted together
    });

    describe('a placeholder drawn after B\'s first Enter (review #1)', () => {
      const B = body('B', 800);

      it('negative: nothing arrives — one Enter, sent', async () => {
        const b = send({ message: B });
        await vi.runAllTimersAsync();
        expect(await b).toBeNull();
        expect(keyOps()).toEqual(['paste:800:B ', 'enter']);
      });

      it.each([
        ['fewer characters than B', 600],
        ['more characters than B', 900],
      ])('%s: not B\'s, so no further Enter; the submit is left unconfirmed', async (_label, aChars) => {
        let first = true;
        onEnter = (session) => {
          frames.set(session, first ? tokenFrame(aChars) : IDLE);
          first = false;
        };
        const b = send({ message: B });
        await vi.runAllTimersAsync();
        expect(classifySendFailure(await b)).toEqual({ state: 'indeterminate', reason: 'submit-unconfirmed' });
        expect(keyOps().filter((o) => o === 'enter')).toEqual(['enter']);
        expect(loggedEvents(loggerSpies.warn)).toContain('submit-not-confirmed:foreign-paste-token');
      });

      it('ACCEPTED GAP LATE_TOKEN_AFTER_ENTER_SAME_COUNT: B\'s count cannot be told from B\'s eaten Enter, so Enter is resent', async () => {
        let first = true;
        onEnter = (session) => {
          frames.set(session, first ? tokenFrame(800) : IDLE);
          first = false;
        };
        const b = send({ message: B });
        await vi.runAllTimersAsync();
        expect(await b).toBeNull();
        expect(enters()).toBe(2);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Paste buffers across module loads (review #11)
  // -------------------------------------------------------------------------
  it('two loads of the sender (`next dev` bundles) never share a paste buffer name', async () => {
    vi.resetModules();
    const second = await import('@/lib/cli-tools/submit-verified-sender');
    expect(second.sendMessageWithSubmitVerification).not.toBe(sendMessageWithSubmitVerification);
    const S2 = `${S}-two`;
    const A = body('A', 600);
    const B = body('B', 700);
    const pasted = new Map<string, string>();
    onPaste = (session, text) => {
      pasted.set(session, text);
      frames.set(session, tokenFrame(text.length));
    };
    // Both loads land before either paste: the order in which a shared name
    // would hand A the body B loaded.
    loadDelayMs = 10;
    const a = sendMessageWithSubmitVerification({ sessionName: S, cliToolId: 'codex', message: A });
    const b = second.sendMessageWithSubmitVerification({ sessionName: S2, cliToolId: 'codex', message: B });
    await vi.runAllTimersAsync();
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
    expect(pasted.get(S)).toBe(A);
    expect(pasted.get(S2)).toBe(B);
    const names = vi
      .mocked(execFile)
      .mock.calls.map((c) => (c[1] as string[]))
      .filter((args) => args[0] === 'load-buffer')
      .map((args) => args[2]);
    expect(new Set(names).size).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Consistency review 1 (dev-reports/issue/3945/review-1.md)
  // -------------------------------------------------------------------------
  describe('review-1', () => {
    describe('#1 a sender inside an owner whose session was replaced does not take a new ticket', () => {
      /** The outer request (sendUserMessage) holds the lock and waits (readiness) before its sender runs. */
      async function outerThenSend(replace: boolean): Promise<Error | null> {
        let ready!: () => void;
        const outer = withInstanceInputLock(S, async () => {
          await new Promise<void>((resolve) => (ready = resolve));
          return send({ message: 'old request' });
        });
        await vi.advanceTimersByTimeAsync(10);
        if (replace) invalidateInstanceInput(S); // from another request, outside the outer context
        ready();
        await vi.runAllTimersAsync();
        return outer;
      }

      it('replaced while the outer request waited: nothing typed, not-sent (input-lock-lost)', async () => {
        const error = await outerThenSend(true);
        expect(error?.message).toMatch(/was replaced while this send held its composer/);
        expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'input-lock-lost' });
        expect(keyOps()).toEqual([]);
        // The new session's own first send is not held up by it.
        const fresh = send({ message: 'new request' });
        await vi.runAllTimersAsync();
        expect(await fresh).toBeNull();
        expect(keyOps()).toEqual(['type:new request', 'enter']);
      });

      it('negative: not replaced, the sender joins the outer ticket and sends', async () => {
        expect(await outerThenSend(false)).toBeNull();
        expect(keyOps()).toEqual(['type:old request', 'enter']);
      });
    });

    describe('#2 ownership is asked again right before paste-buffer', () => {
      const B = body('B', 700);
      const deletes = (): number =>
        vi.mocked(execFile).mock.calls.filter((c) => (c[1] as string[])[0] === 'delete-buffer').length;

      it('replaced while load-buffer ran: no paste reaches the pane, the buffer is dropped, not-sent', async () => {
        loadDelayMs = 100;
        const b = send({ message: B });
        await vi.advanceTimersByTimeAsync(50);
        invalidateInstanceInput(S);
        await vi.runAllTimersAsync();
        const error = await b;
        expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'input-lock-lost' });
        expect(error?.message).toMatch(/before paste-buffer/);
        expect(keyOps()).toEqual([]);
        expect(deletes()).toBe(1);
        expect(getCarriedPasteMark(S)).toBeNull();
      });

      it('negative: the same slow load-buffer with the session left alone pastes and submits', async () => {
        loadDelayMs = 100;
        const b = send({ message: B });
        await vi.runAllTimersAsync();
        expect(await b).toBeNull();
        expect(keyOps()).toEqual(['paste:700:B ', 'enter']);
        expect(deletes()).toBe(0);
      });
    });

    describe('#4 every send re-checks under the lock, queued or not', () => {
      it('a dialog on screen for a send admitted at once: nothing typed, not-sent (prompt-waiting)', async () => {
        frames.set(S, CODEX_DIALOG_FRAME);
        const b = send({ message: 'B body' });
        await vi.runAllTimersAsync();
        expect(classifySendFailure(await b)).toEqual({ state: 'not-sent', reason: 'prompt-waiting' });
        expect(keyOps()).toEqual([]);
      });

      it('negative: an idle pane, admitted at once, costs one read before the body (shared with the clear)', async () => {
        const b = send({ message: 'B body' });
        await vi.runAllTimersAsync();
        expect(await b).toBeNull();
        const ops0 = opsOf();
        expect(ops0.slice(0, ops0.indexOf('type:B body'))).toEqual(['read']);
      });
    });

    describe('#6 a keystroke send that failed part-way leaves the mark', () => {
      function failTyping(error: Error): void {
        vi.mocked(sendKeys).mockImplementationOnce((async (session: string, text: string) => {
          log(session, `type:${text}`);
          frames.set(session, IDLE); // nothing drawn yet; it may still be
          throw error;
        }) as never);
      }
      const delivery = (state: string): Error =>
        Object.assign(new Error('Command failed: tmux send-keys -t =s: -l -- B body'), { delivery: state });

      it.each([
        ['an indeterminate send-keys (timed out)', delivery('indeterminate')],
        ['an error of no known shape', new Error('boom')],
      ])('%s: a mark is left, and the next send waits it out', async (_label, error) => {
        failTyping(error);
        const b = send({ message: 'B body', awaitTypedBody: true });
        await vi.runAllTimersAsync();
        expect(await b).toBe(error);
        const mark = getCarriedPasteMark(S);
        expect(mark).not.toBeNull();
        ops = [];
        const c = send({ message: 'C body' });
        await vi.runAllTimersAsync();
        expect(await c).toBeNull();
        expect(ops.find((o) => o.op !== 'read')!.t).toBeGreaterThanOrEqual(mark!.expiresAt);
      });

      it('negative: a send-keys tmux never started leaves no mark', async () => {
        const error = delivery('not-started');
        failTyping(error);
        const b = send({ message: 'B body', awaitTypedBody: true });
        await vi.runAllTimersAsync();
        expect(await b).toBe(error);
        expect(getCarriedPasteMark(S)).toBeNull();
      });
    });
  });

  // Issue #4011: `load-buffer` runs before `paste-buffer`, so when it fails
  // nothing of the body has reached the pane — no mark, and the next send is
  // not held off. A failed `paste-buffer` may have put some of it there.
  describe('#4011 a failed load-buffer leaves no carried mark', () => {
    const B = body('B', 700);
    const C = body('C', 700);
    const tmuxFailure = (): Error =>
      Object.assign(new Error('Command failed: tmux load-buffer -b cm-send-1-1 -'), { code: 1 });

    it('load-buffer fails: nothing pasted, no mark, and the next send goes in without waiting', async () => {
      execFailure = (sub) => (sub === 'load-buffer' ? tmuxFailure() : null);
      const b = send({ message: B });
      await vi.runAllTimersAsync();
      const error = await b;
      expect(error?.message).toMatch(/Failed to paste message into tmux session/);
      expect(keyOps()).toEqual([]);
      expect(getCarriedPasteMark(S)).toBeNull();

      execFailure = null;
      ops = [];
      const startedAt = Date.now();
      const c = send({ message: C });
      await vi.runAllTimersAsync();
      expect(await c).toBeNull();
      expect(keyOps()).toEqual(['paste:700:C ', 'enter']);
      expect(ops.find((o) => o.op !== 'read')!.t - startedAt).toBeLessThan(CARRIED_PASTE_MARK_TTL_MS);
    });

    it('negative: paste-buffer fails after the body went in: the mark is left and the next send waits it out', async () => {
      execFailure = (sub) => (sub === 'paste-buffer' ? tmuxFailure() : null);
      onPaste = () => undefined; // nothing drawn yet; it may still be
      const b = send({ message: B });
      await vi.runAllTimersAsync();
      expect((await b)?.message).toMatch(/Failed to paste message into tmux session/);
      const mark = getCarriedPasteMark(S);
      expect(mark).not.toBeNull();

      execFailure = null;
      onPaste = (session, text) => frames.set(session, tokenFrame(text.length));
      ops = [];
      const c = send({ message: C });
      await vi.runAllTimersAsync();
      expect(await c).toBeNull();
      expect(ops.find((o) => o.op !== 'read')!.t).toBeGreaterThanOrEqual(mark!.expiresAt);
    });
  });

  it('an unexpired mark is left only by the owner (a stale ticket cannot leave one)', async () => {
    let stale: Parameters<typeof leaveCarriedPasteMark>[0] | null = null;
    await withInstanceInputLock(S, async (ticket) => {
      stale = ticket;
    });
    leaveCarriedPasteMark(stale!);
    expect(getCarriedPasteMark(S)).toBeNull();
    expect(LATE_PASTE_OBSERVE_MS).toBeGreaterThan(0);
  });
});
