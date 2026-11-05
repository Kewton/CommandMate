/**
 * Issue #4146: `answerMode: 'numbered'` against what codex 0.166.0 was measured to
 * do with a key (`tests/fixtures/codex-dialogs-0166/README.md`). The detector and
 * the sender are real; the pane is a simulation that moves only on the measured
 * keys. 未確認: a `respond` at a live 0.166.0 pane, and any approval or picker on
 * that build, for which no frame exists.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
}));

import { normalizeFrame } from '@/lib/detection/tools/frame';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { capturePane, sendKeys } from '@/lib/tmux/tmux';

const frame = (name: string): string =>
  readFileSync(resolve(__dirname, '../../../fixtures/codex-dialogs-0166', `${name}.txt`), 'utf8');

const dialogOn = (name: string) => getToolStatusDetector('codex').detectDialog(normalizeFrame(frame(name), 'codex'));

/** Which screen each measured key leads to. A key not listed changes nothing. */
const MEASURED: Record<string, Record<string, string>> = {
  'hooks-review': { '2': 'hooks-review-cursor-2', Enter: 'hooks-list' },
  'hooks-review-cursor-2': { Enter: 'ready' },
  trust: { Enter: 'ready' },
  update: { '3': 'ready' },
};

/** Answers on the simulated pane; returns the keys in order and the screen each landed on. */
async function respond(start: string, answer: string): Promise<{ keys: [string, string][]; end: string }> {
  let current = start;
  const keys: [string, string][] = [];
  vi.mocked(capturePane).mockImplementation(async () => frame(current));
  vi.mocked(sendKeys).mockImplementation(async (_session, text, enter) => {
    const key = enter === true ? 'Enter' : String(text);
    keys.push([key, current]);
    current = MEASURED[current]?.[key] ?? current;
  });
  await sendPromptAnswer({ sessionName: 'mcbd-codex-wt4146', answer, cliToolId: 'codex', frame: frame(start) });
  return { keys, end: current };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the launch screens of 0.166.0 are numbered', () => {
  it.each(['hooks-review', 'hooks-review-cursor-2', 'hooks-list', 'hooks-detail', 'trust'])('%s', (name) => {
    expect(dialogOn(name)?.answerMode).toBe('numbered');
    expect(dialogOn(name)?.submitMode).toBeUndefined();
  });

  it('update: numbered, and the digit alone answers it (Issue #4161)', () => {
    expect(dialogOn('update')?.answerMode).toBe('numbered');
    expect(dialogOn('update')?.submitMode).toBe('answer_only');
  });

  it('negative: the idle composer is no dialog', () => {
    expect(dialogOn('ready')).toBeNull();
  });
});

describe('a digit and an Enter, on the keys measured', () => {
  it('hook review: the digit moves the cursor and the Enter confirms that row', async () => {
    const { keys, end } = await respond('hooks-review', '2');
    expect(keys).toEqual([
      ['2', 'hooks-review'],
      ['Enter', 'hooks-review-cursor-2'],
    ]);
    expect(end).toBe('ready');
  });

  it('folder trust: the Enter confirms the row the cursor is on', async () => {
    const { keys, end } = await respond('trust', '1');
    expect(keys.map(([key]) => key)).toEqual(['1', 'Enter']);
    expect(end).toBe('ready');
  });

  it('update offer: the digit decides by itself, and no Enter follows it to the next screen (Issue #4161)', async () => {
    const { keys, end } = await respond('update', '3');
    expect(keys).toEqual([['3', 'update']]);
    expect(end).toBe('ready');
  });

  it('control: without the declaration the same answer sends an Enter onto the next screen', async () => {
    const detector = getToolStatusDetector('codex');
    const read = detector.detectDialog.bind(detector);
    const spy = vi.spyOn(detector, 'detectDialog').mockImplementation((normalized) => {
      const dialog = read(normalized);
      return dialog === null ? null : { kind: dialog.kind, options: dialog.options, answerMode: dialog.answerMode };
    });
    try {
      const { keys } = await respond('update', '3');
      expect(keys).toEqual([
        ['3', 'update'],
        ['Enter', 'ready'],
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
