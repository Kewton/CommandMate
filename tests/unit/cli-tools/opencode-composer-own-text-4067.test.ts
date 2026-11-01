/**
 * opencode's input box read the same way by the send readiness and the submit
 * read-back (Issue #4067, part A).
 *
 * The sidebar (#2047/#2095) is drawn on the input box's rows, right of the
 * box's bottom border. #4040's readiness cut each row there; the read-back
 * (`readSubmitComposer`'s `opencode-box`) read the whole row, so an empty box
 * beside the sidebar held the sidebar's working directory (`/private/…`) —
 * rule E `replaced` on a delivered message, `clearInputLine`, and a send
 * reported failed. Both now read through `composer-own-text`.
 *
 * Every frame is a real capture (`tests/fixtures/opencode-live-2046/`,
 * `opencode-live-2047/`, `opencode-v2-*`); the synthetic ones edit the box of a
 * real 200-column frame and keep its sidebar.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
  clearInputLine: vi.fn().mockResolvedValue(undefined),
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const spies = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { ...spies, withContext: () => spies };
  },
}));

import {
  VERIFY_WINDOW_LINES,
  classifySubmitWithRule,
  readSubmitComposer,
  withoutTrailingBlankRows,
} from '@/lib/cli-tools/submit-composer-read';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { capturePane, clearComposerLine, clearInputLine, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { resetInstanceInputLocks } from '@/lib/session/instance-input-lock';
import { stripAnsi } from '@/lib/detection/ansi';
import { isOpenCodeComposerReady } from '@/lib/detection/tools/opencode/readiness';
import {
  OPENCODE_COMPOSER_BOTTOM_BORDER,
  OPENCODE_GUTTER_ROW_PATTERN,
  findOpenCodeComposerRows,
  stripOpenCodeGutter,
} from '@/lib/detection/tools/opencode/patterns';
import {
  opencodeBoxObscured,
  opencodeBoxRightEdge,
  opencodeOwnText,
  readOpenCodeComposerOwnRows,
} from '@/lib/detection/tools/opencode/composer-own-text';
import type { CLIToolType } from '@/lib/cli-tools/types';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

/** The composer as `classifySubmitWithRule` reads it (whole pane, box reader). */
function composerOf(frame: string, tool: CLIToolType = 'opencode') {
  const lines = withoutTrailingBlankRows(stripAnsi(frame).split('\n'));
  return readSubmitComposer(frame, tool, 'opencode-box', lines, lines.slice(-VERIFY_WINDOW_LINES));
}

/** The pre-#4067 reading: the first non-blank buffer row, whole, gutter removed. */
function wholeRowReading(frame: string): string | undefined {
  const rows = findOpenCodeComposerRows(stripAnsi(frame).split('\n')) ?? [];
  return rows.map(stripOpenCodeGutter).find((row) => row.length > 0);
}

/**
 * A real frame with `body` typed into the box's first buffer row, the rest of
 * the row (the sidebar) kept — or replaced by `sidebar` when given.
 */
function withBodyInBox(frame: string, body: string, sidebar?: string): string {
  const lines = stripAnsi(frame).split('\n');
  let border = lines.length - 1;
  while (!OPENCODE_COMPOSER_BOTTOM_BORDER.test(lines[border])) border--;
  let top = border;
  while (OPENCODE_GUTTER_ROW_PATTERN.test(lines[top - 1])) top--;
  const edge = opencodeBoxRightEdge(lines)!;
  const row = lines[top].padEnd(edge);
  const gutterEnd = row.search(/[│┃]/) + 1;
  const inside = `  ${body}`.padEnd(edge - gutterEnd);
  expect(inside.length, 'the body fits inside the box').toBe(edge - gutterEnd);
  const right = sidebar === undefined ? row.slice(edge) : `    ${sidebar}`;
  lines[top] = row.slice(0, gutterEnd) + inside + right;
  return lines.join('\n');
}

/** Every `.txt` capture under `dir` (recursive), relative to the fixtures root. */
function capturesUnder(dir: string): string[] {
  const walk = (rel: string): string[] =>
    readdirSync(path.join(FIXTURES, rel)).flatMap((name) => {
      const child = path.join(rel, name);
      if (statSync(path.join(FIXTURES, child)).isDirectory()) return walk(child);
      return name.endsWith('.txt') ? [child] : [];
    });
  return walk(dir);
}

const SIDEBAR_FRAMES = [
  'opencode-live-2047/w200/turn-complete.txt',
  'opencode-live-2047/w200/numbered-answer.txt',
  'opencode-live-2047/w200/phrase-in-response.txt',
  'opencode-live-2047/w200/sidebar-title-phrase.txt',
  'opencode-live-2047/w200/double-esc-interrupted.txt',
  'opencode-live-2047/w200/turn-aborted-after-complete.txt',
  'opencode-live-2047/w200/turn-running.txt',
  'opencode-live-2047/w200/esc-again-window.txt',
  'opencode-live-2046/w80/sidebar-on.txt',
];

const TURN_COMPLETE_W200 = read('opencode-live-2047/w200/turn-complete.txt');

describe('opencode: an empty box beside the sidebar reads empty (Issue #4067)', () => {
  it.each(SIDEBAR_FRAMES)('positive: %s — empty, as the readiness says', (rel) => {
    const frame = read(rel);
    expect(isOpenCodeComposerReady(frame)).toBe(true);
    expect(composerOf(frame)).toEqual({ kind: 'empty' });
  });

  it.each(SIDEBAR_FRAMES)('control: %s — the whole row holds the sidebar text', (rel) => {
    expect(wholeRowReading(read(rel))).toMatch(/\S/);
  });

  it.each(SIDEBAR_FRAMES)('positive: %s after Enter — B-empty, never replaced', (rel) => {
    expect(classifySubmitWithRule(read(rel), 'opencode', 'hello world')).toEqual({
      state: 'submitted',
      rule: 'B-empty',
    });
  });

  it('control: the frames that were rule E carry a sidebar path that starts with `/`', () => {
    expect(wholeRowReading(TURN_COMPLETE_W200)).toMatch(/^\/[A-Za-z]/);
    expect(wholeRowReading(read('opencode-live-2046/w80/sidebar-on.txt'))).toMatch(/^\/[A-Za-z]/);
  });
});

describe('opencode: text inside the box is still read (Issue #4067)', () => {
  it.each(['w80', 'w120', 'w200'])('negative: composer-residual at %s — text `echo PREFILLED`', (width) => {
    const frame = read(`opencode-live-2047/${width}/composer-residual.txt`);
    const composer = composerOf(frame);
    expect(composer.kind).toBe('text');
    expect(composer.kind === 'text' && composer.text).toBe('echo PREFILLED');
    expect(classifySubmitWithRule(frame, 'opencode', 'echo PREFILLED')).toEqual({ state: 'pending', rule: 'D' });
  });

  it.each(['w80', 'w200'])('negative: an indented residual (`┃    old`) at %s — text', (width) => {
    const frame = stripAnsi(read(`opencode-live-2047/${width}/composer-residual.txt`)).replace(
      '┃  echo PREFILLED',
      '┃      echo PREFILLED'
    );
    expect(frame).toMatch(/┃ {6}echo PREFILLED/);
    const composer = composerOf(frame);
    expect(composer.kind === 'text' && composer.text).toBe('echo PREFILLED');
  });

  it('negative: a slash command left in the box beside the sidebar — still replaced', () => {
    const frame = withBodyInBox(TURN_COMPLETE_W200, '/statusline');
    expect(classifySubmitWithRule(frame, 'opencode', '/status')).toEqual({ state: 'replaced', rule: 'E' });
  });

  it('rows: only the inside of the box — a token-shaped sidebar text is not rule C', () => {
    const frame = withBodyInBox(TURN_COMPLETE_W200, 'other text', '[Pasted text #1 +3 lines]');
    // Control: the whole row does carry the token.
    expect(findOpenCodeComposerRows(frame.split('\n'))!.join('\n')).toContain('[Pasted text #1 +3 lines]');
    const composer = composerOf(frame);
    expect(composer.kind).toBe('text');
    if (composer.kind !== 'text') return;
    expect(composer.text).toBe('other text');
    expect(composer.rows.join('\n')).not.toContain('Pasted');
    expect(classifySubmitWithRule(frame, 'opencode', 'hello world')).toEqual({ state: 'submitted', rule: 'F' });
  });

  it('rows: a real token inside the box is still rule C (pending)', () => {
    const frame = withBodyInBox(TURN_COMPLETE_W200, '[Pasted text #1 +3 lines]');
    expect(classifySubmitWithRule(frame, 'opencode', 'hello world')).toEqual({ state: 'pending', rule: 'C' });
  });

  it('rows: the residual frame at 200 columns returns no text right of the box', () => {
    const frame = read('opencode-live-2047/w200/composer-residual.txt');
    const edge = opencodeBoxRightEdge(stripAnsi(frame).split('\n'));
    expect(edge).not.toBeNull();
    const composer = composerOf(frame);
    if (composer.kind !== 'text') throw new Error('expected text');
    for (const row of composer.rows) expect(row.length).toBeLessThanOrEqual(edge!);
    expect(composer.rows.filter((row) => row !== '')).toEqual(['echo PREFILLED']);
  });
});

describe('composer-own-text (Issue #4067)', () => {
  it('cuts a row at the right edge and removes the gutter', () => {
    expect(opencodeOwnText('  ┃  hello     /private/tmp/x', 12)).toBe('hello');
    expect(opencodeOwnText('  ┃      old', 12)).toBe('old');
  });

  it('with no right edge reads the whole row (the pre-#4067 reading)', () => {
    expect(opencodeOwnText('  ┃  hello     /private/tmp/x', null)).toBe('hello     /private/tmp/x');
  });

  it('no box on screen — null, like findOpenCodeComposerRows', () => {
    expect(readOpenCodeComposerOwnRows(['dev@host % opencode', ''])).toBeNull();
    expect(opencodeBoxRightEdge(['dev@host % opencode'])).toBeNull();
  });
});

describe('opencode: readiness and read-back agree on every capture (Issue #4067)', () => {
  const V1_DIRS = readdirSync(FIXTURES).filter(
    (name) =>
      name.startsWith('opencode-') &&
      !name.startsWith('opencode-v2-') &&
      statSync(path.join(FIXTURES, name)).isDirectory()
  );
  const frames = V1_DIRS.flatMap(capturesUnder);
  const ready = frames.filter((rel) => isOpenCodeComposerReady(read(rel)));

  it('finds the opencode captures', () => {
    expect(frames.length).toBeGreaterThanOrEqual(60);
    expect(ready.length).toBeGreaterThanOrEqual(40);
  });

  it.each(ready)('%s — ready, so the read-back is empty', (rel) => {
    expect(composerOf(read(rel))).toEqual({ kind: 'empty' });
  });
});

/**
 * opencode-v2 (2.0.x) draws the same box — `┃` gutter rows over `╹▀…▀` — and
 * the same sidebar right of it (`opencode-v2-usage-2981/pane-turn1-2.0.18.txt`:
 * `Claude, GPT, Gemini etc` beside an empty box), so it is cut the same way.
 * Every v2 capture's reading, fixed: `pane-turn1/2-2.0.18` were `text` (the
 * sidebar's promo) and rule F before #4067; the rest are unchanged.
 */
const V2_READINGS: Array<[string, string, string]> = [
  ['opencode-v2-agent-mode-3038/completion-row-only.txt', 'absent', 'B-absent'],
  ['opencode-v2-agent-mode-3038/home-build.txt', 'empty', 'B-empty'],
  ['opencode-v2-agent-mode-3038/home-plan.txt', 'empty', 'B-empty'],
  ['opencode-v2-agent-mode-3038/session-build.txt', 'empty', 'B-empty'],
  ['opencode-v2-agent-mode-3038/session-palette.txt', 'empty', 'B-empty'],
  ['opencode-v2-agent-mode-3038/session-plan.txt', 'empty', 'B-empty'],
  ['opencode-v2-agent-mode-3038/session-question.txt', 'absent', 'B-absent'],
  ['opencode-v2-body-numbered-list-2991/uat-tc04-pane.txt', 'empty', 'B-empty'],
  ['opencode-v2-dialogs-2984/commands.txt', 'empty', 'B-empty'],
  ['opencode-v2-dialogs-2984/numbered-reply.txt', 'empty', 'B-empty'],
  ['opencode-v2-dialogs-2984/permission-after-digit.txt', 'absent', 'B-absent'],
  ['opencode-v2-dialogs-2984/permission.txt', 'absent', 'B-absent'],
  ['opencode-v2-dialogs-2984/question-answered-by-digit.txt', 'empty', 'B-empty'],
  ['opencode-v2-dialogs-2984/question-under-quoted-dialog.txt', 'absent', 'B-absent'],
  ['opencode-v2-dialogs-2984/question.txt', 'absent', 'B-absent'],
  ['opencode-v2-dialogs-2984/quoted-dialog-reply.txt', 'empty', 'B-empty'],
  ['opencode-v2-live-2934/boot-idle.txt', 'empty', 'B-empty'],
  ['opencode-v2-live-2934/turn-done.txt', 'empty', 'B-empty'],
  ['opencode-v2-live-2934/turn-running.txt', 'empty', 'A'],
  ['opencode-v2-live-2945/permission-required.txt', 'absent', 'B-absent'],
  ['opencode-v2-live-2945/question-answered.txt', 'empty', 'B-empty'],
  ['opencode-v2-live-2945/question.txt', 'absent', 'B-absent'],
  ['opencode-v2-live-2945/turn-done-after-approval.txt', 'empty', 'B-empty'],
  ['opencode-v2-live-2971/commands.txt', 'text:Open diff viewer', 'F'],
  ['opencode-v2-live-2971/select-agent.txt', 'empty', 'B-empty'],
  ['opencode-v2-live-2971/select-model.txt', 'empty', 'B-empty'],
  ['opencode-v2-live-2971/select-variant-over-transcript.txt', 'empty', 'B-empty'],
  ['opencode-v2-live-2971/select-variant-typed.txt', 'empty', 'B-empty'],
  ['opencode-v2-live-2971/select-variant.txt', 'empty', 'B-empty'],
  ['opencode-v2-live-2971/sessions.txt', 'empty', 'B-empty'],
  ['opencode-v2-model-keys-2983/commands-ctrl-p.txt', 'text:Open diff viewer', 'F'],
  ['opencode-v2-model-keys-2983/home-esc-then-variant.txt', 'empty', 'B-empty'],
  ['opencode-v2-model-keys-2983/home.txt', 'empty', 'B-empty'],
  ['opencode-v2-model-keys-2983/model-then-ctrl-p.txt', 'empty', 'B-empty'],
  ['opencode-v2-model-keys-2983/model-then-ctrl-t.txt', 'empty', 'B-empty'],
  ['opencode-v2-model-keys-2983/models-esc-then-commands.txt', 'text:VCS', 'F'],
  ['opencode-v2-model-keys-2983/models-esc-then-variant.txt', 'empty', 'B-empty'],
  ['opencode-v2-model-keys-2983/palette-esc-then-models.txt', 'empty', 'B-empty'],
  ['opencode-v2-model-keys-2983/palette-then-ctrl-t.txt', 'text:VCS', 'F'],
  ['opencode-v2-model-keys-2983/palette-then-ctrl-x-m.txt', 'empty', 'B-empty'],
  ['opencode-v2-model-keys-2983/select-model-ctrl-x-m.txt', 'empty', 'B-empty'],
  ['opencode-v2-model-keys-2983/space-bunny-variant-dialog.txt', 'empty', 'B-empty'],
  ['opencode-v2-model-keys-2983/variant-ctrl-t-1.txt', 'empty', 'B-empty'],
  ['opencode-v2-model-keys-2983/variant-default.txt', 'empty', 'B-empty'],
  ['opencode-v2-schedule-2974/run-ask-rejected.stderr.txt', 'absent', 'B-absent'],
  ['opencode-v2-usage-2981/pane-turn1-2.0.18.txt', 'empty', 'B-empty'],
  ['opencode-v2-usage-2981/pane-turn2-2.0.18.txt', 'empty', 'B-empty'],
];

describe('opencode-v2: the same cut (Issue #4067)', () => {
  it('covers every v2 capture', () => {
    const all = readdirSync(FIXTURES)
      .filter((name) => name.startsWith('opencode-v2-'))
      .flatMap(capturesUnder)
      .sort();
    expect(V2_READINGS.map(([rel]) => rel).sort()).toEqual(all);
  });

  it.each(V2_READINGS)('%s — %s, rule %s', (rel, reading, rule) => {
    const frame = read(rel);
    const composer = composerOf(frame, 'opencode-v2');
    expect(composer.kind === 'text' ? `text:${composer.text}` : composer.kind).toBe(reading);
    expect(classifySubmitWithRule(frame, 'opencode-v2', 'hello world').rule).toBe(rule);
  });

  it('control: the v2 sidebar frame held the promo text on the whole row', () => {
    expect(wholeRowReading(read('opencode-v2-usage-2981/pane-turn1-2.0.18.txt'))).toBe('Claude, GPT, Gemini etc');
  });
});

describe('opencode: the send beside the sidebar (Issue #4067)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetInstanceInputLocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetInstanceInputLocks();
  });

  it.each(['opencode-live-2047/w200/turn-complete.txt', 'opencode-live-2046/w80/sidebar-on.txt'])(
    'positive: %s on every read — resolves, no clearInputLine',
    async (rel) => {
      vi.mocked(capturePane).mockResolvedValue(read(rel));
      const settled = sendMessageWithSubmitVerification({
        sessionName: 'mcbd-opencode-wt',
        message: 'hello world',
        cliToolId: 'opencode',
      }).then(
        () => undefined,
        (error: Error) => error
      );
      await vi.runAllTimersAsync();
      expect(await settled).toBeUndefined();
      expect(clearInputLine).not.toHaveBeenCalled();
    }
  );
});

/**
 * Review of #4067: an overlay (the command palette, a picker) drawn over the box
 * cuts its bottom border in two — `╹▀▀▀▀▀▀`, the overlay, `▀▀▀▀▀▀▀▀` — and the
 * first run's end is where the overlay starts, not the box's right edge. Read
 * there, text right of the cut was outside the box, and a blank overlay made the
 * box `empty` (rule B, `submitted`). Such a box is now read to the border's far
 * end and marked `obscured`, and none of B–F stands on it (`indeterminate`):
 * the reading includes the overlay's text, and C/D's resent Enter or E's clear
 * would go to the overlay (second review of #4067).
 *
 * The synthetic frames edit the real palette capture's box rows only
 * (`opencode-live-2049/command-palette-11822.txt`), its cut border kept.
 */
const OBSCURED_CAPTURES = [
  'opencode-live-2049/command-palette-11822.txt',
  '../unit/lib/detection/fixtures/opencode-live-1896/command-palette.txt',
  'canary/opencode-picker.raw.txt',
];

const PALETTE = read('opencode-live-2049/command-palette-11822.txt');

/**
 * The palette frame with every box row blanked from the gutter to the border's
 * far end (a blank overlay over an empty-looking box), and `residue` written
 * into the first box row starting four columns right of the first run's end.
 */
function underOverlay(residue?: string): string {
  const lines = stripAnsi(PALETTE).split('\n');
  let border = lines.length - 1;
  while (!OPENCODE_COMPOSER_BOTTOM_BORDER.test(lines[border])) border--;
  let top = border;
  while (OPENCODE_GUTTER_ROW_PATTERN.test(lines[top - 1])) top--;
  const cut = opencodeBoxRightEdge(lines)!;
  const far = lines[border].lastIndexOf('▀') + 1;
  for (let r = top; r < border; r++) {
    const row = lines[r].padEnd(far);
    const gutterEnd = row.search(/[│┃]/) + 1;
    lines[r] = row.slice(0, gutterEnd) + ' '.repeat(far - gutterEnd) + row.slice(far);
  }
  if (residue !== undefined) {
    const at = cut + 4;
    expect(at + residue.length, 'the residue fits inside the box').toBeLessThanOrEqual(far);
    lines[top] = lines[top].slice(0, at) + residue + lines[top].slice(at + residue.length);
  }
  return lines.join('\n');
}

describe('opencode: an overlay over the box is not an empty box (review of #4067)', () => {
  it('control: the palette capture cuts the border in two — the first run ends before the far end', () => {
    const lines = stripAnsi(PALETTE).split('\n');
    const border = lines.filter((line) => OPENCODE_COMPOSER_BOTTOM_BORDER.test(line)).pop()!;
    expect(opencodeBoxRightEdge(lines)).toBeLessThan(border.lastIndexOf('▀'));
    expect(opencodeBoxObscured(lines)).toBe(true);
  });

  it('control: the cut at the first run reads the residue frame as nothing (the reading before the review)', () => {
    const lines = stripAnsi(underOverlay('echo PREFILLED')).split('\n');
    expect(readOpenCodeComposerOwnRows(lines)!.every((row) => row === '')).toBe(true);
  });

  it('positive: residue right of the cut is read — the body is indeterminate (F-obscured), not D (pending)', () => {
    const frame = underOverlay('echo PREFILLED');
    const composer = composerOf(frame);
    expect(composer).toMatchObject({ kind: 'text', text: 'echo PREFILLED', obscured: true });
    expect(classifySubmitWithRule(frame, 'opencode', 'echo PREFILLED')).toEqual({
      state: 'indeterminate',
      rule: 'F-obscured',
    });
  });

  it('positive: another slash command right of the cut — indeterminate (F-obscured), not E (replaced)', () => {
    expect(classifySubmitWithRule(underOverlay('/statusline'), 'opencode', '/status')).toEqual({
      state: 'indeterminate',
      rule: 'F-obscured',
    });
  });

  it('control: the same body and slash command in a whole box — D and E, as before', () => {
    expect(classifySubmitWithRule(withBodyInBox(TURN_COMPLETE_W200, 'echo PREFILLED'), 'opencode', 'echo PREFILLED')).toEqual({
      state: 'pending',
      rule: 'D',
    });
    expect(classifySubmitWithRule(withBodyInBox(TURN_COMPLETE_W200, '/statusline'), 'opencode', '/status')).toEqual({
      state: 'replaced',
      rule: 'E',
    });
  });

  it('positive: other residue right of the cut — indeterminate (F-obscured), not submitted', () => {
    expect(classifySubmitWithRule(underOverlay('left over'), 'opencode', 'hello world')).toEqual({
      state: 'indeterminate',
      rule: 'F-obscured',
    });
  });

  it('positive: a paste token right of the cut — indeterminate (F-obscured), not C (pending)', () => {
    expect(classifySubmitWithRule(underOverlay('[Pasted text #1 +3 lines]'), 'opencode', 'hello world')).toEqual({
      state: 'indeterminate',
      rule: 'F-obscured',
    });
  });

  it('positive: a blank overlay over the box — indeterminate (B-obscured), not B-empty', () => {
    const frame = underOverlay();
    expect(composerOf(frame)).toEqual({ kind: 'empty', obscured: true });
    expect(classifySubmitWithRule(frame, 'opencode', 'hello world')).toEqual({
      state: 'indeterminate',
      rule: 'B-obscured',
    });
  });

  it.each(OBSCURED_CAPTURES)('positive: %s (a real overlay) — indeterminate, F-obscured (was F, submitted)', (rel) => {
    const frame = read(rel);
    expect(opencodeBoxObscured(stripAnsi(frame).split('\n'))).toBe(true);
    expect(classifySubmitWithRule(frame, 'opencode', 'hello world')).toEqual({
      state: 'indeterminate',
      rule: 'F-obscured',
    });
  });

  it('negative: no other capture under tests/ has a cut border — the sidebar frames included', () => {
    const roots = [FIXTURES, path.resolve(__dirname, '../lib/detection/fixtures')];
    const obscured = roots
      .flatMap((root) =>
        capturesUnder(path.relative(FIXTURES, root)).filter((rel) => {
          const lines = stripAnsi(read(rel)).split('\n');
          return opencodeBoxObscured(lines);
        })
      )
      .map((rel) => path.normalize(rel))
      .sort();
    expect(obscured).toEqual(OBSCURED_CAPTURES.map((rel) => path.normalize(rel)).sort());
    for (const rel of SIDEBAR_FRAMES) expect(opencodeBoxObscured(stripAnsi(read(rel)).split('\n'))).toBe(false);
  });

  it('negative: a whole box beside the sidebar — still B-empty, and not marked obscured', () => {
    expect(composerOf(TURN_COMPLETE_W200)).toEqual({ kind: 'empty' });
    expect(classifySubmitWithRule(TURN_COMPLETE_W200, 'opencode', 'hello world').rule).toBe('B-empty');
  });

  it('no box on screen — not obscured', () => {
    expect(opencodeBoxObscured(['dev@host % opencode', ''])).toBe(false);
  });
});

describe('opencode: the send when an overlay covers the box after Enter (review of #4067)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetInstanceInputLocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetInstanceInputLocks();
  });

  /**
   * The ready frame until the first Enter, `after` on every read from then on.
   * `keysAfterEnter` is every key, paste and clear sent to the pane after that
   * first Enter.
   */
  async function sendWithFrameAfterEnter(
    after: string,
    message = 'hello world'
  ): Promise<{ error: Error | undefined; enters: number; keysAfterEnter: string[] }> {
    let enters = 0;
    const keysAfterEnter: string[] = [];
    vi.mocked(sendSpecialKeys).mockImplementation((async (_s: string, k: string[]) => {
      if (enters > 0) keysAfterEnter.push(k.join('+'));
      if (k.includes('Enter')) enters++;
    }) as never);
    vi.mocked(sendKeys).mockImplementation((async (_s: string, text: string) => {
      if (enters > 0) keysAfterEnter.push(`type:${text}`);
    }) as never);
    vi.mocked(clearInputLine).mockImplementation((async () => {
      if (enters > 0) keysAfterEnter.push('clearInputLine');
    }) as never);
    vi.mocked(clearComposerLine).mockImplementation((async () => {
      if (enters > 0) keysAfterEnter.push('clearComposerLine');
    }) as never);
    vi.mocked(capturePane).mockImplementation((async () => (enters > 0 ? after : TURN_COMPLETE_W200)) as never);
    const settled = sendMessageWithSubmitVerification({
      sessionName: 'mcbd-opencode-wt',
      message,
      cliToolId: 'opencode',
    }).then(
      () => undefined,
      (error: Error) => error
    );
    await vi.runAllTimersAsync();
    return { error: await settled, enters, keysAfterEnter };
  }

  it('positive: a blank overlay stays over the box — not confirmed, and no second Enter', async () => {
    const { error, enters } = await sendWithFrameAfterEnter(underOverlay());
    expect(error?.message).toMatch(/could not be confirmed/);
    expect(enters).toBe(1);
    expect(clearInputLine).not.toHaveBeenCalled();
  });

  it.each([
    ['the body', 'hello world', 'hello world'],
    ['another slash command', '/statusline', '/status'],
    ['a paste token', '[Pasted text #1 +3 lines]', 'hello world'],
  ])('positive: %s left in the box under an overlay — not confirmed, and no key after the first Enter', async (_name, residue, message) => {
    const { error, enters, keysAfterEnter } = await sendWithFrameAfterEnter(underOverlay(residue), message);
    expect(error?.message).toMatch(/could not be confirmed/);
    expect(enters).toBe(1);
    expect(keysAfterEnter).toEqual([]);
  });

  it('control: the body left in a whole box — the Enter is resent (the double sees the keys)', async () => {
    const { keysAfterEnter } = await sendWithFrameAfterEnter(withBodyInBox(TURN_COMPLETE_W200, 'hello world'));
    expect(keysAfterEnter).toContain('Enter');
  });

  it('control: another slash command left in a whole box — the line is cleared (the double sees the clear)', async () => {
    const { error, keysAfterEnter } = await sendWithFrameAfterEnter(withBodyInBox(TURN_COMPLETE_W200, '/statusline'), '/status');
    expect(error?.message).toMatch(/replaced by a TUI autocompletion/);
    expect(keysAfterEnter).toContain('clearInputLine');
  });

  it('negative: the box comes back whole and empty after Enter — confirmed', async () => {
    const { error, enters } = await sendWithFrameAfterEnter(TURN_COMPLETE_W200);
    expect(error).toBeUndefined();
    expect(enters).toBe(1);
  });
});
