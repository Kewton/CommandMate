/**
 * The two-row composer and its height handle (Issue #2598).
 *
 * jsdom has no layout, so what is measured — widths, the height budget, the
 * handle moving the textarea — lives in `tests/e2e/composer-two-row-2598.spec.ts`.
 * This file pins the structure those measurements depend on, and the rules that
 * are not about pixels:
 *
 * 1. **One toolbar, above the textarea, on both layouts.** The PC used to put
 *    every control on the textarea's own row; the phone already had the
 *    toolbar. Each control is now mounted once.
 * 2. **The phone is unchanged.** Slash button first, interrupt button in line
 *    with the rest (no right-aligned wrapper), no handle, no stored height.
 * 3. **`@container` stays where #2597 put it**, as an ancestor of the mode
 *    control, and the hints get a container of their own.
 * 4. **The handle only where it was asked for.** A PC composer with a
 *    `heightScope` draws it; one without (the phone's docked composer never
 *    passes one) draws nothing and reads nothing.
 * 5. **A stored height wins over auto-grow**, loses its `maxHeight: 160px`
 *    cap, survives a send, and is dropped by a double-click on the handle.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import {
  createDefaultProps,
  getTextarea,
  mockCommandGroups,
  typeMessage,
} from '@tests/helpers/message-input-test-utils';
import { getComposerHeightStorageKey } from '@/hooks/useComposerHeight';
import {
  COMPOSER_MIN_HEIGHT_PX,
  SESSION_TILE_COMPOSER_HEIGHT_SCOPE,
  composerHeightScopeForSplit,
} from '@/config/composer-height';
import { COMPOSER_HINTS_MIN_CONTAINER_PX } from '@/config/composer-layout';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

vi.mock('@/lib/api-client', () => ({
  worktreeApi: {
    sendMessage: vi.fn().mockResolvedValue({}),
    uploadImageFile: vi.fn().mockResolvedValue({ path: '.commandmate/attachments/test.png' }),
  },
  handleApiError: vi.fn((err: Error) => err?.message || 'Unknown error'),
}));

vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: vi.fn(() => ({ groups: mockCommandGroups, isCatalogStale: false })),
}));

let mockIsMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => mockIsMobile),
}));

const SPLIT_0 = composerHeightScopeForSplit(0);
const RESIZE_LABEL = /Resize the message box/;

function toolbar(): HTMLElement {
  return screen.getByTestId('composer-toolbar');
}

function testIdsIn(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('[data-testid]')).map(
    node => node.getAttribute('data-testid') ?? '',
  );
}

const modeSlot = <div data-testid="fake-agent-mode">mode</div>;

let originalScrollHeight: PropertyDescriptor | undefined;
function mockScrollHeight(value: number) {
  originalScrollHeight ??= Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => value });
}
afterEach(() => {
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  originalScrollHeight = undefined;
});

describe('MessageInput two-row layout (Issue #2598)', () => {
  const defaultProps = createDefaultProps();

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile = false;
    window.localStorage.clear();
  });

  describe('PC', () => {
    it('puts the toolbar in a row of its own, above the textarea row', () => {
      render(<MessageInput {...defaultProps} agentModeSlot={modeSlot} />);
      const row = screen.getByTestId('composer-input-row');
      const children = Array.from(row.children).map(c => c.getAttribute('data-testid'));
      expect(children).toEqual(['composer-toolbar', 'composer-textarea-row']);

      const textareaRow = screen.getByTestId('composer-textarea-row');
      expect(within(textareaRow).getByTestId('message-input-textarea')).toBeInTheDocument();
      expect(within(textareaRow).getByTestId('send-message-button')).toBeInTheDocument();
      // Nothing but the textarea and the send button shares the textarea's row.
      expect(textareaRow.children).toHaveLength(2);
    });

    it('orders the toolbar [attach][mode] … [interrupt], with the interrupt held at the right end', () => {
      render(<MessageInput {...defaultProps} agentModeSlot={modeSlot} />);
      const groups = Array.from(toolbar().children).map(c => c.getAttribute('data-testid'));
      expect(groups).toEqual(['composer-toolbar-start', 'composer-toolbar-end']);

      const start = screen.getByTestId('composer-toolbar-start');
      expect(testIdsIn(start).filter(id => id !== 'interrupt-button')).toEqual(
        expect.arrayContaining(['attach-image-button', 'fake-agent-mode']),
      );
      expect(testIdsIn(start).indexOf('attach-image-button')).toBeLessThan(
        testIdsIn(start).indexOf('fake-agent-mode'),
      );
      // The start group takes the free width (pushing the end group right) and
      // scrolls what does not fit; the end group never shrinks.
      const startClasses = start.className.split(/\s+/);
      expect(startClasses).toEqual(expect.arrayContaining(['flex-1', 'min-w-0', 'overflow-x-auto']));
      const end = screen.getByTestId('composer-toolbar-end');
      expect(end.className.split(/\s+/)).toContain('flex-shrink-0');
      expect(within(end).getByTestId('interrupt-button')).toBeInTheDocument();
      // No slash button on a PC: `/` opens the selector, and the hint says so.
      expect(screen.queryByTestId('mobile-command-button')).toBeNull();
    });

    it('bottom-aligns the send button with a tall textarea, and never wraps the Auto-Yes label', () => {
      render(<MessageInput {...defaultProps} autoYesSlot={<span>auto</span>} />);
      expect(screen.getByTestId('composer-textarea-row').className).toContain('items-end');
      expect(screen.getByTestId('composer-auto-yes').className).toContain('whitespace-nowrap');
    });

    it('mounts each control exactly once', () => {
      render(<MessageInput {...defaultProps} agentModeSlot={modeSlot} />);
      expect(screen.getAllByTestId('attach-image-button')).toHaveLength(1);
      expect(screen.getAllByTestId('interrupt-button')).toHaveLength(1);
      expect(screen.getAllByTestId('fake-agent-mode')).toHaveLength(1);
      expect(screen.getAllByTestId('message-input-textarea')).toHaveLength(1);
    });

    it('keeps #2597’s query container as an ancestor of the mode control', () => {
      render(<MessageInput {...defaultProps} agentModeSlot={modeSlot} />);
      const row = screen.getByTestId('composer-input-row');
      expect(row.className.split(/\s+/)).toContain('@container');
      expect(row.contains(screen.getByTestId('fake-agent-mode'))).toBe(true);
      // The row itself is a column, so its width is the composer's, as before.
      expect(row.className).toContain('flex-col');
    });

    it('hides the hints below the container threshold, and never lets them wrap', () => {
      render(<MessageInput {...defaultProps} />);
      const meta = screen.getByTestId('composer-meta-row');
      expect(meta.className.split(/\s+/)).toContain('@container');
      const hints = screen.getByTestId('composer-hints');
      const classes = hints.className.split(/\s+/);
      expect(classes).toContain('hidden');
      // The literal must match the constant (Tailwind cannot see an interpolation).
      expect(classes).toContain(`@min-[${COMPOSER_HINTS_MIN_CONTAINER_PX}px]:flex`);
      expect(classes).toContain('whitespace-nowrap');
    });
  });

  describe('phone (unchanged)', () => {
    beforeEach(() => {
      mockIsMobile = true;
    });

    it('keeps [slash][attach][mode][interrupt] in line, with no right-aligned wrapper', () => {
      render(<MessageInput {...defaultProps} agentModeSlot={modeSlot} />);
      const bar = toolbar();
      const direct = Array.from(bar.children).map(c => c.getAttribute('data-testid'));
      expect(direct).toEqual([
        'mobile-command-button',
        'attach-image-button',
        'fake-agent-mode',
        'interrupt-button',
      ]);
      expect(screen.queryByTestId('composer-toolbar-start')).toBeNull();
      expect(screen.queryByTestId('composer-toolbar-end')).toBeNull();
      expect(screen.getByTestId('composer-textarea-row').className).toContain('items-center');
    });

    it('keeps the meta row a plain row (Auto-Yes only, no hints, no container)', () => {
      render(<MessageInput {...defaultProps} autoYesSlot={<span>auto</span>} />);
      const meta = screen.getByTestId('composer-meta-row');
      expect(meta.className.split(/\s+/)).not.toContain('@container');
      expect(screen.queryByTestId('composer-hints')).toBeNull();
      expect(screen.getByTestId('composer-auto-yes').className).not.toContain('whitespace-nowrap');
    });

    it('draws no handle and applies no stored height, even when given a scope', () => {
      window.localStorage.setItem(getComposerHeightStorageKey('test-worktree', SPLIT_0), '300');
      render(<MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} />);
      expect(screen.queryByTestId('composer-resize-handle')).toBeNull();
      expect(screen.queryByRole('separator')).toBeNull();
      const textarea = getTextarea();
      expect(textarea.style.height).toBe(`${COMPOSER_MIN_HEIGHT_PX}px`);
      expect(textarea.style.maxHeight).toBe('160px');
    });
  });

  describe('height handle (PC)', () => {
    it('is not drawn without a scope', () => {
      render(<MessageInput {...defaultProps} />);
      expect(screen.queryByTestId('composer-resize-handle')).toBeNull();
      expect(screen.queryByRole('separator')).toBeNull();
    });

    it('is drawn with a scope, as a vertical separator with its own name', () => {
      render(<MessageInput {...defaultProps} heightScope={SPLIT_0} />);
      const handle = screen.getByRole('separator', { name: RESIZE_LABEL });
      expect(handle).toHaveAttribute('aria-orientation', 'vertical');
      expect(screen.getByTestId('composer-resize-handle')).toHaveAttribute('data-height-mode', 'auto');
    });

    it('auto-grows as before while nothing is stored', () => {
      render(<MessageInput {...defaultProps} heightScope={SPLIT_0} />);
      const textarea = getTextarea();
      // Empty: one line, written as the same 36px `minHeight` enforces.
      expect(textarea.style.height).toBe('36px');
      expect(textarea.style.minHeight).toBe('36px');
      expect(textarea.style.maxHeight).toBe('160px');
    });

    it('applies the stored value as a floor, with maxHeight set to max(floor, 160)', () => {
      window.localStorage.setItem(getComposerHeightStorageKey('test-worktree', SPLIT_0), '300');
      window.localStorage.setItem(
        getComposerHeightStorageKey('test-worktree', SESSION_TILE_COMPOSER_HEIGHT_SCOPE),
        '90',
      );
      render(<MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} />);
      const textarea = getTextarea();
      expect(textarea.style.height).toBe('300px');
      expect(textarea.style.maxHeight).toBe('300px');
      expect(screen.getByTestId('composer-resize-handle')).toHaveAttribute('data-height-mode', 'floor');
    });

    it('draws a stored height no taller than maxHeight, and keeps what is stored', () => {
      const key = getComposerHeightStorageKey('test-worktree', SPLIT_0);
      window.localStorage.setItem(key, '300');
      const { rerender } = render(
        <MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} maxHeight={120} />,
      );
      expect(getTextarea().style.height).toBe('120px');
      expect(window.localStorage.getItem(key)).toBe('300');

      rerender(
        <MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} maxHeight={500} />,
      );
      expect(getTextarea().style.height).toBe('300px');
    });

    it('grows when pulled up or on ArrowUp, lowers floor on ArrowDown, and stores it', () => {
      const key = getComposerHeightStorageKey('test-worktree', SPLIT_0);
      window.localStorage.setItem(key, '100');
      render(
        <MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} maxHeight={400} />,
      );
      const handle = screen.getByRole('separator', { name: RESIZE_LABEL });

      // Pull up by 30px: mousedown at y=200, move to y=170.
      fireEvent.mouseDown(handle, { clientX: 0, clientY: 200 });
      fireEvent.mouseMove(document, { clientX: 0, clientY: 170 });
      fireEvent.mouseUp(document);
      expect(getTextarea().style.height).toBe('130px');
      expect(window.localStorage.getItem(key)).toBe('130');

      fireEvent.keyDown(handle, { key: 'ArrowUp' });
      expect(getTextarea().style.height).toBe('140px');
      fireEvent.keyDown(handle, { key: 'ArrowDown' });
      fireEvent.keyDown(handle, { key: 'ArrowDown' });
      // Floor lowers by 20px
      expect(getTextarea().style.height).toBe('120px');
      expect(window.localStorage.getItem(key)).toBe('120');
    });

    it('shrinks to the stored floor after a send empties the composer', async () => {
      window.localStorage.setItem(getComposerHeightStorageKey('test-worktree', SPLIT_0), '120');
      render(<MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} />);
      typeMessage('hello');
      fireEvent.click(screen.getByTestId('send-message-button'));
      await waitFor(() => expect(getTextarea()).toHaveValue(''));
      expect(getTextarea().style.height).toBe('120px');
    });

    it('returns to auto-grow on a double-click, and forgets the stored height', () => {
      const key = getComposerHeightStorageKey('test-worktree', SPLIT_0);
      window.localStorage.setItem(key, '200');
      render(<MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} />);
      fireEvent.doubleClick(screen.getByRole('separator', { name: RESIZE_LABEL }));
      expect(window.localStorage.getItem(key)).toBeNull();
      expect(getTextarea().style.height).toBe('36px');
      expect(getTextarea().style.maxHeight).toBe('160px');
      expect(screen.getByTestId('composer-resize-handle')).toHaveAttribute('data-height-mode', 'auto');
    });

    it('ignores a corrupted stored value', () => {
      window.localStorage.setItem(getComposerHeightStorageKey('test-worktree', SPLIT_0), 'huge');
      render(<MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} />);
      expect(getTextarea().style.height).toBe('36px');
      expect(screen.getByTestId('composer-resize-handle')).toHaveAttribute('data-height-mode', 'auto');
    });

    it('shrinks to the floor when input content is shorter than the floor', () => {
      window.localStorage.setItem(getComposerHeightStorageKey('test-worktree', SPLIT_0), '120');
      render(<MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} />);
      typeMessage('one line');
      expect(getTextarea().style.height).toBe('120px');
    });

    it('grows with content when input is longer than the floor', () => {
      window.localStorage.setItem(getComposerHeightStorageKey('test-worktree', SPLIT_0), '60');
      mockScrollHeight(100);
      render(<MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} />);
      typeMessage('longer message');
      expect(getTextarea().style.height).toBe('100px');
    });

    it('does not grow beyond the auto max height (160px)', () => {
      window.localStorage.setItem(getComposerHeightStorageKey('test-worktree', SPLIT_0), '60');
      mockScrollHeight(400);
      render(<MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} />);
      typeMessage('very long message');
      expect(getTextarea().style.height).toBe('160px');
    });

    it('clamps both drawn height and CSS maxHeight with caller maxHeight', () => {
      window.localStorage.setItem(getComposerHeightStorageKey('test-worktree', SPLIT_0), '60');
      mockScrollHeight(400);
      render(
        <MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} maxHeight={120} />,
      );
      typeMessage('very long message');
      const textarea = getTextarea();
      expect(textarea.style.height).toBe('120px');
      expect(textarea.style.maxHeight).toBe('120px');
    });

    it('updates drawn height when maxHeight changes', () => {
      window.localStorage.setItem(getComposerHeightStorageKey('test-worktree', SPLIT_0), '60');
      mockScrollHeight(400);
      const { rerender } = render(
        <MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} maxHeight={120} />,
      );
      typeMessage('very long message');
      expect(getTextarea().style.height).toBe('120px');

      rerender(
        <MessageInput {...defaultProps} worktreeId="test-worktree" heightScope={SPLIT_0} maxHeight={200} />,
      );
      expect(getTextarea().style.height).toBe('160px');
    });
  });
});
