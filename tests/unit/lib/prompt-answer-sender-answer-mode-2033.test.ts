/**
 * `sendPromptAnswer` refuses a digit the dialog on screen cannot take
 * (Issue #2033).
 *
 * ## The hole this file exists to keep shut
 *
 * `sendPromptAnswer` chose its input method from the tool id alone: claude and
 * antigravity got cursor navigation, and — in the words of the comment that used
 * to sit above the condition — "everything else (codex/gemini/copilot/opencode)
 * accepts 'N' + Enter as text". Issue #1893 measured that opencode does not.
 * Its permission dialog is a row of unnumbered buttons (`Allow once  Allow
 * always  Reject`) driven by ←/→; a typed `3` is swallowed and the Enter after
 * it confirms whatever is HIGHLIGHTED, which defaults to `Allow once`. So
 * `respond <id> 3`, meaning Reject, approved.
 *
 * Nothing in the sender stopped that. What stopped it was upstream —
 * `hasNumberedDialogs: false` kept `detectPrompt` from reporting a numbered
 * dialog, and `evaluateAutoYesDialogGate` kept Auto-Yes off it — so any caller
 * that reached the sender directly still had the dangerous path.
 *
 * ## Why every assertion here is about `answerMode` and not about opencode
 *
 * Adding `opencode` to a list of tool ids would have re-opened the hole on the
 * eighth tool. The measurement already exists per DIALOG, in the module that
 * read each tool's own frames: `DialogVerdict.answerMode`. So the two load-
 * bearing cases in this file are the ones a tool-name fix would get wrong:
 *
 *  - copilot's `/model` PICKER is `keys` and must be refused, even though
 *    copilot is not opencode and its permission dialog is `numbered`;
 *  - copilot's permission dialog, on the same tool, must still go through.
 *
 * ## Non-vacuity
 *
 * Every "refused" assertion is paired with the same frame reaching the pane
 * under a different answer or a different dialog, so a guard that refused
 * everything would fail this file, and the refusals are asserted on the KEYS —
 * `sendKeys`/`sendSpecialKeys` never called — rather than only on the throw, so
 * a guard that threw after typing would fail too. Two mutations were injected
 * into `assertAnswerModeAcceptsNumber` and measured: replacing the `throw` with
 * a `return` turns 4 of these red, and re-hardcoding the rule to
 * `cliToolId === 'opencode'` turns the copilot-picker one red on its own.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
}));

import {
  sendPromptAnswer,
  PromptAnswerRejectedError,
  ANSWER_MODE_KEYS_REASON,
} from '@/lib/prompt-answer-sender';
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import type { PromptData } from '@/types/models';

const FIXTURES = path.resolve(__dirname, 'detection/fixtures');

/** A live capture, raw: ANSI and box drawing intact, as tmux emitted it. */
function frame(dir: string, name: string): string {
  return readFileSync(path.join(FIXTURES, dir, `${name}.txt`), 'utf8');
}

const OPENCODE_PERMISSION = () => frame('opencode-live-1893', 'permission-bash');
const COPILOT_PICKER = () => frame('copilot-live-1885', 'model-picker');
const COPILOT_PERMISSION = () => frame('copilot-live-1885', 'permission-dialog');
const CODEX_APPROVAL = () => frame('codex-live-1628', 'approval-run-command');
const CLAUDE_APPROVAL = () => frame('claude-live-1708', 'bash-approval-taskpanel');

const MULTIPLE_CHOICE: PromptData = {
  type: 'multiple_choice',
  question: 'Allow?',
  options: [
    { number: 1, label: 'Allow once', isDefault: true },
    { number: 2, label: 'Allow always' },
    { number: 3, label: 'Reject' },
  ],
  status: 'pending',
};

/** Nothing at all reached tmux. */
function expectNothingSent(): void {
  expect(sendKeys).not.toHaveBeenCalled();
  expect(sendSpecialKeys).not.toHaveBeenCalled();
}

async function rejection(params: Parameters<typeof sendPromptAnswer>[0]): Promise<PromptAnswerRejectedError> {
  const error = await sendPromptAnswer(params).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, 'sendPromptAnswer resolved instead of refusing').toBeInstanceOf(PromptAnswerRejectedError);
  return error as PromptAnswerRejectedError;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(capturePane).mockResolvedValue('');
});

describe('[#2033] a keys-mode dialog refuses a typed number', () => {
  it('refuses `respond <id> 3` on opencode’s permission strip without touching the pane', async () => {
    const error = await rejection({
      sessionName: 'mcbd-opencode-wt',
      answer: '3',
      cliToolId: 'opencode',
      promptData: MULTIPLE_CHOICE,
      frame: OPENCODE_PERMISSION(),
    });

    // The acceptance condition, stated as keys: neither the `3` nor the Enter.
    expectNothingSent();
    expect(error.reason).toBe(ANSWER_MODE_KEYS_REASON);
    expect(error.dialogKind).toBe('permission');
    expect(error.answerMode).toBe('keys');
  });

  it('refuses the default option too — `1` is no safer than `3` on a strip with no numbers', async () => {
    await rejection({
      sessionName: 'mcbd-opencode-wt',
      answer: '1',
      cliToolId: 'opencode',
      promptData: MULTIPLE_CHOICE,
      frame: OPENCODE_PERMISSION(),
    });
    expectNothingSent();
  });

  it('reads the pane itself when the caller passes no frame, so the sender is safe on its own', async () => {
    vi.mocked(capturePane).mockResolvedValue(OPENCODE_PERMISSION());

    const error = await rejection({
      sessionName: 'mcbd-opencode-wt',
      answer: '3',
      cliToolId: 'opencode',
    });

    expect(capturePane).toHaveBeenCalledWith('mcbd-opencode-wt', expect.any(Number));
    expectNothingSent();
    expect(error.reason).toBe(ANSWER_MODE_KEYS_REASON);
  });
});

describe('[#2033] the rule is answerMode, not the tool id', () => {
  it('refuses copilot’s picker, which is `keys` on a tool whose permission dialog is not', async () => {
    const error = await rejection({
      sessionName: 'mcbd-copilot-wt',
      answer: '2',
      cliToolId: 'copilot',
      promptData: MULTIPLE_CHOICE,
      frame: COPILOT_PICKER(),
    });

    expectNothingSent();
    expect(error.dialogKind).toBe('picker');
    expect(error.answerMode).toBe('keys');
  });

  it('lets copilot’s `numbered` permission dialog through — same tool, opposite verdict', async () => {
    await sendPromptAnswer({
      sessionName: 'mcbd-copilot-wt',
      answer: '2',
      cliToolId: 'copilot',
      promptData: MULTIPLE_CHOICE,
      frame: COPILOT_PERMISSION(),
    });

    expect(sendKeys).toHaveBeenCalledWith('mcbd-copilot-wt', '2', false);
    expect(sendKeys).toHaveBeenCalledWith('mcbd-copilot-wt', '', true);
  });
});

describe('[#2033] the numeric paths that were already correct are unchanged', () => {
  it('codex still types the digit on its `numbered` approval', async () => {
    await sendPromptAnswer({
      sessionName: 'mcbd-codex-wt',
      answer: '1',
      cliToolId: 'codex',
      promptData: MULTIPLE_CHOICE,
      frame: CODEX_APPROVAL(),
    });

    expect(sendKeys).toHaveBeenCalledWith('mcbd-codex-wt', '1', false);
  });

  it('claude still navigates with cursor keys on its `numbered` approval', async () => {
    await sendPromptAnswer({
      sessionName: 'mcbd-claude-wt',
      answer: '2',
      cliToolId: 'claude',
      promptData: MULTIPLE_CHOICE,
      frame: CLAUDE_APPROVAL(),
    });

    expect(sendSpecialKeys).toHaveBeenCalledWith('mcbd-claude-wt', ['Down', 'Enter']);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('never gates a tool with no measured dialog rules, and never reads its pane', async () => {
    // gemini has no tool module (`createGenericStatusDetector`). Gating it on
    // rules that do not exist would silence it — the rollout mistake
    // `auto-yes-dialog-gate` documents — so the guard must not even capture.
    await sendPromptAnswer({
      sessionName: 'mcbd-gemini-wt',
      answer: '1',
      cliToolId: 'gemini',
      promptData: MULTIPLE_CHOICE,
    });

    expect(capturePane).not.toHaveBeenCalled();
    expect(sendKeys).toHaveBeenCalledWith('mcbd-gemini-wt', '1', false);
  });
});

describe('[#2033] the guard is scoped to numeric answers and readable panes', () => {
  it('still sends a non-numeric answer on the very frame it refuses a digit on', async () => {
    await sendPromptAnswer({
      sessionName: 'mcbd-opencode-wt',
      answer: 'y',
      cliToolId: 'opencode',
      frame: OPENCODE_PERMISSION(),
    });

    // Not an endorsement of `y` on a button strip — that is #1681's resolver's
    // problem. It is what keeps this guard from being a blanket refusal, which
    // is the shape that would pass the tests above while breaking every tool.
    expect(sendKeys).toHaveBeenCalledWith('mcbd-opencode-wt', 'y', false);
  });

  it('sends when a frame the tool cannot read is on screen', async () => {
    await sendPromptAnswer({
      sessionName: 'mcbd-opencode-wt',
      answer: '1',
      cliToolId: 'opencode',
      frame: frame('opencode-live-1893', 'turn-complete-short'),
    });

    expect(sendKeys).toHaveBeenCalledWith('mcbd-opencode-wt', '1', false);
  });

  it('falls open when the pane cannot be captured at all', async () => {
    // Deliberate: `/prompt-response` makes the same call for its own pre-send
    // verification ("If capture fails, proceed with caution - don't block manual
    // responses"). An unreadable pane is far more often a dead transport than an
    // open dialog, and refusing there would break the operator's way out.
    vi.mocked(capturePane).mockRejectedValue(new Error('Failed to capture pane: no server'));

    await sendPromptAnswer({
      sessionName: 'mcbd-opencode-wt',
      answer: '1',
      cliToolId: 'opencode',
    });

    expect(sendKeys).toHaveBeenCalledWith('mcbd-opencode-wt', '1', false);
  });
});
