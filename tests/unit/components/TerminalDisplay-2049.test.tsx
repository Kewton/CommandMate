/**
 * Issue #2049: `TerminalDisplay` renders opencode's compacted frame without
 * dropping the composer, the approval dialog or the palette panel.
 *
 * The rule itself is covered in `tests/unit/lib/`; what is pinned here is the
 * wiring — that `preservePaintedPanelRows` reaches the normalizer, that it is
 * inert without `compactTuiLayoutPadding`, and that what actually lands in the
 * DOM is the compacted text.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { render, cleanup } from '@testing-library/react';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';
import { normalizeOpencodeTerminalOutputForDisplay } from '@/lib/terminal-display-normalize';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const frame2049 = (name: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/opencode-live-2049', `${name}.txt`), 'utf-8');

/** Count rendered display lines via the <br> separators sanitize emits for '\n'. */
const renderedLineCount = (log: HTMLElement): number =>
  log.querySelectorAll('br').length + 1;

const logOf = (container: HTMLElement): HTMLElement =>
  container.querySelector('[role="log"]') as HTMLElement;

describe('Issue #2049: TerminalDisplay with preservePaintedPanelRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the 1.18.22 idle frame byte-for-byte when compaction is off', () => {
    const raw = frame2049('boot-idle-11822');
    const { container } = render(<TerminalDisplay output={raw} isActive={true} />);
    // 201 rows in the capture → 200 <br> separators.
    expect(renderedLineCount(logOf(container))).toBe(201);
  });

  it('collapses the 1.18.22 idle frame and keeps the composer', () => {
    const raw = frame2049('boot-idle-11822');
    const { container } = render(
      <TerminalDisplay output={raw} isActive={true} compactTuiLayoutPadding preservePaintedPanelRows />,
    );
    const log = logOf(container);
    expect(renderedLineCount(log)).toBeLessThan(20);
    expect(log.textContent).toContain('Ask anything...');
    expect(log.textContent).toContain('┃');
    expect(log.textContent).toContain('╹▀');
  });

  it('keeps the ctrl+p palette readable after compaction', () => {
    const raw = frame2049('command-palette-11822');
    const { container } = render(
      <TerminalDisplay output={raw} isActive={true} compactTuiLayoutPadding preservePaintedPanelRows />,
    );
    const log = logOf(container);
    expect(renderedLineCount(log)).toBeLessThan(70);
    expect(log.textContent).toContain('Commands');
    expect(log.textContent).toContain('Switch model');
    expect(log.textContent).toContain('Connect provider');
    // The composer is still on screen underneath the overlay.
    expect(log.textContent).toContain('┃');
  });

  it.each(['boot-idle-11822', 'two-turn-idle-11822', 'command-palette-11822'])(
    '%s renders exactly the panel-aware normalizer output',
    (name) => {
      // Pins the component to the right normalizer rather than to "some smaller
      // number of rows": swapping it for the Issue #1172 one changes this count.
      const raw = frame2049(name);
      const { container } = render(
        <TerminalDisplay
          output={raw}
          isActive={true}
          compactTuiLayoutPadding
          preservePaintedPanelRows
        />,
      );
      const expected = normalizeOpencodeTerminalOutputForDisplay(raw).split('\n').length;
      expect(renderedLineCount(logOf(container))).toBe(expected);
    },
  );

  it('renders MORE rows with the panel flag than without it', () => {
    // The positive control at the component level: if the flag were dropped on
    // the way through, the two renders would be identical.
    const raw = frame2049('command-palette-11822');
    const withFlag = render(
      <TerminalDisplay output={raw} isActive={true} compactTuiLayoutPadding preservePaintedPanelRows />,
    );
    const withCount = renderedLineCount(logOf(withFlag.container));
    cleanup();
    const without = render(
      <TerminalDisplay output={raw} isActive={true} compactTuiLayoutPadding />,
    );
    const withoutCount = renderedLineCount(logOf(without.container));
    expect(withCount).toBeGreaterThan(withoutCount);
  });

  it('is inert without compactTuiLayoutPadding', () => {
    const raw = frame2049('command-palette-11822');
    const { container } = render(
      <TerminalDisplay output={raw} isActive={true} preservePaintedPanelRows />,
    );
    expect(renderedLineCount(logOf(container))).toBe(201);
  });

  it('keeps every finished-turn transcript row of the two-turn frame', () => {
    const raw = frame2049('two-turn-idle-11822');
    const { container } = render(
      <TerminalDisplay output={raw} isActive={true} compactTuiLayoutPadding preservePaintedPanelRows />,
    );
    const text = logOf(container).textContent ?? '';
    expect(text).toContain('Now run the shell command: ls -la');
    expect(text).toContain('Create a new file probe.txt');
    expect(text).toContain('Build · Claude Sonnet 4.6');
  });

  it('still sanitizes and still styles in panel-aware mode', () => {
    const raw = ['A', '', '', '', '\x1b[31mError\x1b[0m', '<script>alert(1)</script>'].join('\n');
    const { container } = render(
      <TerminalDisplay output={raw} isActive={true} compactTuiLayoutPadding preservePaintedPanelRows />,
    );
    const log = logOf(container);
    expect(log.innerHTML).not.toContain('<script>');
    expect(log.textContent).toContain('Error');
    expect(log.innerHTML).toContain('style=');
  });
});
