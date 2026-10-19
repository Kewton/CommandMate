/**
 * Issue #3809: the agy terminal pane renders a body, not 970 blank rows.
 *
 * The pane hands TerminalDisplay the full 1000-row capture and auto-follows to
 * the bottom. agy anchors its frame at the top, so without compaction the bottom
 * is all blank rows and nothing visible is left. jsdom does not scroll, so the
 * test asserts what the follow lands on: the LAST rendered row must be a body
 * row, and the blank tail must not be rendered.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { render, cleanup } from '@testing-library/react';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { getTerminalDisplayCompaction } from '@/config/terminal-display-compaction';
import type { CLIToolType } from '@/lib/cli-tools/types';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PICKER = path.join(
  REPO_ROOT,
  'tests/fixtures/prompt-observation-3797/antigravity-model-picker-1.4.2.txt',
);

const tmpDirs: string[] = [];
afterEach(() => {
  cleanup();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

/** Rows are `<br>`-separated in the rendered chunk, so mark them before reading text. */
const renderedRows = (container: HTMLElement): string[] => {
  const log = container.querySelector('[role="log"]');
  if (!log) return [];
  log.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  return (log.textContent ?? '').split('\n');
};

/** A synthetic 1000-row capture built in a temp dir: 3 body rows + blank tail. */
const syntheticCapture = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-3809-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'frame.txt');
  fs.writeFileSync(file, ['Switch Model', 'Search:', 'Keyboard: esc Go Back', ...Array(997).fill('')].join('\n'));
  return fs.readFileSync(file, 'utf-8');
};

describe('Issue #3809: antigravity pane compaction', () => {
  it('antigravity compacts layout padding', () => {
    expect(getTerminalDisplayCompaction('antigravity').compactTuiLayoutPadding).toBe(true);
  });

  it('positive: the real 1000-row picker frame ends on body text, with no blank tail', () => {
    const raw = fs.readFileSync(PICKER, 'utf-8');
    expect(raw.split('\n').length).toBeGreaterThanOrEqual(1000);
    const { container } = renderPane('antigravity', raw);
    const rows = renderedRows(container);
    expect(rows.join('\n')).toContain('Switch Model');
    expect(rows.length).toBeLessThan(100);
    expect(rows[rows.length - 1].trim()).not.toBe('');
  });

  it('positive: a synthetic frame (temp dir) loses its blank tail', () => {
    const { container } = renderPane('antigravity', syntheticCapture());
    const rows = renderedRows(container);
    expect(rows[rows.length - 1]).toContain('Keyboard');
    expect(rows.length).toBe(3);
  });

  it('negative: copilot (not compacted) still renders every row', () => {
    const { container } = renderPane('copilot', syntheticCapture());
    expect(renderedRows(container).length).toBeGreaterThan(900);
  });

  it('negative: claude still compacts the same frame', () => {
    const { container } = renderPane('claude', syntheticCapture());
    expect(renderedRows(container).length).toBe(3);
  });

  it.each([
    'src/components/worktree/TerminalSplitPaneContent.tsx',
    'src/components/sessions/SessionTile.tsx',
  ])('%s takes compaction from the shared policy', (relative) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8');
    expect(source).toContain('getTerminalDisplayCompaction(cliToolId)');
    expect(source).toContain('compactTuiLayoutPadding={compactTuiLayoutPadding}');
  });
});
