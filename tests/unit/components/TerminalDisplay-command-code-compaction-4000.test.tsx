/**
 * Issue #4000: the Command Code terminal pane renders the plan review, not 825
 * blank rows.
 *
 * Same shape as #3809 (agy): Command Code anchors its frame at the top of the
 * 200x1000 pane, the pane auto-follows to the bottom, and without compaction the
 * bottom is all blank rows. jsdom does not scroll, so the test asserts what the
 * follow lands on: the LAST rendered row.
 *
 * Unlike agy, Command Code also paints visually-blank rows with a background
 * colour — the top and bottom bands of its logo banner (`ESC[48;5;60m` + 70
 * spaces). The banner's top band is the frame's first row, so the #1172 rule
 * reads it as leading padding and drops it. The painted-row controls below run
 * the real boot / picker / question captures through the normalizer the policy
 * selects, the same way `TerminalDisplay` does.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { render, cleanup } from '@testing-library/react';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import {
  getTerminalDisplayCompaction,
  measureTerminalFrameColumns,
} from '@/config/terminal-display-compaction';
import { normalizeTerminalOutputForDisplay } from '@/lib/terminal/terminal-display-normalizer';
import {
  isPaintedPanelRow,
  normalizeOpencodeTerminalOutputForDisplay,
} from '@/lib/terminal-display-normalize';
import { stripAnsi } from '@/lib/detection/ansi';
import type { CLIToolType } from '@/lib/cli-tools/types';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const FIXTURES = path.join(REPO_ROOT, 'tests/fixtures');
const PLAN_REVIEW = path.join(
  FIXTURES,
  'command-code-plan-review-4000/plan-review-top-anchored-200x1000.txt',
);

/** Raw (ANSI) captures that carry background-painted blank rows. */
const PAINTED_CAPTURES = [
  'command-code-live-2250/boot-idle-1490.txt',
  'command-code-live-2250/boot-idle.txt',
  'command-code-live-2250/dialog-shell-1490.txt',
  'chat-dialog-card-2254/command-code-model-1-47-1-open.txt',
  'command-code-askuserquestion-2754/multiselect-initial.txt',
] as const;

const tmpDirs: string[] = [];
afterEach(() => {
  cleanup();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const read = (relative: string): string => fs.readFileSync(path.join(FIXTURES, relative), 'utf-8');

/** Render the way the PC pane and the tile do: policy from the config module. */
const renderPane = (tool: CLIToolType, output: string) => {
  const { compactTuiLayoutPadding, preservePaintedPanelRows } = getTerminalDisplayCompaction(tool);
  return render(
    <TerminalDisplay
      output={output}
      isActive
      compactTuiLayoutPadding={compactTuiLayoutPadding}
      preservePaintedPanelRows={preservePaintedPanelRows}
    />,
  );
};

/** What `TerminalDisplay` hands its renderer for this tool, ANSI intact. */
const displayed = (tool: CLIToolType, raw: string): string => {
  const { compactTuiLayoutPadding, preservePaintedPanelRows } = getTerminalDisplayCompaction(tool);
  if (!compactTuiLayoutPadding) return raw;
  return preservePaintedPanelRows
    ? normalizeOpencodeTerminalOutputForDisplay(raw)
    : normalizeTerminalOutputForDisplay(raw);
};

/** Rows are `<br>`-separated in the rendered chunk, so mark them before reading text. */
const renderedRows = (container: HTMLElement): string[] => {
  const log = container.querySelector('[role="log"]');
  if (!log) return [];
  log.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  return (log.textContent ?? '').split('\n');
};

const isGlyphRow = (line: string): boolean => stripAnsi(line).trim() !== '';

/** A synthetic 1000-row capture built in a temp dir: 3 body rows + blank tail. */
const syntheticCapture = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-4000-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'frame.txt');
  fs.writeFileSync(
    file,
    [' REVIEW', 'Approve ctrl+a   executes the plan', 'Cancel esc', ...Array(997).fill('')].join('\n'),
  );
  return fs.readFileSync(file, 'utf-8');
};

describe('Issue #4000: command-code pane compaction', () => {
  it('command-code compacts layout padding and keeps painted rows', () => {
    expect(getTerminalDisplayCompaction('command-code')).toMatchObject({
      compactTuiLayoutPadding: true,
      preservePaintedPanelRows: true,
    });
  });

  it('the plan review fixture is a top-anchored 200x1000 frame', () => {
    const raw = fs.readFileSync(PLAN_REVIEW, 'utf-8');
    const lines = raw.replace(/\n$/, '').split('\n');
    expect(lines.length).toBe(1000);
    expect(measureTerminalFrameColumns(raw)).toBe(200);
    const lastContent = lines.map(isGlyphRow).lastIndexOf(true);
    expect(lastContent).toBe(174);
  });

  it('positive: the top-anchored plan review ends on the REVIEW footer, with no blank tail', () => {
    const { container } = renderPane('command-code', fs.readFileSync(PLAN_REVIEW, 'utf-8'));
    const rows = renderedRows(container);
    expect(rows.length).toBe(175);
    expect(rows[rows.length - 1]).toMatch(/^type \+ enter to comment/);
    const text = rows.join('\n');
    for (const footer of [' REVIEW', 'Approve ctrl+a', 'Cancel esc']) expect(text).toContain(footer);
  });

  it('positive: a synthetic frame (temp dir) loses its blank tail', () => {
    const { container } = renderPane('command-code', syntheticCapture());
    const rows = renderedRows(container);
    expect(rows.length).toBe(3);
    expect(rows[rows.length - 1]).toBe('Cancel esc');
  });

  it('control: without compaction the same frame keeps its blank tail', () => {
    const { container } = render(
      <TerminalDisplay output={fs.readFileSync(PLAN_REVIEW, 'utf-8')} isActive />,
    );
    const rows = renderedRows(container);
    expect(rows.length).toBeGreaterThan(900);
    expect(rows[rows.length - 1].trim()).toBe('');
  });

  it('negative: copilot (not compacted) still renders every row', () => {
    const { container } = renderPane('copilot', syntheticCapture());
    expect(renderedRows(container).length).toBeGreaterThan(900);
  });

  it('negative: claude still compacts the same frame', () => {
    const { container } = renderPane('claude', syntheticCapture());
    expect(renderedRows(container).length).toBe(3);
  });
});

describe('Issue #4000: painted rows, glyph rows and ANSI survive on real captures', () => {
  it.each(PAINTED_CAPTURES)('%s keeps every painted row, every glyph row, byte-for-byte', (name) => {
    const raw = read(name);
    const rawLines = raw.split('\n');
    const out = displayed('command-code', raw).split('\n');

    // The corpus is the control: each capture really has painted bands.
    const painted = rawLines.filter(isPaintedPanelRow);
    expect(painted.length).toBeGreaterThan(0);
    expect(out.filter(isPaintedPanelRow)).toEqual(painted);

    // Glyph rows: same rows, same order, ANSI included.
    expect(out.filter(isGlyphRow)).toEqual(rawLines.filter(isGlyphRow));
    expect(out.some((line) => line.includes('\x1b['))).toBe(true);

    // And the blank tail is gone.
    expect(out.length).toBeLessThan(rawLines.length);
    expect(isGlyphRow(out[out.length - 1])).toBe(true);
  });

  it('control: the #1172 rule alone drops the banner top band of the boot frame', () => {
    const raw = read('command-code-live-2250/boot-idle-1490.txt');
    expect(isPaintedPanelRow(raw.split('\n')[0])).toBe(true);
    const plain = normalizeTerminalOutputForDisplay(raw).split('\n');
    expect(plain.filter(isPaintedPanelRow).length).toBeLessThan(
      raw.split('\n').filter(isPaintedPanelRow).length,
    );
  });
});
