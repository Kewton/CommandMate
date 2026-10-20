/**
 * agy's unnumbered arrow-key screens, told apart (Issue #3755).
 *
 * Every live capture of `antigravity-live-2364` is run through the reader: the
 * three unnumbered screens come out as themselves, and every other frame —
 * the numbered dialogs, the idle composer, the survey — comes out as none of
 * them. The status detector is not touched: it keeps publishing all three as
 * one selection list.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { readAntigravityArrowScreen } from '@/lib/detection/tools/antigravity/screens';

const DIR = path.resolve(__dirname, '../../../fixtures/antigravity-live-2364');
const frame = (file: string): string => stripAnsi(readFileSync(path.join(DIR, file), 'utf8'));

const EXPECTED: Record<string, string> = {
  'trust-dialog.txt': 'trust',
  'picker-switch-model.txt': 'model-picker',
  'popup-slash-commands.txt': 'slash-menu',
};

describe('[#3755] readAntigravityArrowScreen over the 2364 corpus', () => {
  const files = readdirSync(DIR).filter((file) => file.endsWith('.txt')).sort();

  it('walks the corpus', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of Object.keys(EXPECTED)) expect(files).toContain(file);
  });

  it.each(files)('%s', (file) => {
    const screen = readAntigravityArrowScreen(frame(file));
    expect(screen?.screen ?? null).toBe(EXPECTED[file] ?? null);
  });

  it('reads the slash popup\'s visible commands, highlight first', () => {
    const screen = readAntigravityArrowScreen(frame('popup-slash-commands.txt'));
    expect(screen?.options.slice(0, 2)).toEqual(['/add-dir', '/agents']);
    expect(screen?.selectedIndex).toBe(0);
    expect(screen?.question).toBeNull();
  });

  it('reads the folder off the label row when agy draws it inline', () => {
    const text = 'Accessing workspace: /work/p\nDo you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit\n\n↑/↓ Navigate · enter Confirm';
    expect(readAntigravityArrowScreen(text)?.approvalTarget).toBe('/work/p');
  });

  it('reads the trust screen with the cursor moved down to No', () => {
    const text = frame('trust-dialog.txt')
      .replace('> Yes, I trust this folder', '  Yes, I trust this folder')
      .replace('  No, exit', '> No, exit');
    const screen = readAntigravityArrowScreen(text);
    expect(screen?.options).toEqual(['Yes, I trust this folder', 'No, exit']);
    expect(screen?.selectedIndex).toBe(1);
  });

  it('reads the inline trust screen with the cursor on No (the block starts under the question)', () => {
    const text = 'Do you trust the contents of this project?\n  Yes, I trust this folder\n> No, exit\n\n↑/↓ Navigate · enter Confirm';
    expect(readAntigravityArrowScreen(text)).toMatchObject({ options: ['Yes, I trust this folder', 'No, exit'], selectedIndex: 1 });
  });

  it('refuses a list with no highlighted row', () => {
    const text = 'Do you trust the contents of this project?\n  Yes, I trust this folder\n  No, exit\n\n↑/↓ Navigate · enter Confirm';
    expect(readAntigravityArrowScreen(text)).toBeNull();
  });

  // Issue #3771 item 1: a quoted trust screen is a row of agent output, with
  // the turn's output still being drawn under it.
  describe('[#3771] a quoted trust screen', () => {
    const TRUST = 'Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit\n\n↑/↓ Navigate · enter Confirm';

    it('is not read when output continues under the footer', () => {
      expect(readAntigravityArrowScreen(`${TRUST}\n⠋ Generating...\nthe next line of the reply`)).toBeNull();
    });

    it('is still read with only blank rows under the footer', () => {
      expect(readAntigravityArrowScreen(`${TRUST}\n\n   \n`)?.screen).toBe('trust');
    });
  });
});
