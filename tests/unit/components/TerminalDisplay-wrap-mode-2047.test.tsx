/**
 * Issue #2047: the phone stops re-wrapping opencode's pane in half.
 *
 * opencode's tmux pane is pinned to a fixed column count (`OPENCODE_PANE_WIDTH`,
 * 80) because opencode paints a right-hand sidebar into the transcript's own
 * rows at >=121 columns. Every row of the resulting frame is laid out against
 * that fixed width — the input box gutter, the permission dialog's button strip,
 * the footer — so re-wrapping it at ~50 columns of phone breaks each row in two
 * and the boxes stop being boxes.
 *
 * `wrapMode: 'frame'` gives the output block the frame's own measured width in
 * `ch` and lets the pane scroll sideways instead. **Display only**, like the
 * #1172 / #2049 compaction flags: `output` and everything downstream of it —
 * detection, Auto-Yes, response saving, transport — is untouched, and the width
 * is measured from the frame in hand rather than read from the tmux config, so
 * an operator's `CM_OPENCODE_PANE_WIDTH` reflows the phone with no plumbing.
 *
 * The policy lives in `config/terminal-display-compaction.ts` — the home #2049
 * created for exactly this, so PC and phone cannot drift apart again.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { render, cleanup } from '@testing-library/react';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import {
  getTerminalDisplayCompaction,
  measureTerminalFrameColumns,
} from '@/config/terminal-display-compaction';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const frame = (width: 80 | 120 | 200, name: string): string =>
  fs.readFileSync(
    path.join(REPO_ROOT, 'tests/fixtures/opencode-live-2047', `w${width}`, `${name}.txt`),
    'utf-8'
  );

const logOf = (container: HTMLElement): HTMLElement =>
  container.querySelector('[role="log"]') as HTMLElement;

/** The block the rendered chunks are written into — the one that carries the width. */
const bodyOf = (container: HTMLElement): HTMLElement =>
  logOf(container).firstElementChild as HTMLElement;

afterEach(() => {
  cleanup();
});

describe('Issue #2047: measureTerminalFrameColumns', () => {
  it('counts visible columns, not SGR bytes', () => {
    // `capture-pane -e` re-emits colour, and a heavily coloured 80-column row is
    // several hundred bytes. Counting bytes would make every opencode frame
    // measure "wide" and the feature would be nonsense.
    const coloured = '\x1b[38;2;255;255;255m\x1b[48;2;10;10;10mabcde\x1b[0m';
    expect(measureTerminalFrameColumns(coloured)).toBe(5);
  });

  it('ignores the background-painted padding opencode ends every row with', () => {
    // Without the trailing trim EVERY opencode frame measures exactly the pane
    // width, because opencode pads each row out with painted spaces — and the
    // measurement would stop being a measurement.
    expect(measureTerminalFrameColumns('ab' + ' '.repeat(78))).toBe(2);
  });

  it('takes the widest row and never returns zero', () => {
    expect(measureTerminalFrameColumns('a\nbbbb\ncc')).toBe(4);
    expect(measureTerminalFrameColumns('')).toBe(1);
    expect(measureTerminalFrameColumns('\n\n\n')).toBe(1);
  });

  it('caps a runaway row', () => {
    expect(measureTerminalFrameColumns('x'.repeat(5000))).toBe(400);
    expect(measureTerminalFrameColumns('x'.repeat(5000), 100)).toBe(100);
  });

  it('measures the live captures at the width they were taken at', () => {
    // Real frames, not constructed ones: each has to come back at (just under)
    // its own pane width, which is what makes the `ch` value meaningful.
    for (const width of [80, 120, 200] as const) {
      const measured = measureTerminalFrameColumns(frame(width, 'permission-bash'));
      expect(measured).toBeLessThanOrEqual(width);
      expect(measured).toBeGreaterThan(width - 20);
    }
  });
});

describe('Issue #2047: the mobile wrap policy has one home', () => {
  it('puts opencode in frame mode and leaves every other tool alone', () => {
    expect(getTerminalDisplayCompaction('opencode').mobileWrapMode).toBe('frame');
    for (const tool of ['claude', 'codex', 'copilot', 'gemini', 'vibe-local'] as const) {
      expect(
        getTerminalDisplayCompaction(tool).mobileWrapMode,
        `${tool} changed how it renders on a phone`
      ).toBe('viewport');
    }
  });

  it('does not disturb the #1172 / #2049 compaction flags', () => {
    // The same call now answers three questions. Adding the third must not have
    // moved the first two.
    expect(getTerminalDisplayCompaction('opencode')).toEqual({
      compactTuiLayoutPadding: true,
      preservePaintedPanelRows: true,
      mobileWrapMode: 'frame',
    });
    expect(getTerminalDisplayCompaction('claude')).toEqual({
      compactTuiLayoutPadding: true,
      preservePaintedPanelRows: false,
      mobileWrapMode: 'viewport',
    });
    expect(getTerminalDisplayCompaction('copilot')).toEqual({
      compactTuiLayoutPadding: false,
      preservePaintedPanelRows: false,
      mobileWrapMode: 'viewport',
    });
  });
});

describe('Issue #2047: TerminalDisplay honours wrapMode', () => {
  it('re-wraps at the viewport by default, exactly as before', () => {
    const { container } = render(
      <TerminalDisplay output={frame(80, 'permission-bash')} isActive />
    );
    const body = bodyOf(container);
    expect(body.className).toContain('whitespace-pre-wrap');
    expect(body.className).toContain('break-words');
    expect(body.style.minWidth).toBe('');
    expect(logOf(container).className).toContain('overflow-x-hidden');
  });

  it('gives the block the frame width and a sideways scroll in frame mode', () => {
    const raw = frame(80, 'permission-bash');
    const { container } = render(
      <TerminalDisplay output={raw} isActive wrapMode="frame" />
    );
    const body = bodyOf(container);

    expect(body.className).toContain('whitespace-pre');
    expect(body.className).not.toContain('whitespace-pre-wrap');
    // The number is the frame's, so a change to CM_OPENCODE_PANE_WIDTH follows
    // automatically without the browser knowing the variable exists.
    expect(body.style.minWidth).toBe(`${measureTerminalFrameColumns(raw)}ch`);
    expect(logOf(container).className).toContain('overflow-x-auto');
    expect(logOf(container).className).not.toContain('overflow-x-hidden');
  });

  it('tracks the width of whatever frame it is handed', () => {
    // Same component, three real captures: the `ch` value has to move with them,
    // otherwise it is a constant wearing a measurement's clothes.
    const widths = ([80, 120, 200] as const).map((w) => {
      const { container } = render(
        <TerminalDisplay output={frame(w, 'permission-bash')} isActive wrapMode="frame" />
      );
      const value = Number(bodyOf(container).style.minWidth.replace('ch', ''));
      cleanup();
      return value;
    });

    expect(widths[0]).toBeLessThan(widths[1]);
    expect(widths[1]).toBeLessThan(widths[2]);
  });

  it('measures the COMPACTED text when compaction is on', () => {
    // Compaction removes whole rows, never columns, so the answer should be the
    // same either way — asserted rather than assumed, because measuring the raw
    // string while rendering the compacted one is the kind of mismatch that only
    // shows up as a scrollbar that stops one row short.
    const raw = frame(80, 'boot-idle');
    const { container } = render(
      <TerminalDisplay
        output={raw}
        isActive
        wrapMode="frame"
        compactTuiLayoutPadding
        preservePaintedPanelRows
      />
    );
    expect(bodyOf(container).style.minWidth).toBe(`${measureTerminalFrameColumns(raw)}ch`);
  });

  it('changes nothing about the text that reaches the DOM', () => {
    // Display only. The same frame renders the same rows in both modes; only the
    // box around them differs.
    const raw = frame(80, 'permission-bash');
    const wrapped = render(<TerminalDisplay output={raw} isActive />);
    const wrappedText = logOf(wrapped.container).textContent;
    cleanup();
    const framed = render(<TerminalDisplay output={raw} isActive wrapMode="frame" />);
    expect(logOf(framed.container).textContent).toBe(wrappedText);
    expect(logOf(framed.container).textContent).toContain('Allow once');
  });
});
