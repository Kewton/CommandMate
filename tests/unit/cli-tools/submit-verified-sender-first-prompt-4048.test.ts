/**
 * Issue #4048: what #4035's wait for claude's `UserPromptSubmit` left open.
 *
 *   1. A first send whose only hook was `SessionStart` (the http
 *      `UserPromptSubmit` never arriving): one last read of the screen before
 *      `prompt-unreported`, A saves it, nothing else presses Enter; the failure
 *      says the body may have gone.
 *   2. The session replaced while the send waits after its Enter: indeterminate
 *      (never `not-sent`), and the new generation's screen, hooks and entry are
 *      not this send's.
 *   4. A body found in the composer demotes only claude's record, and only the
 *      record of the attempt whose body it is.
 *   5. An explicit target looks at the same entry as the session name, or none.
 *
 * Frames are the live captures of #4035 (`tests/fixtures/claude-first-send-4035/`)
 * and of #3366 (`tests/fixtures/codex-send-burst-3366/`).
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

import {
  PROMPT_REPORT_POLL_MS,
  PROMPT_REPORT_WAIT_MS,
  PROMPT_UNREPORTED_RESEND_NOTE,
  clearComposerBeforeSend,
  promptUnreportedResendNote,
  sendMessageWithSubmitVerification,
} from '@/lib/cli-tools/submit-verified-sender';
import { capturePane, sendKeys, sendSpecialKeys, clearComposerLine } from '@/lib/tmux/tmux';
import {
  clearPromptSubmitReceipts,
  getPromptSubmitTarget,
  matchesSubmittedBody,
  notePromptSubmitHook,
  notePromptSubmitSession,
  noteSubmittedBody,
  readPromptSubmitReceipt,
  type PromptSubmitExpected,
} from '@/lib/session/prompt-submit-receipt';
import {
  classifySendFailure,
  clearSendAttempts,
  getLastSendAttempt,
  recordSendAttempt,
} from '@/lib/session/send-attempt-state';
import { invalidateInstanceInput } from '@/lib/session/instance-input-lock';

const FIXTURES = path.resolve(__dirname, '../../fixtures/claude-first-send-4035');
const frame = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

const STARTING = frame('starting-no-composer.ansi');
const PLACEHOLDER = frame('placeholder-after-enter.ansi');
const LATE_BODY = frame('late-body.ansi');
const GENERATING = frame('generating.ansi');
const IDLE = frame('idle-after-reply.ansi');

const CODEX_FIXTURES = path.resolve(__dirname, '../../fixtures/codex-send-burst-3366');
const codexFrame = (name: string): string => readFileSync(path.join(CODEX_FIXTURES, `${name}.capture`), 'utf8');
/** The codex composer holding BODY_5, and an emptied one. */
const CODEX_STUCK = codexFrame('stuck-after-enter-in-burst');
const CODEX_EMPTIED = codexFrame('typed-in-burst');
const CODEX_BODY = "Run the shell command 'sleep 15 && ls', then reply with the single word WORD5.";

const INIT_MESSAGE =
  'セッションの起動とモデルの確認です（作業の依頼ではありません）。まだ何も実行せず、ファイルにも触らず、「OK」とだけ返してください。依頼は次のメッセージで送ります。';
const CONTRACT = '契約です。何も実行せず「了解」とだけ返してください。';

const SESSION = 'mcbd-claude-p4048';
const TARGET = { worktreeId: 'p4048', cliToolId: 'claude' as const };
const INSTANCE = { worktreeId: 'p4048', cliToolId: 'claude', instanceId: 'claude' };

/** Reads in the wait before its deadline (one per poll). */
const WAIT_READS = PROMPT_REPORT_WAIT_MS / PROMPT_REPORT_POLL_MS;

/** Started here, and only `SessionStart` arrived: hooks are live, the http prompt hook is not. */
function startSession(at = Date.now() - 2000): void {
  notePromptSubmitSession(SESSION, TARGET, at);
  notePromptSubmitHook(TARGET, 'session_start', at + 1000);
}

function reportPrompt(): void {
  notePromptSubmitHook(TARGET, 'user_prompt_submit', Date.now());
}

/** As in the #4035 tests: `beforeEnter` until the first Enter, then `afterEnters[enters - 1][read]`. */
function script(
  beforeEnter: string,
  afterEnters: Array<Array<string | (() => string | Promise<string>)>>,
  onRead?: (enters: number, read: number) => void
): { enters: () => number; reads: () => number } {
  let enters = 0;
  let read = 0;
  vi.mocked(sendSpecialKeys).mockImplementation(async (_name: string, keys: string[]) => {
    if (keys.includes('Enter')) {
      enters++;
      read = 0;
    }
  });
  vi.mocked(capturePane).mockImplementation(async () => {
    if (enters === 0) return beforeEnter;
    const frames = afterEnters[Math.min(enters, afterEnters.length) - 1];
    const out = frames[Math.min(read, frames.length - 1)];
    onRead?.(enters, read);
    read++;
    return typeof out === 'function' ? await out() : out;
  });
  return { enters: () => enters, reads: () => read };
}

async function run(message: string, target?: PromptSubmitExpected): Promise<Error | null> {
  const sending = sendMessageWithSubmitVerification({
    sessionName: SESSION,
    message,
    cliToolId: 'claude',
    textInputWaitMs: 1,
    verifyDelayMs: 200,
    ...(target !== undefined ? { target } : {}),
  }).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
  );
  await vi.advanceTimersByTimeAsync(PROMPT_REPORT_WAIT_MS * 8);
  return sending;
}

/** The frames after the first Enter: the read-back, the wait's reads, then the last read. */
function waitThen(last: string | (() => string | Promise<string>)): Array<string | (() => string | Promise<string>)> {
  return [...Array<string>(1 + WAIT_READS).fill(PLACEHOLDER), last];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearPromptSubmitReceipts();
  clearSendAttempts();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('[#4048 1] the last read before prompt-unreported', () => {
  it('positive: only SessionStart arrived, the wait saw F, the last read sees A — sent, one Enter', async () => {
    startSession();
    const sent = script(PLACEHOLDER, [waitThen(GENERATING)]);

    expect(await run(INIT_MESSAGE)).toBeNull();
    expect(sent.enters()).toBe(1);
    expect(loggerSpies.info).toHaveBeenCalledWith(
      'prompt-unreported-reread',
      expect.objectContaining({ sessionName: SESSION, state: 'submitted', rule: 'A' })
    );
    expect(loggerSpies.error).not.toHaveBeenCalledWith('submit-not-confirmed:prompt-unreported', expect.anything());
  });

  it.each([
    ['F (the placeholder)', PLACEHOLDER],
    ['B (no composer)', STARTING],
    ['B (an empty composer)', IDLE],
    ['the body still in the composer (D)', LATE_BODY],
  ])('negative: the last read shows %s — prompt-unreported, no further Enter', async (_label, last) => {
    startSession();
    const sent = script(PLACEHOLDER, [waitThen(last)]);

    const error = await run(INIT_MESSAGE);

    expect(classifySendFailure(error)).toEqual({ state: 'indeterminate', reason: 'prompt-unreported' });
    expect(sent.enters()).toBe(1);
  });

  it('negative: the last read fails — prompt-unreported (not the capture error), no further Enter', async () => {
    startSession();
    const sent = script(PLACEHOLDER, [
      waitThen(() => {
        throw new Error('Command failed: tmux capture-pane');
      }),
    ]);

    const error = await run(INIT_MESSAGE);

    expect(classifySendFailure(error)).toEqual({ state: 'indeterminate', reason: 'prompt-unreported' });
    expect(sent.enters()).toBe(1);
    expect(loggerSpies.warn).toHaveBeenCalledWith('prompt-unreported-reread-failed', expect.anything());
  });

  it('the hook arriving while the last frame is read settles it as sent', async () => {
    startSession();
    const sent = script(PLACEHOLDER, [
      waitThen(() => {
        reportPrompt();
        return PLACEHOLDER;
      }),
    ]);

    expect(await run(INIT_MESSAGE)).toBeNull();
    expect(sent.enters()).toBe(1);
  });

  it('the failure says the body may have been submitted and to capture before resending', async () => {
    startSession();
    script(PLACEHOLDER, [[PLACEHOLDER]]);

    const error = await run(INIT_MESSAGE);

    expect(error?.message).toContain('did not report the prompt within 5000ms (Issue #4035).');
    expect(error?.message).toContain(PROMPT_UNREPORTED_RESEND_NOTE);
    expect(PROMPT_UNREPORTED_RESEND_NOTE).toMatch(/may already have been submitted/);
    expect(PROMPT_UNREPORTED_RESEND_NOTE).toMatch(/commandmate capture <worktree-id> --pane/);
  });
});

describe('[#4048 2] the session replaced after the Enter', () => {
  /**
   * The session is recreated under the send — a new generation of the same
   * name — by another request: run from a timer, outside the send's own
   * context (whose ticket `invalidateInstanceInput` would keep, as a relaunch's).
   */
  function replaceSession(then?: () => void): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        invalidateInstanceInput(SESSION);
        notePromptSubmitSession(SESSION, TARGET, Date.now());
        notePromptSubmitHook(TARGET, 'session_start', Date.now());
        then?.();
        resolve();
      }, 0);
    });
  }

  /** A read during which the session is replaced, returning `frame`. */
  const replacedWhileReading = (frame: string, then?: () => void) => async (): Promise<string> => {
    await replaceSession(then);
    return frame;
  };

  it('positive: replaced during the wait, the new process reporting a prompt — indeterminate, no further Enter', async () => {
    startSession();
    // Before the fix the new process's `UserPromptSubmit` (by name, after the
    // old Enter) was read as this send's: `sent`.
    const sent = script(PLACEHOLDER, [
      [PLACEHOLDER, PLACEHOLDER, PLACEHOLDER, replacedWhileReading(IDLE, reportPrompt), IDLE],
    ]);
    recordSendAttempt(INSTANCE, { state: 'sent', reason: 'submitted', content: 'the new generation' });
    const before = getLastSendAttempt(INSTANCE);

    const error = await run(INIT_MESSAGE);

    expect(error?.message).toMatch(/was replaced during the prompt report wait, after the message and Enter were sent/);
    expect(classifySendFailure(error).state).toBe('indeterminate');
    expect(classifySendFailure(error).reason).not.toBe('session-replaced');
    expect(sent.enters()).toBe(1);
    // The new generation's entry and record are untouched by the old send.
    expect(getPromptSubmitTarget(SESSION)).toMatchObject(TARGET);
    expect(matchesSubmittedBody(SESSION, INIT_MESSAGE)).toBe(false);
    expect(getLastSendAttempt(INSTANCE)).toEqual(before);
  });

  it('positive: replaced before the read-back — the new screen (A) is not this send\'s', async () => {
    startSession();
    const sent = script(PLACEHOLDER, [[replacedWhileReading(GENERATING), GENERATING]]);

    const error = await run(INIT_MESSAGE);

    expect(error?.message).toMatch(/was replaced during the read-back/);
    expect(classifySendFailure(error).state).toBe('indeterminate');
    expect(sent.enters()).toBe(1);
  });

  it('positive: replaced during the last read — indeterminate, and the old body is not noted on the new entry', async () => {
    startSession();
    const sent = script(PLACEHOLDER, [waitThen(replacedWhileReading(GENERATING))]);

    const error = await run(INIT_MESSAGE);

    expect(error?.message).toMatch(/was replaced during the last read before prompt-unreported/);
    expect(classifySendFailure(error).state).toBe('indeterminate');
    expect(sent.enters()).toBe(1);
    expect(matchesSubmittedBody(SESSION, INIT_MESSAGE)).toBe(false);
  });

  it('negative: replaced before the body — not-sent, no body and no Enter', async () => {
    startSession();
    // The pre-send clear's read: the session is recreated under it.
    vi.mocked(capturePane).mockImplementation(async () => {
      await replaceSession();
      return PLACEHOLDER;
    });

    const error = await run(INIT_MESSAGE);

    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'input-lock-lost' });
    expect(sendKeys).not.toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalledWith(SESSION, ['Enter']);
  });

  it('negative: not replaced — the same wait ends in prompt-unreported as before', async () => {
    startSession();
    script(PLACEHOLDER, [[PLACEHOLDER]]);

    expect(classifySendFailure(await run(INIT_MESSAGE))).toEqual({
      state: 'indeterminate',
      reason: 'prompt-unreported',
    });
  });
});

describe('[#4048 4] which record a body found in the composer demotes', () => {
  /** A first send reported `sent` from the placeholder (hooks not live). */
  async function sendWronglyReportedSent(message = INIT_MESSAGE): Promise<void> {
    notePromptSubmitSession(SESSION, TARGET, Date.now() - 2000);
    script(PLACEHOLDER, [[PLACEHOLDER]]);
    expect(await run(message)).toBeNull();
    recordSendAttempt(INSTANCE, { state: 'sent', reason: 'submitted', content: message });
    vi.clearAllMocks();
  }

  /** The next send's clear reads `composer` once, then an emptied claude composer. */
  async function nextClaudeSendFinds(composer: string): Promise<void> {
    let cleared = false;
    vi.mocked(clearComposerLine).mockImplementation(async () => {
      cleared = true;
    });
    vi.mocked(capturePane).mockImplementation(async () => (cleared ? PLACEHOLDER : composer));
    const clearing = clearComposerBeforeSend(SESSION, 'claude');
    await vi.advanceTimersByTimeAsync(5000);
    await clearing;
  }

  it('negative: claude, the body of the attempt on record — demoted as before', async () => {
    await sendWronglyReportedSent();
    await nextClaudeSendFinds(LATE_BODY);

    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'indeterminate', reason: 'found-in-composer' });
  });

  it('positive: claude, X found after Y was sent — Y is not demoted', async () => {
    await sendWronglyReportedSent();
    // Y went through after X (its own record), and X comes back to the composer.
    recordSendAttempt(INSTANCE, { state: 'sent', reason: 'submitted', content: CONTRACT });
    await nextClaudeSendFinds(LATE_BODY);

    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'sent', reason: 'submitted' });
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      'pre-send-found-submitted-body',
      expect.objectContaining({ sessionName: SESSION, lastSendDemoted: true })
    );
  });

  it('positive: claude, X\'s late hook arrived — X is forgotten, nothing is demoted', async () => {
    await sendWronglyReportedSent();
    reportPrompt();
    await nextClaudeSendFinds(LATE_BODY);

    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'sent', reason: 'submitted' });
    expect(loggerSpies.warn).not.toHaveBeenCalledWith('pre-send-found-submitted-body', expect.anything());
  });

  it('positive: codex — the body is found and warned about, but lastSend stays sent', async () => {
    const codexSession = 'mcbd-codex-p4048';
    const codexTarget = { worktreeId: 'p4048', cliToolId: 'codex' as const };
    const codexInstance = { worktreeId: 'p4048', cliToolId: 'codex', instanceId: 'codex' };
    notePromptSubmitSession(codexSession, codexTarget, Date.now() - 2000);
    noteSubmittedBody(codexSession, CODEX_BODY);
    recordSendAttempt(codexInstance, { state: 'sent', reason: 'submitted', content: CODEX_BODY });
    let cleared = false;
    vi.mocked(clearComposerLine).mockImplementation(async () => {
      cleared = true;
    });
    vi.mocked(capturePane).mockImplementation(async () => (cleared ? CODEX_EMPTIED : CODEX_STUCK));

    const clearing = clearComposerBeforeSend(codexSession, 'codex');
    await vi.advanceTimersByTimeAsync(5000);
    await clearing;

    expect(loggerSpies.warn).toHaveBeenCalledWith(
      'pre-send-found-submitted-body',
      expect.objectContaining({ sessionName: codexSession, cliToolId: 'codex', lastSendDemoted: false })
    );
    expect(getLastSendAttempt(codexInstance)).toMatchObject({ state: 'sent', reason: 'submitted' });
  });
});

describe('[#4048 5] an explicit target', () => {
  const OTHER = { worktreeId: 'p4048', cliToolId: 'claude' as const, instanceId: 'claude-2' };

  it('negative: the primary named explicitly is the same entry as the name alone', async () => {
    startSession();
    script(PLACEHOLDER, [[PLACEHOLDER]]);
    const byName = classifySendFailure(await run(INIT_MESSAGE));
    clearPromptSubmitReceipts();
    vi.clearAllMocks();
    startSession();
    script(PLACEHOLDER, [[PLACEHOLDER]]);
    const omitted = classifySendFailure(await run(INIT_MESSAGE, { worktreeId: 'p4048' }));
    clearPromptSubmitReceipts();
    vi.clearAllMocks();
    startSession();
    script(PLACEHOLDER, [[PLACEHOLDER]]);
    const explicit = classifySendFailure(await run(INIT_MESSAGE, { worktreeId: 'p4048', instanceId: 'claude' }));

    expect(byName).toEqual({ state: 'indeterminate', reason: 'prompt-unreported' });
    expect(omitted).toEqual(byName);
    expect(explicit).toEqual(byName);
  });

  it('positive: a target the name does not resolve to is no proof — another instance\'s prompt hook is not "received"', () => {
    // The name's entry is claude-2's, and claude-2 reported a prompt.
    notePromptSubmitSession(SESSION, OTHER, 1_000);
    notePromptSubmitHook(OTHER, 'user_prompt_submit', 2_500);

    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000)).toBe('received');
    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000, { worktreeId: 'p4048' })).toBe('not-required');
    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000, { worktreeId: 'other-wt', instanceId: 'claude-2' })).toBe(
      'not-required'
    );
    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000, { worktreeId: 'p4048', instanceId: 'claude-2' })).toBe(
      'received'
    );
  });

  it('positive: a mismatched target notes no body', async () => {
    notePromptSubmitSession(SESSION, OTHER, Date.now() - 2000);
    script(PLACEHOLDER, [[PLACEHOLDER]]);

    expect(await run(INIT_MESSAGE, { worktreeId: 'p4048' })).toBeNull();
    expect(matchesSubmittedBody(SESSION, INIT_MESSAGE)).toBe(false);
  });

  it('negative: a send with a target registers nothing for a session this server did not start', async () => {
    script(PLACEHOLDER, [[PLACEHOLDER]]);

    expect(await run(INIT_MESSAGE, { worktreeId: 'p4048' })).toBeNull();
    expect(getPromptSubmitTarget(SESSION)).toBeNull();
  });

  it('negative: a send with a target does not reset the entry (the first prompt already reported stays reported)', async () => {
    startSession();
    notePromptSubmitHook(TARGET, 'user_prompt_submit', Date.now() - 500);
    script(PLACEHOLDER, [[IDLE]]);

    expect(await run(CONTRACT, { worktreeId: 'p4048' })).toBeNull();
    expect(readPromptSubmitReceipt(SESSION, 'claude', Date.now() + 1, { worktreeId: 'p4048' })).toBe('not-required');
  });
});

describe('[#4048 review P1] the hook check after the wait returned C/D confirms nothing for a replaced session', () => {
  /**
   * The wait sees the body back in the composer (D) and returns it; before the
   * caller's own hook check the session is recreated and the new process
   * reports its prompt. The replacement is made to land in that gap through
   * the `submit-classified` log the caller writes for the wait's verdict,
   * outside the send's own context (whose ticket a relaunch would keep).
   */
  function replaceOnWaitVerdict(): void {
    let classified = 0;
    loggerSpies.info.mockImplementation((event: string) => {
      if (event !== 'submit-classified') return;
      classified++;
      if (classified !== 2) return;
      const scope = (globalThis as { __instanceInputOwnerScope?: { exit(fn: () => void): void } })
        .__instanceInputOwnerScope;
      if (scope === undefined) throw new Error('the input lock\'s owner scope is not on globalThis');
      scope.exit(() => invalidateInstanceInput(SESSION));
      notePromptSubmitSession(SESSION, TARGET, Date.now());
      notePromptSubmitHook(TARGET, 'session_start', Date.now());
      reportPrompt();
    });
  }

  afterEach(() => {
    loggerSpies.info.mockReset();
  });

  it('positive: replaced after the wait, the new process reporting a prompt — indeterminate, not sent, no further Enter', async () => {
    startSession();
    replaceOnWaitVerdict();
    const sent = script(PLACEHOLDER, [[PLACEHOLDER, LATE_BODY, LATE_BODY]]);

    const error = await run(INIT_MESSAGE);

    expect(error?.message).toMatch(/was replaced during the prompt report check, after the message and Enter were sent/);
    expect(classifySendFailure(error).state).toBe('indeterminate');
    expect(sent.enters()).toBe(1);
    expect(loggerSpies.info).not.toHaveBeenCalledWith('submit-confirmed-by-prompt-hook', expect.anything());
  });

  it('negative: not replaced, the late hook arriving there still confirms it (as #4035)', async () => {
    startSession();
    let classified = 0;
    loggerSpies.info.mockImplementation((event: string) => {
      if (event === 'submit-classified' && ++classified === 2) reportPrompt();
    });
    const sent = script(PLACEHOLDER, [[PLACEHOLDER, LATE_BODY, LATE_BODY]]);

    expect(await run(INIT_MESSAGE)).toBeNull();
    expect(sent.enters()).toBe(1);
    expect(loggerSpies.info).toHaveBeenCalledWith('submit-confirmed-by-prompt-hook', expect.anything());
  });
});

describe('[#4048 review P2] the resend note names the pane the body went to', () => {
  it('positive: an explicit instance — the capture names it, as the CLI\'s own hint does', async () => {
    startSession();
    script(PLACEHOLDER, [[PLACEHOLDER]]);

    const error = await run(INIT_MESSAGE, { worktreeId: 'p4048', instanceId: 'claude' });

    expect(classifySendFailure(error)).toEqual({ state: 'indeterminate', reason: 'prompt-unreported' });
    expect(error?.message).toContain('`commandmate capture p4048 --instance claude --pane`');
    expect(error?.message).not.toContain('<worktree-id>');
  });

  it('positive: another instance is named by its own id', () => {
    expect(promptUnreportedResendNote({ worktreeId: 'wt', instanceId: 'claude-2' })).toContain(
      '`commandmate capture wt --instance claude-2 --pane`'
    );
  });

  it('negative: a target without an instance names the worktree only; no target keeps the placeholder', () => {
    // Without the tool there is nothing to name; the sender always passes it.
    expect(promptUnreportedResendNote({ worktreeId: 'wt' })).toContain('`commandmate capture wt --pane`');
    expect(promptUnreportedResendNote()).toBe(PROMPT_UNREPORTED_RESEND_NOTE);
  });

  it('positive: the primary sent to without an instance — the capture names the tool (`--agent`), not the worktree default', async () => {
    startSession();
    script(PLACEHOLDER, [[PLACEHOLDER]]);

    const error = await run(INIT_MESSAGE, { worktreeId: 'p4048' });

    expect(classifySendFailure(error)).toEqual({ state: 'indeterminate', reason: 'prompt-unreported' });
    expect(error?.message).toContain('`commandmate capture p4048 --agent claude --pane`');
    expect(promptUnreportedResendNote({ worktreeId: 'wt' }, 'claude')).toContain('`commandmate capture wt --agent claude --pane`');
    // A named instance still wins, as in the CLI's own hint.
    expect(promptUnreportedResendNote({ worktreeId: 'wt', instanceId: 'claude-2' }, 'claude')).toContain(
      '`commandmate capture wt --instance claude-2 --pane`'
    );
  });
});
