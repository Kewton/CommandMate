/**
 * The sender takes only `1` or `2` on Command Code's Review page (Issue #4313
 * 再指示 1).
 *
 * The Review page payload (`readCommandCodeReviewPagePrompt`) is two rows,
 * `Submit` / `Cancel`, confirmed with the cursor and one Enter. Any other digit
 * used to fall out of the Review arm into the generic digit path and be typed
 * at the page (`answer_only`). The route refuses it first
 * (`resolvePromptAnswer`); this is the sender's own refusal for any caller that
 * reaches it with the payload anyway — nothing typed.
 *
 * Built on the 1.54.1 live capture; 1.88.2 is not captured (UAT).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  // Issue #4303 (merged from develop): the agent holds the pane.
  readPaneForeground: async () => 'other' as const,
  capturePane: vi.fn(),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

import { sendPromptAnswer, PromptAnswerRejectedError } from '@/lib/prompt-answer-sender';
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import {
  isCommandCodeReviewPagePrompt,
  readCommandCodeReviewPagePrompt,
} from '@/lib/detection/tools/command-code/dialog';
import type { PromptData } from '@/types/models';

const SESSION = 'mcbd-command-code-wt-4313';
const DIR = path.resolve(__dirname, '../../fixtures/command-code-askuserquestion-2754');
const REVIEW = readFileSync(path.join(DIR, 'review-page-submit-cancel.txt'), 'utf8');

function reviewPayload(): PromptData {
  const promptData = readCommandCodeReviewPagePrompt(REVIEW)?.promptData;
  expect(isCommandCodeReviewPagePrompt(promptData)).toBe(true);
  return promptData as PromptData;
}

function send(answer: string) {
  return sendPromptAnswer({
    sessionName: SESSION,
    answer,
    cliToolId: 'command-code',
    promptData: reviewPayload(),
    frame: REVIEW,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(capturePane).mockResolvedValue(REVIEW);
});

describe('[#4313 再指示 1] sendPromptAnswer on the Review page', () => {
  it('陽性対照: 1 is the cursor and one Enter', async () => {
    await send('1');
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys).mock.calls.map((call) => call[1])).toEqual([['Enter']]);
  });

  it.each(['3', '0', '12', 'yes', 'looks good'])('refuses %s with nothing typed', async (answer) => {
    await expect(send(answer)).rejects.toBeInstanceOf(PromptAnswerRejectedError);
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys)).not.toHaveBeenCalled();
  });
});

/** The question the page follows, as a stored row carries it: its own three rows. */
const QUESTION_BEFORE_PAGE: PromptData = {
  type: 'multiple_choice',
  question: 'Which option?',
  options: [
    { number: 1, label: 'Alpha', isDefault: true },
    { number: 2, label: 'Beta', isDefault: false },
    { number: 3, label: 'Gamma', isDefault: false },
  ],
  status: 'pending',
} as PromptData;

describe('[#4313 再指示 2] the screen decides, whatever payload the caller brought', () => {
  it.each(['3', '0', 'yes'])('refuses %s with the stored question payload and the page as the frame', async (answer) => {
    await expect(sendPromptAnswer({
      sessionName: SESSION,
      answer,
      cliToolId: 'command-code',
      promptData: QUESTION_BEFORE_PAGE,
      frame: REVIEW,
    })).rejects.toBeInstanceOf(PromptAnswerRejectedError);
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys)).not.toHaveBeenCalled();
  });

  it('refuses 3 with no frame from the caller (the pane read here is the page), answer_only included', async () => {
    await expect(sendPromptAnswer({
      sessionName: SESSION,
      answer: '3',
      cliToolId: 'command-code',
      promptData: { ...QUESTION_BEFORE_PAGE, submitMode: 'answer_only' } as PromptData,
    })).rejects.toBeInstanceOf(PromptAnswerRejectedError);
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys)).not.toHaveBeenCalled();
  });

  it('陰性対照: 1 with the stored question payload answers the page — one Enter, no digit', async () => {
    await sendPromptAnswer({
      sessionName: SESSION,
      answer: '1',
      cliToolId: 'command-code',
      promptData: QUESTION_BEFORE_PAGE,
      frame: REVIEW,
    });
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys).mock.calls.map((call) => call[1])).toEqual([['Enter']]);
  });

  it('陰性対照: 3 on a frame that is not the page is not refused by this rule', async () => {
    vi.mocked(capturePane).mockResolvedValue('');
    await sendPromptAnswer({
      sessionName: SESSION,
      answer: '3',
      cliToolId: 'command-code',
      promptData: QUESTION_BEFORE_PAGE,
      frame: '',
    });
    expect(vi.mocked(sendKeys)).toHaveBeenCalled();
  });
});
