/**
 * Issue #4084: opencode's and vibe-local's prompt waits (the wait before the
 * input lock) give up on a dialog only once it is confirmed — seen on 2 reads in
 * a row spanning {@link PROMPT_WAIT_DIALOG_CONFIRM_MS}, the count copilot's wait
 * has used since #4067 — and then refuse at once, on the wait's own reads. They
 * used to end the wait on one dialog read.
 *
 * The shared sender is the real one; tmux is mocked and every key is logged.
 * The frames are real captures (`tests/fixtures/vibe-local-readiness-4040/`,
 * `opencode-live-2047/`, `opencode-launch-boot-11821.ts`); the `(y/n)` dialog
 * rows appended to them are synthetic (the detector reads them as an active
 * prompt — pinned in the first control below).
 *
 * Controls:
 * - positive (each fails on the code before #4084): a dialog read once and then
 *   a screen still loading does not refuse the send (the wait goes on to the
 *   prompt); a dialog that stays up is refused only after the confirmation time;
 *   a capture that is slow at the deadline does not stretch the wait past 15 s
 *   nor is its late frame typed into;
 *   a dialog run cut by a normal frame or a failed capture is never confirmed
 *   (`prompt-not-ready` at the window, where the old wait ended on its first
 *   dialog read);
 * - positive (Codex review, P2): a frame that answers past the deadline is not
 *   used even when the deadline's timer has not run yet (the clock moved past
 *   it while the capture's completion was handled first) — opencode,
 *   vibe-local and copilot alike; copilot's wait does not wait for a capture
 *   still running at its deadline either (it typed the late prompt in before);
 * - negative (unchanged): a Working or loading screen is not counted; a dialog
 *   under the lock is refused on one read; an earlier `unknown` HTTP dispatch
 *   keeps the send `indeterminate`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});

vi.mock('@/lib/cli-tools/copilot-executable', () => ({
  resolveCopilotExecutable: vi.fn(),
}));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn(),
  clearInputLine: vi.fn().mockResolvedValue(undefined),
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn(),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
  exactTarget: (name: string) => `=${name}:`,
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { COPILOT_DIALOG_CONFIRM_MS, CopilotTool } from '@/lib/cli-tools/copilot';
import {
  PROMPT_WAIT_DIALOG_CONFIRM_MS,
  PROMPT_WAIT_DIALOG_CONFIRM_READS,
  createDialogConfirmation,
  readBeforeDeadline,
} from '@/lib/cli-tools/prompt-wait-dialog';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { INPUT_RECHECK_PROMPT_WAITING_CODE } from '@/lib/session/send-attempt-types';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { isVibeLocalComposerReady } from '@/lib/detection/tools/vibe-local/readiness';
import { isOpenCodeComposerReady } from '@/lib/detection/tools/opencode/readiness';
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { buildOpencodeClearedFrame, buildOpencodeComposerFrame } from '@tests/fixtures/opencode-launch-boot-11821';
import { COPILOT_MODEL_SWITCH_2623_FRAMES as COPILOT } from '@tests/fixtures/copilot-model-switch-2623';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const readFixture = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

/** The tool waits' window (15 s) — opencode's and vibe-local's alike. */
const WINDOW_MS = 15_000;
/** Reads that confirm a dialog up from the first read: 0, 500 … 2000 ms. */
const CONFIRMING_READS = PROMPT_WAIT_DIALOG_CONFIRM_MS / 500 + 1;

const VL = {
  ready: readFixture('vibe-local-readiness-4040/boot-ready.txt'),
  loading: readFixture('vibe-local-readiness-4040/boot-loading.txt'),
  generating: readFixture('vibe-local-readiness-4040/generating.txt'),
};
/** A y/n dialog drawn under vibe-local's loading screen (synthetic row). */
const VL_DIALOG = `${VL.loading.trimEnd()}\n\nAllow this command? (y/n)\n`;

const OC = {
  ready: buildOpencodeComposerFrame(),
  loading: buildOpencodeClearedFrame(),
  running: readFixture('opencode-live-2047/w80/turn-running.txt'),
  permission: readFixture('opencode-live-2047/w80/permission-bash.txt'),
  palette: readFixture('opencode-live-2047/w80/command-palette.txt'),
};
/** A y/n dialog the detector reads as an active prompt (synthetic row). */
const OC_ACTIVE_DIALOG = `${OC.loading}\nAllow this command? (y/n)\n`;

let keys: string[] = [];
let captures = 0;

/** Every capture answers from `frames` in turn; the last one repeats. */
function framesInTurn(...frames: string[]): void {
  vi.mocked(capturePane).mockImplementation((async () => frames[Math.min(captures++, frames.length - 1)]) as never);
}

/** Each capture answers `next(call)` — a frame, or an Error to throw. */
function framesBy(next: (call: number) => string | Error): void {
  vi.mocked(capturePane).mockImplementation((async () => {
    const frame = next(captures++);
    if (frame instanceof Error) throw frame;
    return frame;
  }) as never);
}

/**
 * Each capture answers the frame for the time it is made (ms since now) — the
 * shared sender's re-reads under the lock come faster than the wait's, so a
 * sequence by call would not be a sequence in time.
 */
function framesByTime(at: (elapsedMs: number) => string): void {
  const startedAt = Date.now();
  vi.mocked(capturePane).mockImplementation((async () => {
    captures++;
    return at(Date.now() - startedAt);
  }) as never);
}


function stubSession(tool: object): void {
  (tool as Record<string, unknown>).requireSession = vi.fn(async () => undefined);
}

/** Run `work` to completion under fake timers: what it threw, and when it settled (ms from start). */
async function settle(work: Promise<void>): Promise<{ error: Error | undefined; elapsed: number }> {
  const startedAt = Date.now();
  let error: Error | undefined;
  let elapsed = -1;
  const done = work
    .catch((e: Error) => {
      error = e;
    })
    .finally(() => {
      elapsed = Date.now() - startedAt;
    });
  await vi.runAllTimersAsync();
  await done;
  return { error, elapsed };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetInstanceInputLocks();
  keys = [];
  captures = 0;
  vi.mocked(sendKeys).mockImplementation((async (_s: string, text: string) => {
    keys.push(`type:${text}`);
  }) as never);
  vi.mocked(sendSpecialKeys).mockImplementation((async (_s: string, k: string[]) => {
    keys.push(k.join('+'));
  }) as never);
});

afterEach(() => {
  vi.useRealTimers();
  resetInstanceInputLocks();
});

describe('the frames (Issue #4084)', () => {
  it('control: the dialogs are dialogs to the detector, with no input prompt; the Working frames are not', () => {
    expect(detectSessionStatus(VL_DIALOG, 'vibe-local').hasActivePrompt).toBe(true);
    expect(isVibeLocalComposerReady(VL_DIALOG)).toBe(false);
    expect(detectSessionStatus(OC_ACTIVE_DIALOG, 'opencode').hasActivePrompt).toBe(true);
    expect(isOpenCodeComposerReady(OC_ACTIVE_DIALOG)).toBe(false);
    for (const frame of [OC.permission, OC.palette]) {
      expect(detectSessionStatus(frame, 'opencode')).toMatchObject({ status: 'waiting', hasActivePrompt: false });
      expect(isOpenCodeComposerReady(frame)).toBe(false);
    }
    expect(detectSessionStatus(VL.loading, 'vibe-local')).toMatchObject({ status: 'running', hasActivePrompt: false });
    expect(detectSessionStatus(OC.loading, 'opencode')).toMatchObject({ status: 'running', hasActivePrompt: false });
  });

  it('control: copilot, opencode and vibe-local share one confirmation time', () => {
    expect(COPILOT_DIALOG_CONFIRM_MS).toBe(PROMPT_WAIT_DIALOG_CONFIRM_MS);
    expect(PROMPT_WAIT_DIALOG_CONFIRM_MS).toBe(2000);
    expect(PROMPT_WAIT_DIALOG_CONFIRM_READS).toBe(2);
  });
});

describe('createDialogConfirmation (Issue #4084)', () => {
  it('negative: one read never confirms, however late it comes', () => {
    expect(createDialogConfirmation().observe(true, 60_000)).toBe(false);
  });

  it('negative: two reads under 2000 ms do not confirm; positive: the read at 2000 ms does', () => {
    const run = createDialogConfirmation();
    expect(run.observe(true, 0)).toBe(false);
    expect(run.observe(true, 1999)).toBe(false);
    expect(run.observe(true, 2000)).toBe(true);
    expect(run.reads).toBe(3);
  });

  it('positive: exactly two reads 2000 ms apart confirm', () => {
    const run = createDialogConfirmation();
    expect(run.observe(true, 100)).toBe(false);
    expect(run.observe(true, 2100)).toBe(true);
  });

  it('negative: a normal frame in between starts the run again', () => {
    const run = createDialogConfirmation();
    run.observe(true, 0);
    run.observe(true, 1500);
    expect(run.observe(false, 1800)).toBe(false);
    expect(run.reads).toBe(0);
    expect(run.observe(true, 2000)).toBe(false);
    expect(run.observe(true, 3999)).toBe(false);
    expect(run.observe(true, 4000)).toBe(true);
  });

  it('negative: a failed capture (reset) starts the run again', () => {
    const run = createDialogConfirmation();
    run.observe(true, 0);
    run.reset();
    expect(run.observe(true, 2500)).toBe(false);
    expect(run.observe(true, 4500)).toBe(true);
  });
});

describe('readBeforeDeadline (Issue #4084)', () => {
  it('returns the read when it answers in time, null when the deadline comes first', async () => {
    const quick = readBeforeDeadline(async () => 'frame', Date.now() + 1000);
    await vi.runAllTimersAsync();
    expect(await quick).toBe('frame');

    let late = false;
    const slow = readBeforeDeadline(
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => {
            late = true;
            resolve('late frame');
          }, 4500)
        ),
      Date.now() + 1000
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await slow).toBeNull();
    expect(late).toBe(false);
    await vi.runAllTimersAsync();
  });

  it('a past deadline does not start the read', async () => {
    const read = vi.fn(async () => 'frame');
    expect(await readBeforeDeadline(read, Date.now())).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('a read that throws in time rethrows; one that throws after the deadline is swallowed', async () => {
    await expect(readBeforeDeadline(async () => Promise.reject(new Error('boom')), Date.now() + 1000)).rejects.toThrow('boom');
    const late = readBeforeDeadline(
      () => new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error('late boom')), 4500)),
      Date.now() + 1000
    );
    await vi.runAllTimersAsync();
    expect(await late).toBeNull();
  });

  it('positive: a read that answers past the deadline before its timer has run is not used (Codex review, P2)', async () => {
    // The capture's completion is handled first; the clock is already past the
    // deadline, but the deadline's timer has not fired (setSystemTime runs no timer).
    const late = readBeforeDeadline(async () => {
      vi.setSystemTime(Date.now() + 1_500);
      return 'late frame';
    }, Date.now() + 1000);
    expect(await late).toBeNull();
    const lateFailure = readBeforeDeadline(async () => {
      vi.setSystemTime(Date.now() + 1_500);
      throw new Error('late boom');
    }, Date.now() + 1000);
    expect(await lateFailure).toBeNull();
  });

  it('control: a read that answers by the deadline is still used', async () => {
    const onTime = readBeforeDeadline(async () => {
      vi.setSystemTime(Date.now() + 1000);
      return 'frame';
    }, Date.now() + 1000);
    expect(await onTime).toBe('frame');
  });
});

/**
 * A capture that, from `fromMs` on, moves the clock `jumpMs` while it answers
 * `late` at once — so its completion is handled before any timer due in that
 * jump, the deadline's among them. Earlier captures answer `before`.
 */
function clockJumpsDuringCapture(before: string, late: string, fromMs: number, jumpMs: number): void {
  const startedAt = Date.now();
  vi.mocked(capturePane).mockImplementation((async () => {
    captures++;
    if (Date.now() - startedAt < fromMs) return before;
    vi.setSystemTime(Date.now() + jumpMs);
    return late;
  }) as never);
}

/**
 * The cases both tools answer alike. `dialog` is a frame the tool counts,
 * `refusal` what its confirmed refusal classifies as.
 */
interface ToolCase {
  name: string;
  make: () => { sendMessage: (wt: string, msg: string) => Promise<void> };
  ready: string;
  loading: string;
  working: string;
  dialogs: Array<{ label: string; frame: string; refusal: 'prompt-waiting' | 'prompt-not-ready' }>;
  typed: string[];
}

const CASES: ToolCase[] = [
  {
    name: 'vibe-local',
    make: () => {
      const tool = new VibeLocalTool();
      stubSession(tool);
      return tool;
    },
    ready: VL.ready,
    loading: VL.loading,
    working: VL.generating,
    dialogs: [{ label: 'a y/n dialog (active prompt)', frame: VL_DIALOG, refusal: 'prompt-waiting' }],
    typed: ['type:hello', 'Enter', 'Enter'],
  },
  {
    name: 'opencode',
    make: () => {
      const tool = new OpenCodeTool();
      stubSession(tool);
      (tool as unknown as Record<string, unknown>).dispatchViaServer = vi.fn(async () => 'skipped');
      return tool;
    },
    ready: OC.ready,
    loading: OC.loading,
    working: OC.running,
    dialogs: [
      { label: 'the permission strip (waiting, no active prompt)', frame: OC.permission, refusal: 'prompt-not-ready' },
      { label: 'the command palette (waiting, no active prompt)', frame: OC.palette, refusal: 'prompt-not-ready' },
      { label: 'a y/n dialog (active prompt)', frame: OC_ACTIVE_DIALOG, refusal: 'prompt-waiting' },
    ],
    typed: ['type:hello', 'Enter'],
  },
];

describe.each(CASES)('$name: the prompt wait confirms a dialog (Issue #4084)', (c) => {
  describe.each(c.dialogs)('$label', (d) => {
    it('positive: read once, then a screen still loading for 3 s, then the prompt — typed once (used to be refused)', async () => {
      framesByTime((t) => (t === 0 ? d.frame : t < 3_500 ? c.loading : c.ready));
      const { error } = await settle(c.make().sendMessage('wt-1', 'hello'));
      expect(error).toBeUndefined();
      expect(keys).toEqual(c.typed);
    });

    it(`positive: up for good — refused as ${d.refusal} after the confirmation time, not before; no capture after it`, async () => {
      framesInTurn(d.frame);
      const { error, elapsed } = await settle(c.make().sendMessage('wt-1', 'hello'));
      expect(keys).toEqual([]);
      expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: d.refusal });
      if (d.refusal === 'prompt-waiting') {
        expect((error as { cause?: { code?: unknown } }).cause?.code).toBe(INPUT_RECHECK_PROMPT_WAITING_CODE);
      }
      expect(elapsed).toBe(PROMPT_WAIT_DIALOG_CONFIRM_MS);
      expect(captures).toBe(CONFIRMING_READS);
    });

    it('positive: up for 1.5 s (four reads), then loading for 2.5 s, then the prompt — not confirmed, typed once', async () => {
      framesByTime((t) => (t <= 1_500 ? d.frame : t < 4_500 ? c.loading : c.ready));
      const { error } = await settle(c.make().sendMessage('wt-1', 'hello'));
      expect(error).toBeUndefined();
      expect(keys).toEqual(c.typed);
    });

    it('positive: runs of 1.5 s cut by a normal frame — never confirmed, prompt-not-ready at the 15 s window', async () => {
      framesBy((call) => (call % 5 === 4 ? c.loading : d.frame));
      const { error, elapsed } = await settle(c.make().sendMessage('wt-1', 'hello'));
      expect(keys).toEqual([]);
      expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
      expect(error!.message).toMatch(/prompt not ready: timed out/);
      expect(elapsed).toBe(WINDOW_MS);
    });

    it('positive: runs of 1.5 s cut by a failed capture — never confirmed, prompt-not-ready at the 15 s window', async () => {
      framesBy((call) => (call % 5 === 4 ? new Error('capture failed') : d.frame));
      const { error, elapsed } = await settle(c.make().sendMessage('wt-1', 'hello'));
      expect(keys).toEqual([]);
      expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
      expect(elapsed).toBe(WINDOW_MS);
    });

    it('positive: every capture after the confirming reads takes 4.5 s — refused at the confirmation time, none of them made', async () => {
      framesBy((call) => {
        if (call >= CONFIRMING_READS) throw new Error('a capture after the confirmation');
        return d.frame;
      });
      const slow = vi.mocked(capturePane).getMockImplementation()!;
      vi.mocked(capturePane).mockImplementation((async (...args: unknown[]) => {
        if (captures >= CONFIRMING_READS) await new Promise((resolve) => setTimeout(resolve, 4_500));
        return (slow as (...a: unknown[]) => Promise<string>)(...args);
      }) as never);
      const { error, elapsed } = await settle(c.make().sendMessage('wt-1', 'hello'));
      expect(keys).toEqual([]);
      expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: d.refusal });
      expect(captures).toBe(CONFIRMING_READS);
      expect(elapsed).toBe(PROMPT_WAIT_DIALOG_CONFIRM_MS);
    });

    it('positive: every capture takes 4.5 s — confirmed on the second read, within the 15 s window, nothing read after', async () => {
      framesBy(() => d.frame);
      const inner = vi.mocked(capturePane).getMockImplementation()!;
      vi.mocked(capturePane).mockImplementation((async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 4_500));
        return (inner as (...a: unknown[]) => Promise<string>)(...args);
      }) as never);
      const { error, elapsed } = await settle(c.make().sendMessage('wt-1', 'hello'));
      expect(keys).toEqual([]);
      expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: d.refusal });
      // Reads return at 4.5 s and 9.5 s: two reads, 5 s apart.
      expect(captures).toBe(2);
      expect(elapsed).toBe(9_500);
      expect(elapsed).toBeLessThanOrEqual(WINDOW_MS);
    });
  });

  it('negative: a Working screen is not counted — typed as before', async () => {
    framesInTurn(c.working);
    const { error } = await settle(c.make().sendMessage('wt-1', 'hello'));
    expect(error).toBeUndefined();
    expect(keys).toEqual(c.typed);
  });

  it('negative: a loading screen is not counted — prompt-not-ready at the 15 s window, not before', async () => {
    framesInTurn(c.loading);
    const { error, elapsed } = await settle(c.make().sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(elapsed).toBe(WINDOW_MS);
  });

  it('positive: a capture still running at the deadline is not waited for, and its late prompt is not typed into', async () => {
    let call = 0;
    vi.mocked(capturePane).mockImplementation((async () => {
      call++;
      // Loading until 14.5 s; the read started then takes 4.5 s and answers a ready prompt.
      if (Date.now() < 14_500 + startedAt) return c.loading;
      await new Promise((resolve) => setTimeout(resolve, 4_500));
      return c.ready;
    }) as never);
    const startedAt = Date.now();
    const { error, elapsed } = await settle(c.make().sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(elapsed).toBe(WINDOW_MS);
    expect(call).toBe(30);
  });

  it('positive: a ready frame that answers past the deadline before its timer runs is not typed into (Codex review, P2)', async () => {
    clockJumpsDuringCapture(c.loading, c.ready, 14_500, 1_000);
    const { error } = await settle(c.make().sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
  });

  it('control: the same ready frame answering by the deadline is typed into', async () => {
    clockJumpsDuringCapture(c.loading, c.ready, 14_500, 500);
    const { error } = await settle(c.make().sendMessage('wt-1', 'hello'));
    expect(error).toBeUndefined();
    expect(keys).toEqual(c.typed);
  });

  it('negative (out of scope, unchanged): ready before the lock, a dialog under it — refused on one read', async () => {
    framesInTurn(c.ready, c.dialogs.find((d) => d.refusal === 'prompt-waiting')!.frame);
    const { error, elapsed } = await settle(c.make().sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-waiting' });
    expect(captures).toBe(2);
    expect(elapsed).toBe(0);
  });
});

describe('opencode: an earlier unknown dispatch (Issue #4084)', () => {
  let tool: OpenCodeTool;

  beforeEach(() => {
    tool = new OpenCodeTool();
    stubSession(tool);
    (tool as unknown as Record<string, unknown>).dispatchViaServer = vi.fn(async () => 'unknown');
  });

  it.each([
    ['the permission strip confirmed', OC.permission],
    ['an active-prompt dialog confirmed', OC_ACTIVE_DIALOG],
    ['no box for the whole window', OC.loading],
  ])('positive: the POST ended unknown, then %s — the send stays indeterminate, nothing typed', async (_name, frame) => {
    framesInTurn(frame);
    const { error } = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error).state).toBe('indeterminate');
  });

  it('positive: an image dispatch unknown, the fallback refused on a confirmed dialog — indeterminate', async () => {
    (tool as unknown as Record<string, unknown>).dispatchViaServer = vi
      .fn()
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce('not_sent');
    framesInTurn(OC_ACTIVE_DIALOG);
    const { error } = await settle(tool.sendMessageWithImage('wt-1', 'look', '/tmp/x.png'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error).state).toBe('indeterminate');
  });
});

describe('copilot: the prompt wait\'s deadline (Issue #4084, Codex review)', () => {
  let tool: CopilotTool;

  beforeEach(() => {
    tool = new CopilotTool();
    stubSession(tool);
  });

  it('positive: a capture still running at the deadline is not waited for, and its late prompt is not typed into', async () => {
    const startedAt = Date.now();
    let slowRead = false;
    vi.mocked(capturePane).mockImplementation((async () => {
      captures++;
      // Loading until 14.5 s; the read started then takes 4.5 s and answers the
      // composer. Reads after it (the refusal's own re-read for a dialog) answer at once.
      if (Date.now() < startedAt + 14_500 || slowRead) return COPILOT.BOOT_LOADING();
      slowRead = true;
      await new Promise((resolve) => setTimeout(resolve, 4_500));
      return COPILOT.BOOT_IDLE();
    }) as never);
    const { error, elapsed } = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
    expect(elapsed).toBe(WINDOW_MS);
  });

  it('positive: a composer frame that answers past the deadline before its timer runs is not typed into', async () => {
    clockJumpsDuringCapture(COPILOT.BOOT_LOADING(), COPILOT.BOOT_IDLE(), 14_500, 1_000);
    const { error } = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(keys).toEqual([]);
    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'prompt-not-ready' });
  });

  it('control: the same composer frame answering by the deadline is typed into', async () => {
    clockJumpsDuringCapture(COPILOT.BOOT_LOADING(), COPILOT.BOOT_IDLE(), 14_500, 500);
    const { error } = await settle(tool.sendMessage('wt-1', 'hello'));
    expect(error).toBeUndefined();
    expect(keys).toEqual(['type:hello', 'Enter']);
  });
});
