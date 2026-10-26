/** @vitest-environment node */

/**
 * Issue #3927: the composer the unsent bar is drawn from is the one the clear
 * reads.
 *
 * #3906 taught the clear (`session/composer-clear.ts`) that a codex composer
 * with a dialog option drawn below it is one left from before the dialog, and
 * answers `no_composer` there. The bar's two sources — the published
 * `composerText` and the browser's own reading — still took that composer's old
 * text as `content`. They now read {@link extractLiveComposerText}, which
 * carries the rule; the rule itself moved into `detection/composer-text.ts`
 * (a leaf the browser bundle can import), re-stated on that module's SGR scan.
 *
 * The last block holds the re-stated row reading equal to the one the clear
 * used before the move (`readCodexGlyphRowKind`, `tools/codex/cli-patterns.ts`)
 * on every codex fixture, so moving it changes no clear.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  codexDialogBelow,
  extractComposerText,
  extractLiveComposerText,
  findCodexLiveComposerRow,
  isCodexBoldGutterRow,
  isCodexComposerRow,
} from '@/lib/detection/composer-text';
import { readCodexGlyphRowKind } from '@/lib/detection/tools/codex/cli-patterns';
import {
  CODEX_DIALOG_BELOW_FRAME,
  CODEX_LIVE_COMPOSER_FRAME,
  OLD_COMPOSER_TEXT,
} from '@tests/fixtures/codex-dialog-below-3927';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const FIXTURES = path.resolve(__dirname, 'fixtures');
const fixture = (dir: string, name: string): string =>
  readFileSync(path.join(FIXTURES, dir, `${name}.txt`), 'utf-8');

describe('Issue #3927: extractLiveComposerText', () => {
  it('the frame: the extractor alone still reads the old composer as content', () => {
    expect(extractComposerText(CODEX_DIALOG_BELOW_FRAME, 'codex')).toEqual({
      text: OLD_COMPOSER_TEXT,
      state: 'content',
    });
  });

  it('positive: an old composer with a dialog below it is no composer — empty text', () => {
    expect(extractLiveComposerText(CODEX_DIALOG_BELOW_FRAME, 'codex')).toEqual({ text: '', state: 'no_composer' });
  });

  it('negative: the same rows as the live codex composer are returned as before', () => {
    const read = extractLiveComposerText(CODEX_LIVE_COMPOSER_FRAME, 'codex');
    expect(read).toEqual({ text: OLD_COMPOSER_TEXT, state: 'content' });
    expect(read).toEqual(extractComposerText(CODEX_LIVE_COMPOSER_FRAME, 'codex'));
  });

  it.each([
    ['codex', 'codex-live-1890', 'composer-residual-plain'],
    ['codex', 'codex-live-1890', 'composer-residual-multiline'],
    ['codex', 'codex-live-1890', 'composer-placeholder-ask'],
    ['codex', 'codex-live-1890', 'dialog-model-picker'],
    ['claude', 'claude-live-1879', 'composer-residual-plain'],
    ['claude', 'claude-live-1879', 'composer-residual-multiline'],
    ['claude', 'claude-live-1879', 'composer-ghost-suggestion'],
  ])('negative: %s %s/%s reads as extractComposerText does', (tool, dir, name) => {
    const frame = fixture(dir, name);
    expect(extractLiveComposerText(frame, tool)).toEqual(extractComposerText(frame, tool));
  });

  it('negative: a claude composer keeps its text', () => {
    expect(extractLiveComposerText(fixture('claude-live-1879', 'composer-residual-plain'), 'claude')).toEqual({
      text: 'echo PREFILLED',
      state: 'content',
    });
  });

  it('negative: a tool outside the measured set is unsupported_tool, whatever the frame', () => {
    expect(extractLiveComposerText(CODEX_DIALOG_BELOW_FRAME, 'copilot')).toEqual({ text: '', state: 'unsupported_tool' });
  });

  it('negative: the dialog-below frame read as claude is left to the claude reader', () => {
    expect(extractLiveComposerText(CODEX_DIALOG_BELOW_FRAME, 'claude')).toEqual(
      extractComposerText(CODEX_DIALOG_BELOW_FRAME, 'claude'),
    );
  });
});

/** The two functions as `session/composer-clear.ts` wrote them before the move, on cli-patterns' reading. */
function isLiveRowBefore(row: string): boolean {
  return isCodexComposerRow(row) && !isCodexBoldGutterRow(row);
}

function findLiveRowBefore(rows: string[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const kind = readCodexGlyphRowKind(rows[i]);
    if (kind === 'option') return -1;
    if (kind === 'composer' && isLiveRowBefore(rows[i])) return i;
  }
  return -1;
}

function dialogBelowBefore(rows: string[], row: number): boolean {
  for (let i = rows.length - 1; i > row; i--) {
    const kind = readCodexGlyphRowKind(rows[i]);
    if (kind === 'option') return true;
    if (kind === 'composer' && isLiveRowBefore(rows[i])) return false;
  }
  return false;
}

describe('Issue #3927: the moved rule reads every codex frame as it did in composer-clear.ts', () => {
  const files = execFileSync(
    'git',
    ['ls-files', 'tests/fixtures', 'tests/unit/lib/detection/fixtures'],
    { cwd: REPO_ROOT, encoding: 'utf-8' },
  )
    .split('\n')
    .filter(f => /codex/.test(f) && /\.(txt|capture)$/.test(f));

  const frames: Array<[string, string]> = [
    ...files.map(f => [f, readFileSync(path.join(REPO_ROOT, f), 'utf-8')] as [string, string]),
    ['dialog-below-3927', CODEX_DIALOG_BELOW_FRAME],
    ['live-composer-3927', CODEX_LIVE_COMPOSER_FRAME],
  ];

  it('there are codex fixtures to compare on, with `›` rows of every kind', () => {
    expect(files.length).toBeGreaterThan(20);
    const kinds = new Set(frames.flatMap(([, raw]) => raw.split('\n').map(readCodexGlyphRowKind)));
    expect(kinds).toEqual(new Set([null, 'composer', 'transcript-echo', 'option']));
  });

  it('findCodexLiveComposerRow and codexDialogBelow agree with the pre-move reading on every frame and row', () => {
    const mismatches: string[] = [];
    for (const [name, raw] of frames) {
      const rows = raw.split('\n');
      if (findCodexLiveComposerRow(rows) !== findLiveRowBefore(rows)) mismatches.push(`${name}: live row`);
      for (let i = 0; i < rows.length; i++) {
        if (codexDialogBelow(rows, i) !== dialogBelowBefore(rows, i)) mismatches.push(`${name}:${i + 1}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('the dialog-below frame is one the rule fires on (the comparison is not vacuous)', () => {
    const rows = CODEX_DIALOG_BELOW_FRAME.split('\n');
    const composerRow = rows.findIndex(r => isCodexComposerRow(r) && r.includes('row 1: old'));
    expect(codexDialogBelow(rows, composerRow)).toBe(true);
    expect(dialogBelowBefore(rows, composerRow)).toBe(true);
    expect(codexDialogBelow(CODEX_LIVE_COMPOSER_FRAME.split('\n'), composerRow)).toBe(false);
  });
});
