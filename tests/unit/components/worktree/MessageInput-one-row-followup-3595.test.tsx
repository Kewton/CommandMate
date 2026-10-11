/**
 * Issue #3595, second pass (consistency review):
 *
 * 1. **The textarea re-fits when only its width changes.** In one row the
 *    textarea shares its line with the Auto-Yes toggle, which grows by its
 *    countdown when Auto-Yes is turned on; a split resize does the same. The
 *    height was computed on `message` / floor / bound changes only, so a draft
 *    one word short of wrapping wrapped and scrolled inside a one-line box.
 *    The stored floor and the caller's bound still hold.
 * 2. **The hints hidden by the one-row layout have a way in from the
 *    keyboard.** A focusable button (only drawn in one row) opens the existing
 *    focus-opening Tooltip and names the hints in its `aria-label`; the
 *    two-row layout keeps the hints drawn as before and has no such button.
 *
 * jsdom has no layout: the width change is a ResizeObserver callback with a
 * new `contentRect.width`, and `scrollHeight` is mocked.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MessageInput } from '@/components/worktree/MessageInput';
import {
  createDefaultProps,
  getTextarea,
  mockCommandGroups,
} from '@tests/helpers/message-input-test-utils';
import { composerHeightScopeForSplit } from '@/config/composer-height';
import { COMPOSER_ONE_ROW_MIN_CONTAINER_PX } from '@/config/composer-layout';
import { getComposerHeightStorageKey } from '@/hooks/useComposerHeight';

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

const V = `@min-[${COMPOSER_ONE_ROW_MIN_CONTAINER_PX}px]:`;
const SPLIT_0 = composerHeightScopeForSplit(0);
const HINTS = '/ commands · Shift+Enter newline';

// --- ResizeObserver: record what is observed, fire on demand -----------------

type Observed = { target: Element; observer: FakeResizeObserver };
const observed: Observed[] = [];

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    observed.push({ target, observer: this });
  }
  unobserve(target: Element) {
    const i = observed.findIndex(o => o.target === target && o.observer === this);
    if (i >= 0) observed.splice(i, 1);
  }
  disconnect() {
    for (let i = observed.length - 1; i >= 0; i -= 1) if (observed[i].observer === this) observed.splice(i, 1);
  }
  fire(target: Element, width: number) {
    this.callback(
      [{ target, contentRect: { width, height: 0 } as DOMRectReadOnly } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

/** Report a new width for the textarea to whoever observes it. */
function resizeTextarea(width: number): void {
  const textarea = getTextarea();
  const watchers = observed.filter(o => o.target === textarea);
  expect(watchers.length, 'the textarea is observed').toBeGreaterThan(0);
  act(() => {
    for (const o of watchers) o.observer.fire(textarea, width);
  });
}

let scrollHeight = 36;
let originalScrollHeight: PropertyDescriptor | undefined;
let originalResizeObserver: typeof ResizeObserver | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mockIsMobile = false;
  window.localStorage.clear();
  observed.length = 0;
  scrollHeight = 36;
  originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
});

function renderComposer(extra: Record<string, unknown> = {}) {
  return render(
    <MessageInput
      {...createDefaultProps()}
      heightScope={SPLIT_0}
      autoYesSlot={<span>auto</span>}
      oneRowWhenWide
      {...extra}
    />,
  );
}

function type(value: string): void {
  fireEvent.change(getTextarea(), { target: { value } });
}

describe('[#3595] the textarea re-fits when its width changes', () => {
  it('grows when a narrower line makes the draft wrap (Auto-Yes turned on)', () => {
    renderComposer();
    resizeTextarea(400);
    type('a draft one word short of wrapping');
    expect(getTextarea().style.height).toBe('36px');

    // Auto-Yes on: the countdown takes width from the textarea, the draft
    // wraps onto a second line.
    scrollHeight = 56;
    resizeTextarea(330);
    expect(getTextarea().style.height).toBe('56px');

    // Wider again: back to one line.
    scrollHeight = 36;
    resizeTextarea(400);
    expect(getTextarea().style.height).toBe('36px');
  });

  it('does the same in the two-row layout (a split resize)', () => {
    renderComposer({ oneRowWhenWide: false });
    resizeTextarea(300);
    type('draft');
    scrollHeight = 76;
    resizeTextarea(200);
    expect(getTextarea().style.height).toBe('76px');
  });

  it('keeps the stored floor', () => {
    window.localStorage.setItem(getComposerHeightStorageKey('test-worktree', SPLIT_0), '120');
    renderComposer();
    resizeTextarea(400);
    type('draft');
    scrollHeight = 56;
    resizeTextarea(330);
    expect(getTextarea().style.height).toBe('120px');
  });

  it('keeps the caller bound and the auto-grow cap', () => {
    renderComposer({ maxHeight: 80 });
    resizeTextarea(400);
    type('draft');
    scrollHeight = 300;
    resizeTextarea(200);
    expect(getTextarea().style.height).toBe('80px');
  });

  it('leaves an empty composer at its floor', () => {
    renderComposer();
    resizeTextarea(400);
    scrollHeight = 56;
    resizeTextarea(200);
    expect(getTextarea().style.height).toBe('36px');
  });

  it('ignores a height-only resize (its own height change), so it cannot loop', () => {
    renderComposer();
    resizeTextarea(400);
    type('draft');
    expect(getTextarea().style.height).toBe('36px');
    scrollHeight = 56;
    resizeTextarea(400);
    expect(getTextarea().style.height).toBe('36px');
  });
});

describe('[#3595] the one-row hints have a keyboard way in', () => {
  it('draws a focusable hints button only in one row, named by the hints', () => {
    renderComposer();
    const button = screen.getByTestId('composer-hints-button');
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-label', HINTS);
    expect(button.tabIndex).toBe(0);
    // Drawn only from the one-row threshold, beside the Auto-Yes toggle.
    const slot = screen.getByTestId('composer-hints-entry');
    const classes = (slot.getAttribute('class') ?? '').split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['hidden', `${V}flex`, `${V}order-3`]));
    expect(screen.getByTestId('composer-meta-row').contains(slot)).toBe(true);
  });

  it('opens the hints in a tooltip when the button takes keyboard focus', () => {
    renderComposer();
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    const button = screen.getByTestId('composer-hints-button');
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(tip).toHaveTextContent(HINTS);
    act(() => button.blur());
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  it('two rows: no hints button, the hints drawn as before', () => {
    renderComposer({ oneRowWhenWide: false });
    expect(screen.queryByTestId('composer-hints-button')).toBeNull();
    expect(screen.queryByTestId('composer-hints-entry')).toBeNull();
    const hints = screen.getByTestId('composer-hints');
    expect((hints.getAttribute('class') ?? '').split(/\s+/)).toEqual(
      expect.arrayContaining(['hidden', '@min-[420px]:flex']),
    );
    expect(hints).toHaveTextContent('commands');
  });

  it('phone with the prop: no hints button', () => {
    mockIsMobile = true;
    renderComposer();
    expect(screen.queryByTestId('composer-hints-button')).toBeNull();
  });
});

describe('[#3595] the threshold on the container it is queried on', () => {
  it('one row: the form carries COMPOSER_ONE_ROW_MIN_CONTAINER_PX', () => {
    renderComposer();
    const form = screen.getByTestId('composer-input-row').closest('form')!;
    expect(form).toHaveAttribute('data-one-row-min-px', String(COMPOSER_ONE_ROW_MIN_CONTAINER_PX));
  });

  it('two rows, and the phone: no such attribute', () => {
    const { unmount } = renderComposer({ oneRowWhenWide: false });
    expect(screen.getByTestId('composer-input-row').closest('form')).not.toHaveAttribute('data-one-row-min-px');
    unmount();
    mockIsMobile = true;
    renderComposer();
    expect(screen.getByTestId('composer-input-row').closest('form')).not.toHaveAttribute('data-one-row-min-px');
  });
});
