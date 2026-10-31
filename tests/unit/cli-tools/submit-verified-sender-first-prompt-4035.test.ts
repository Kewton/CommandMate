/**
 * Issue #4035: a claude session's first prompt, reported `sent` from a screen
 * that only said "the body is not in the composer".
 *
 * Frames are live captures from Claude Code 2.1.314
 * (`tests/fixtures/claude-first-send-4035/`): the read-back after the Enter of
 * an unsent first send showed the dim `Try "…"` placeholder (rule F), and the
 * body was drawn into the composer ~1 s later, where the next send cleared it.
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
  PROMPT_REPORT_WAIT_MS,
  classifySubmitWithRule,
  sendMessageWithSubmitVerification,
} from '@/lib/cli-tools/submit-verified-sender';
import { capturePane, sendSpecialKeys, clearComposerLine } from '@/lib/tmux/tmux';
import {
  clearPromptSubmitReceipts,
  notePromptSubmitHook,
  notePromptSubmitSession,
  readPromptSubmitReceipt,
} from '@/lib/session/prompt-submit-receipt';
import {
  classifySendFailure,
  clearSendAttempts,
  getLastSendAttempt,
  recordSendAttempt,
} from '@/lib/session/send-attempt-state';

const FIXTURES = path.resolve(__dirname, '../../fixtures/claude-first-send-4035');
const frame = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

const STARTING = frame('starting-no-composer.ansi');
const PLACEHOLDER = frame('placeholder-after-enter.ansi');
const LATE_BODY = frame('late-body.ansi');
const GENERATING = frame('generating.ansi');
const IDLE = frame('idle-after-reply.ansi');

/** launch-worker's `INIT_MESSAGE`, the body every unsent first send was. */
const INIT_MESSAGE =
  'セッションの起動とモデルの確認です（作業の依頼ではありません）。まだ何も実行せず、ファイルにも触らず、「OK」とだけ返してください。依頼は次のメッセージで送ります。';
const CONTRACT = '契約です。何も実行せず「了解」とだけ返してください。';

const SESSION = 'mcbd-claude-p4035';
const TARGET = { worktreeId: 'p4035', cliToolId: 'claude' as const };
const INSTANCE = { worktreeId: 'p4035', cliToolId: 'claude', instanceId: 'claude' };

/** The session was started here and its `SessionStart` hook arrived: hooks are live. */
function startSession(hooksLive = true): void {
  notePromptSubmitSession(SESSION, TARGET, Date.now() - 2000);
  if (hooksLive) notePromptSubmitHook(TARGET, 'session_start', Date.now() - 1000);
}

function reportPrompt(): void {
  notePromptSubmitHook(TARGET, 'user_prompt_submit', Date.now());
}

/**
 * Serve `beforeEnter` until the first Enter, then the n-th frame of
 * `afterEnters[enters - 1]` on its n-th read (the last one repeating). `onRead`
 * runs on every read after an Enter, with the Enter count and the read index.
 */
function script(
  beforeEnter: string,
  afterEnters: string[][],
  onRead?: (enters: number, read: number) => void
): { enters: () => number } {
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
    return out;
  });
  return { enters: () => enters };
}

/** Run a send to completion under fake timers; resolves to its error, or null. */
async function run(message: string): Promise<Error | null> {
  const sending = sendMessageWithSubmitVerification({
    sessionName: SESSION,
    message,
    cliToolId: 'claude',
    textInputWaitMs: 1,
    verifyDelayMs: 200,
  }).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
  );
  await vi.advanceTimersByTimeAsync(PROMPT_REPORT_WAIT_MS * 8);
  return sending;
}

function infoCalls(action: string): Array<Record<string, unknown>> {
  return loggerSpies.info.mock.calls.filter(([a]) => a === action).map(([, data]) => data as Record<string, unknown>);
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

describe('[#4035] the live frames read as the issue says', () => {
  it('classifies each fixture by the rule that decided it', () => {
    expect(classifySubmitWithRule(STARTING, 'claude', INIT_MESSAGE)).toEqual({ state: 'submitted', rule: 'B-absent' });
    expect(classifySubmitWithRule(PLACEHOLDER, 'claude', INIT_MESSAGE)).toEqual({ state: 'submitted', rule: 'F' });
    expect(classifySubmitWithRule(LATE_BODY, 'claude', INIT_MESSAGE)).toEqual({ state: 'pending', rule: 'D' });
    expect(classifySubmitWithRule(GENERATING, 'claude', INIT_MESSAGE)).toEqual({ state: 'submitted', rule: 'A' });
    expect(classifySubmitWithRule(IDLE, 'claude', INIT_MESSAGE)).toEqual({ state: 'submitted', rule: 'B-empty' });
  });
});

describe('[#4035] a first prompt the agent never reported is not `sent` (positive)', () => {
  it.each([
    ['F (the dim placeholder)', PLACEHOLDER, 'F'],
    ['B (no composer on screen)', STARTING, 'B-absent'],
    ['B (an empty composer)', IDLE, 'B-empty'],
  ])('throws prompt-unreported when the read-back stays %s and no hook comes', async (_label, after, rule) => {
    startSession();
    const sent = script(PLACEHOLDER, [[after]]);

    const error = await run(INIT_MESSAGE);

    expect(error).not.toBeNull();
    expect(error?.message).toContain(`rule ${rule}`);
    expect(classifySendFailure(error)).toEqual({ state: 'indeterminate', reason: 'prompt-unreported' });
    // No Enter beyond the first: the composer never showed the body.
    expect(sent.enters()).toBe(1);
    expect(loggerSpies.error).toHaveBeenCalledWith(
      'submit-not-confirmed:prompt-unreported',
      expect.objectContaining({ sessionName: SESSION, rule })
    );
  });

  it('resends Enter when the unsent body is drawn late, and settles on the hook (the live shape)', async () => {
    startSession();
    // The first Enter is lost: placeholder, then the body ~1 s later. The second
    // Enter submits it: the hook arrives and Claude starts generating.
    const sent = script(PLACEHOLDER, [[PLACEHOLDER, PLACEHOLDER, PLACEHOLDER, LATE_BODY], [GENERATING]], (enters) => {
      if (enters === 2) reportPrompt();
    });

    expect(await run(INIT_MESSAGE)).toBeNull();
    expect(sent.enters()).toBe(2);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      'submit-not-confirmed:resending-enter',
      expect.objectContaining({ sessionName: SESSION })
    );
  });

  it('logs the rule and the awaited report on the verdict', async () => {
    startSession();
    script(PLACEHOLDER, [[PLACEHOLDER]]);

    await run(INIT_MESSAGE);

    expect(infoCalls('submit-classified')[0]).toMatchObject({
      sessionName: SESSION,
      attempt: 0,
      state: 'submitted',
      rule: 'F',
      receipt: 'awaited',
    });
  });
});

describe('[#4035] ordinary sends are unchanged (negative)', () => {
  it('is sent at once when the hook already arrived by the read-back', async () => {
    startSession();
    const sent = script(PLACEHOLDER, [[IDLE]], () => reportPrompt());

    expect(await run(INIT_MESSAGE)).toBeNull();
    expect(sent.enters()).toBe(1);
    expect(infoCalls('submit-classified')[0]).toMatchObject({ rule: 'B-empty', receipt: 'received' });
  });

  it('is sent when the hook arrives during the wait', async () => {
    startSession();
    script(PLACEHOLDER, [[IDLE]], (_enters, read) => {
      if (read === 3) reportPrompt();
    });

    expect(await run(INIT_MESSAGE)).toBeNull();
    expect(loggerSpies.info).toHaveBeenCalledWith(
      'submit-confirmed-by-prompt-hook',
      expect.objectContaining({ sessionName: SESSION, rule: 'B-empty' })
    );
  });

  it('takes a generating screen (A) as submitted without the hook', async () => {
    startSession();
    const sent = script(PLACEHOLDER, [[GENERATING]]);

    expect(await run(INIT_MESSAGE)).toBeNull();
    expect(sent.enters()).toBe(1);
    expect(infoCalls('submit-classified')[0]).toMatchObject({ rule: 'A', receipt: 'not-required' });
  });

  it('keeps the screen verdict for a session whose hooks never reported anything', async () => {
    startSession(false);
    script(PLACEHOLDER, [[PLACEHOLDER]]);

    expect(await run(INIT_MESSAGE)).toBeNull();
    expect(infoCalls('submit-classified')[0]).toMatchObject({ rule: 'F', receipt: 'not-required' });
  });

  it('keeps the screen verdict for a session this server did not start', async () => {
    script(PLACEHOLDER, [[PLACEHOLDER]]);

    expect(await run(INIT_MESSAGE)).toBeNull();
  });

  it('keeps the screen verdict once the session has reported a prompt (not the first send)', async () => {
    startSession();
    notePromptSubmitHook(TARGET, 'user_prompt_submit', Date.now() - 500);
    script(PLACEHOLDER, [[IDLE]]);

    expect(await run(CONTRACT)).toBeNull();
  });

  it('keeps the screen verdict for a slash command, which the TUI runs itself', async () => {
    startSession();
    script(PLACEHOLDER, [[PLACEHOLDER]]);

    expect(await run('/model opus')).toBeNull();
  });

  it('never waits for any other tool', async () => {
    notePromptSubmitSession('mcbd-codex-p4035', { worktreeId: 'p4035', cliToolId: 'codex' }, Date.now() - 2000);
    notePromptSubmitHook({ worktreeId: 'p4035', cliToolId: 'codex' }, 'session_start', Date.now() - 1000);
    expect(readPromptSubmitReceipt('mcbd-codex-p4035', 'codex', Date.now())).toBe('not-required');
  });
});

describe('[#4035] the next send finds the body the previous one called sent', () => {
  /** A first send reported `sent` from the placeholder (hooks not live, as before the fix). */
  async function sendWronglyReportedSent(): Promise<void> {
    startSession(false);
    script(PLACEHOLDER, [[PLACEHOLDER]]);
    expect(await run(INIT_MESSAGE)).toBeNull();
    recordSendAttempt(INSTANCE, { state: 'sent', reason: 'submitted', content: INIT_MESSAGE });
  }

  it('says so and turns lastSend indeterminate when one pass clears it (18 of 20 in the issue)', async () => {
    await sendWronglyReportedSent();
    vi.clearAllMocks();
    // The body appeared late; one C-e+C-u leaves the placeholder.
    let cleared = false;
    vi.mocked(clearComposerLine).mockImplementation(async () => {
      cleared = true;
    });
    vi.mocked(capturePane).mockImplementation(async () => (cleared ? PLACEHOLDER : LATE_BODY));
    const checked = sendMessageWithSubmitVerification({
      sessionName: SESSION,
      message: CONTRACT,
      cliToolId: 'claude',
      textInputWaitMs: 1,
      verifyDelayMs: 1,
    });
    // Look at lastSend between the clear and this send's own record.
    vi.mocked(sendSpecialKeys).mockImplementation(async () => {
      expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'indeterminate', reason: 'found-in-composer' });
    });
    await vi.advanceTimersByTimeAsync(5000);
    await checked;

    expect(loggerSpies.warn).toHaveBeenCalledWith(
      'pre-send-found-submitted-body',
      expect.objectContaining({ sessionName: SESSION, cleared: true, length: INIT_MESSAGE.length })
    );
    expect(sendSpecialKeys).toHaveBeenCalled();
  });

  it('says so and refuses composer-not-empty when no pass clears it (2 of 20 in the issue)', async () => {
    await sendWronglyReportedSent();
    vi.clearAllMocks();
    vi.mocked(capturePane).mockResolvedValue(LATE_BODY);
    const sending = sendMessageWithSubmitVerification({
      sessionName: SESSION,
      message: CONTRACT,
      cliToolId: 'claude',
      textInputWaitMs: 1,
      verifyDelayMs: 1,
    }).then(
      () => null,
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(5000);
    const error = await sending;

    expect(classifySendFailure(error)).toEqual({ state: 'not-sent', reason: 'composer-not-empty' });
    expect(clearComposerLine).toHaveBeenCalledTimes(12);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      'pre-send-found-submitted-body',
      expect.objectContaining({ sessionName: SESSION, cleared: false })
    );
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'indeterminate', reason: 'found-in-composer' });
  });

  it('stays quiet about other text in the composer', async () => {
    await sendWronglyReportedSent();
    vi.clearAllMocks();
    let cleared = false;
    vi.mocked(clearComposerLine).mockImplementation(async () => {
      cleared = true;
    });
    const other = LATE_BODY.replace('セッションの起動とモデルの確認です', '利用者が打ちかけた別の文');
    vi.mocked(capturePane).mockImplementation(async () => (cleared ? PLACEHOLDER : other));
    const sending = sendMessageWithSubmitVerification({
      sessionName: SESSION,
      message: CONTRACT,
      cliToolId: 'claude',
      textInputWaitMs: 1,
      verifyDelayMs: 1,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await sending;

    expect(loggerSpies.warn).not.toHaveBeenCalledWith('pre-send-found-submitted-body', expect.anything());
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ state: 'sent', reason: 'submitted' });
  });
});
