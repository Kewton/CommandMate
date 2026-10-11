/**
 * The one-row composer in a wide split pane (Issue #3595).
 *
 * jsdom has no layout and no container queries, so where the row breaks and
 * what it saves are measured in `tests/e2e/composer-two-row-2598.spec.ts`.
 * This file pins the DOM those measurements depend on:
 *
 * 1. **Opt-in.** Only a composer given `oneRowWhenWide` (the PC split pane)
 *    gets the one-row classes. Without it — the phone, the /sessions tile —
 *    every element carries exactly the classes it had before (negative control,
 *    compared against a render without the prop), and on a phone the prop does
 *    nothing at all.
 * 2. **One threshold, spelled as literals.** Every one-row class is the
 *    `COMPOSER_ONE_ROW_MIN_CONTAINER_PX` container variant, and the form is the
 *    container it queries.
 * 3. **The same controls, once each.** The toolbar, the textarea row and the
 *    meta row dissolve (`contents`) into the input row; `order` puts
 *    [attach][mode] [textarea] [Auto-Yes][direct input][interrupt][send].
 * 4. **The hints move to hover.** Not drawn in one row; the textarea's `title`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import {
  COMPOSER_ONE_ROW_MIN_CONTAINER_PX,
  MessageInput,
} from '@/components/worktree/MessageInput';
import { worktreeApi } from '@/lib/api-client';
import {
  createDefaultProps,
  getTextarea,
  mockCommandGroups,
} from '@tests/helpers/message-input-test-utils';
import { composerHeightScopeForSplit } from '@/config/composer-height';
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

const modeSlot = <div data-testid="fake-agent-mode">mode</div>;
const directInputSlot = <button type="button" data-testid="fake-direct-input">direct</button>;
const autoYesSlot = <span data-testid="fake-auto-yes">auto</span>;

function classesOf(el: Element): string[] {
  return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

/** Every element's testid (or tag) and class list, in document order. */
function classMap(root: Element): string[] {
  return Array.from(root.querySelectorAll('*')).map(
    el => `${el.getAttribute('data-testid') ?? el.tagName.toLowerCase()}: ${el.getAttribute('class') ?? ''}`,
  );
}

function renderComposer(extra: Record<string, unknown> = {}) {
  const props = createDefaultProps();
  return render(
    <MessageInput
      {...props}
      heightScope={SPLIT_0}
      agentModeSlot={modeSlot}
      directInputSlot={directInputSlot}
      autoYesSlot={autoYesSlot}
      {...extra}
    />,
  );
}

describe('MessageInput one-row layout (Issue #3595)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile = false;
    window.localStorage.clear();
  });

  describe('PC, oneRowWhenWide', () => {
    it('makes the form the query container and the input row a row at the threshold', () => {
      renderComposer({ oneRowWhenWide: true });
      const row = screen.getByTestId('composer-input-row');
      const form = row.closest('form')!;
      expect(classesOf(form)).toContain('@container');
      // #2597's container stays on the input row, around the mode control.
      expect(classesOf(row)).toEqual(expect.arrayContaining([
        '@container', 'flex-col', `${V}flex-row`, `${V}items-end`,
      ]));
      expect(row.contains(screen.getByTestId('fake-agent-mode'))).toBe(true);
    });

    it('moves the meta row into the input row, last, without a container of its own', () => {
      renderComposer({ oneRowWhenWide: true });
      const row = screen.getByTestId('composer-input-row');
      expect(Array.from(row.children).map(c => c.getAttribute('data-testid'))).toEqual([
        'composer-toolbar',
        'composer-textarea-row',
        'composer-meta-row',
      ]);
      const meta = screen.getByTestId('composer-meta-row');
      expect(classesOf(meta)).not.toContain('@container');
      // Below the threshold it keeps the 6px the form's gap-1.5 gave it.
      expect(classesOf(meta)).toContain('mt-0.5');
    });

    it('dissolves the toolbar, the textarea row and the meta row at the threshold', () => {
      renderComposer({ oneRowWhenWide: true });
      for (const id of ['composer-toolbar', 'composer-textarea-row', 'composer-meta-row']) {
        expect(classesOf(screen.getByTestId(id)), id).toContain(`${V}contents`);
      }
    });

    it('orders [attach][mode] [textarea] [Auto-Yes][direct][interrupt][send]', () => {
      renderComposer({ oneRowWhenWide: true });
      const start = screen.getByTestId('composer-toolbar-start');
      expect(within(start).getByTestId('attach-image-button')).toBeInTheDocument();
      expect(within(start).getByTestId('fake-agent-mode')).toBeInTheDocument();
      const end = screen.getByTestId('composer-toolbar-end');
      expect(within(end).getByTestId('fake-direct-input')).toBeInTheDocument();
      expect(within(end).getByTestId('interrupt-button')).toBeInTheDocument();
      expect(within(screen.getByTestId('composer-auto-yes')).getByTestId('fake-auto-yes')).toBeInTheDocument();

      const order: Array<[string, number]> = [
        ['composer-toolbar-start', 1],
        ['message-input-textarea', 2],
        ['composer-auto-yes', 3],
        ['composer-toolbar-end', 4],
        ['send-message-button', 5],
      ];
      for (const [id, n] of order) {
        expect(classesOf(screen.getByTestId(id)), id).toContain(`${V}order-${n}`);
      }
      // The start group stops taking the free width; the textarea takes it
      // and keeps a floor; the Auto-Yes half is drawn whole.
      expect(classesOf(start)).toContain(`${V}flex-initial`);
      expect(classesOf(getTextarea())).toEqual(expect.arrayContaining(['flex-1', `${V}min-w-40`]));
      expect(classesOf(screen.getByTestId('composer-auto-yes'))).toContain(`${V}shrink-0`);
    });

    it('mounts each control exactly once', () => {
      renderComposer({ oneRowWhenWide: true });
      for (const id of [
        'attach-image-button', 'fake-agent-mode', 'message-input-textarea', 'fake-auto-yes',
        'fake-direct-input', 'interrupt-button', 'send-message-button', 'composer-hints',
        'composer-resize-handle',
      ]) {
        expect(screen.getAllByTestId(id), id).toHaveLength(1);
      }
    });

    it('hides the hints in one row and gives them to the textarea as hover text', () => {
      renderComposer({ oneRowWhenWide: true });
      const hints = classesOf(screen.getByTestId('composer-hints'));
      // Still drawn from 420px in the two-row layout below the threshold.
      expect(hints).toEqual(expect.arrayContaining(['hidden', '@min-[420px]:flex', `${V}hidden`]));
      expect(getTextarea()).toHaveAttribute('title', '/ commands · Shift+Enter newline');
    });

    it('spells every one-row variant with the one threshold', () => {
      const { container } = renderComposer({ oneRowWhenWide: true });
      const variants = new Set(
        Array.from(container.querySelectorAll('*'))
          .flatMap(classesOf)
          .filter(c => c.startsWith('@min-['))
          .map(c => c.slice(0, c.indexOf(':') + 1)),
      );
      // 420 is #2598's hints threshold; nothing else but the one-row value.
      expect([...variants].sort()).toEqual(['@min-[420px]:', V].sort());
    });

    it('does not send on Shift+Enter, nor on Enter during IME composition', () => {
      renderComposer({ oneRowWhenWide: true });
      const textarea = getTextarea();
      fireEvent.change(textarea, { target: { value: 'line' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
      expect(worktreeApi.sendMessage).not.toHaveBeenCalled();
      fireEvent.compositionStart(textarea);
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(worktreeApi.sendMessage).not.toHaveBeenCalled();
      fireEvent.compositionEnd(textarea);
    });

    it('sends on a plain Enter', async () => {
      renderComposer({ oneRowWhenWide: true });
      const textarea = getTextarea();
      fireEvent.change(textarea, { target: { value: 'hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      await waitFor(() => expect(worktreeApi.sendMessage).toHaveBeenCalledTimes(1));
    });

    it('keeps the height handle and the stored height', () => {
      window.localStorage.setItem(getComposerHeightStorageKey('test-worktree', SPLIT_0), '120');
      renderComposer({ oneRowWhenWide: true, worktreeId: 'test-worktree' });
      expect(screen.getByTestId('composer-resize-handle')).toBeInTheDocument();
      expect(getTextarea().style.minHeight).toBe('120px');
    });
  });

  describe('negative controls: the layout without the prop is the one before #3595', () => {
    it('PC without the prop: no one-row class, no hover text, the meta row outside the input row', () => {
      const { container } = renderComposer();
      expect(container.innerHTML).not.toContain(V);
      const form = screen.getByTestId('composer-input-row').closest('form')!;
      expect(classesOf(form)).not.toContain('@container');
      expect(classesOf(screen.getByTestId('composer-meta-row'))).toContain('@container');
      expect(screen.getByTestId('composer-meta-row').parentElement).toBe(form);
      expect(getTextarea()).not.toHaveAttribute('title');
      expect(Array.from(screen.getByTestId('composer-input-row').children).map(c => c.getAttribute('data-testid')))
        .toEqual(['composer-toolbar', 'composer-textarea-row']);
    });

    it('phone: the prop changes nothing (same elements, same classes)', () => {
      mockIsMobile = true;
      const without = renderComposer();
      const before = classMap(without.container);
      const titleBefore = getTextarea().getAttribute('title');
      without.unmount();

      const withProp = renderComposer({ oneRowWhenWide: true });
      expect(classMap(withProp.container)).toEqual(before);
      expect(getTextarea().getAttribute('title')).toBe(titleBefore);
      expect(withProp.container.innerHTML).not.toContain(V);
    });

    it('/sessions tile (PC, no prop): the same elements and classes as a plain PC composer', () => {
      // The tile passes its own scope and no oneRowWhenWide (pinned in
      // TerminalSplitPaneContent-composer-one-row-3595.test.tsx).
      const tile = render(<MessageInput {...createDefaultProps()} heightScope="session-tile" />);
      expect(tile.container.innerHTML).not.toContain(V);
    });
  });
});
