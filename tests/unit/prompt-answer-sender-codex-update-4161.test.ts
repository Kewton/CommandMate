/**
 * Issue #4161: codex's update offer confirms on the digit, so `respond` sends no
 * Enter after it. Measured on 0.166.0 in an isolated CODEX_HOME: the Enter landed
 * on the next screen and wrote `trust_level = "trusted"` on the folder trust, and
 * opened the list on the hook review. The trust and the hook review take a digit
 * as a cursor move and still need their Enter.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { capturePane, sendKeys } from '@/lib/tmux/tmux';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';

const fixture = (rel: string): string => readFileSync(resolve(__dirname, '../fixtures', rel), 'utf8');

const UPDATE_FRAMES = [
  'codex-dialogs-0166/update.txt',
  'codex-update-dialog-3020/update-dialog-01571.txt',
  'codex-update-dialog-2068/update-dialog-01491.txt',
];
const ENTER_FRAMES = ['codex-dialogs-0166/trust.txt', 'codex-dialogs-0166/hooks-review.txt'];

function keys(): Array<[string, boolean | undefined]> {
  return vi.mocked(sendKeys).mock.calls.map((call) => [call[1], call[2]]);
}

async function answer(frame: string, digit: string): Promise<void> {
  vi.mocked(capturePane).mockResolvedValue(frame);
  await sendPromptAnswer({ sessionName: 'mcbd-codex-wt4161', answer: digit, cliToolId: 'codex', frame });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetInstanceInputLocks();
});

describe('codex update offer: the digit alone', () => {
  it.each(UPDATE_FRAMES)('%s declares answer_only', (rel) => {
    const dialog = getToolStatusDetector('codex').detectDialog(normalizeFrame(fixture(rel), 'codex'));
    expect(dialog).toMatchObject({ kind: 'update', answerMode: 'numbered', submitMode: 'answer_only' });
  });

  it.each(UPDATE_FRAMES)('%s: no Enter after the digit', async (rel) => {
    await answer(fixture(rel), '3');
    expect(keys()).toEqual([['3', false]]);
  });

  it('wins over a caller that says answer_then_enter', async () => {
    const frame = fixture('codex-dialogs-0166/update.txt');
    vi.mocked(capturePane).mockResolvedValue(frame);
    await sendPromptAnswer({
      sessionName: 'mcbd-codex-wt4161',
      answer: '2',
      cliToolId: 'codex',
      frame,
      fallbackSubmitMode: 'answer_then_enter',
    });
    expect(keys()).toEqual([['2', false]]);
  });
});

describe('negative: the screens that need their Enter keep it', () => {
  it.each(ENTER_FRAMES)('%s declares no submitMode', (rel) => {
    const dialog = getToolStatusDetector('codex').detectDialog(normalizeFrame(fixture(rel), 'codex'));
    expect(dialog).not.toBeNull();
    expect(dialog?.submitMode).toBeUndefined();
  });

  it.each(ENTER_FRAMES)('%s: the digit, then Enter', async (rel) => {
    await answer(fixture(rel), '1');
    expect(keys()).toEqual([
      ['1', false],
      ['', true],
    ]);
  });
});
