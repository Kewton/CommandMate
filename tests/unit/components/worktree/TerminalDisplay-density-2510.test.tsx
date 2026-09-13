/**
 * TerminalDisplay `density` (Issue #2510).
 *
 * A `/sessions` tile shows a 200-column frame in ~940px. The frame keeps its own
 * columns (`wrapMode="frame"`, #2047) and the tile additionally sets it at the
 * compact density, so more of it is visible before the sideways scroll. What
 * this suite holds:
 *
 *  - the default is byte-for-byte the pre-#2510 class list (`text-sm`, `p-4`),
 *    which is what every worktree-screen caller still gets;
 *  - `compact` REPLACES the size rather than adding to it — `text-sm` and
 *    `text-xs` in one class list resolve by stylesheet order, so leaving the old
 *    one in would make the prop a no-op in a real browser while a `toContain`
 *    assertion stayed green;
 *  - `compact` composes with `frame`: the block still measures its width in `ch`
 *    (which follows the smaller font) and the log still scrolls sideways.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { TerminalDisplay } from '@/components/worktree/TerminalDisplay';

const logOf = (container: HTMLElement): HTMLElement =>
  container.querySelector('[role="log"]') as HTMLElement;

const bodyOf = (container: HTMLElement): HTMLElement =>
  logOf(container).firstElementChild as HTMLElement;

const classesOf = (element: HTMLElement): string[] => element.className.split(/\s+/);

/** A 200-column frame whose top rule spans the full pane, like claude's input box. */
const WIDE_FRAME = ['─'.repeat(200), '> hello', '─'.repeat(200), '  ? for shortcuts'].join('\n');

afterEach(() => {
  cleanup();
});

describe('Issue #2510: TerminalDisplay density', () => {
  it('keeps the regular size and padding by default', () => {
    const { container } = render(<TerminalDisplay output="hello" isActive />);
    const classes = classesOf(logOf(container));

    expect(classes).toContain('text-sm');
    expect(classes).toContain('p-4');
    expect(classes).not.toContain('text-xs');
    expect(classes).not.toContain('p-2');
  });

  it('is the same as the default when regular is passed explicitly', () => {
    const implicit = render(<TerminalDisplay output="hello" isActive />);
    const implicitClass = logOf(implicit.container).className;
    cleanup();

    const explicit = render(<TerminalDisplay output="hello" isActive density="regular" />);

    expect(logOf(explicit.container).className).toBe(implicitClass);
  });

  it('swaps in the compact size and padding instead of adding them', () => {
    const { container } = render(<TerminalDisplay output="hello" isActive density="compact" />);
    const classes = classesOf(logOf(container));

    expect(classes).toContain('text-xs');
    expect(classes).toContain('p-2');
    expect(classes).not.toContain('text-sm');
    expect(classes).not.toContain('p-4');
  });

  it('does not change how rows wrap on its own', () => {
    const { container } = render(<TerminalDisplay output={WIDE_FRAME} isActive density="compact" />);

    expect(bodyOf(container).className).toContain('whitespace-pre-wrap');
    expect(logOf(container).className).toContain('overflow-x-hidden');
  });

  it('composes with frame mode: the block keeps the frame width and the log scrolls sideways', () => {
    const { container } = render(
      <TerminalDisplay output={WIDE_FRAME} isActive wrapMode="frame" density="compact" />,
    );
    const body = bodyOf(container);
    const log = logOf(container);

    expect(body.className).toContain('whitespace-pre');
    expect(body.className).toContain('w-max');
    expect(body.style.minWidth).toBe('200ch');
    expect(log.className).toContain('overflow-x-auto');
    expect(log.className).not.toContain('overflow-x-hidden');
    expect(classesOf(log)).toContain('text-xs');
  });
});
