/**
 * Tests for the composer's stored textarea height (Issue #2598).
 *
 * What this pins, beyond "it reads and writes":
 *
 * 1. **The key is worktree × scope.** A height chosen in one split must not
 *    appear in another split, another worktree, or on the sessions tile — and
 *    the tile is deliberately NOT split 0, although it shares split 0's draft.
 * 2. **A bad entry is absent, not zero.** A corrupted or hand-edited value must
 *    leave the composer on auto-grow rather than draw a 0px or a 1e6px box.
 * 3. **Clamping is display-only.** A shorter pane bounds what is drawn and
 *    never rewrites what is stored.
 *
 * @module tests/unit/hooks/useComposerHeight-2598
 * @vitest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clampComposerHeight,
  clearComposerHeight,
  getComposerHeightStorageKey,
  measureComposerMaxHeight,
  parseStoredComposerHeight,
  readComposerHeight,
  useComposerHeight,
  writeComposerHeight,
} from '@/hooks/useComposerHeight';
import {
  COMPOSER_AUTO_MAX_HEIGHT_PX,
  COMPOSER_HEIGHT_STORAGE_KEY_PREFIX,
  COMPOSER_MAX_STORED_HEIGHT_PX,
  COMPOSER_MIN_HEIGHT_PX,
  SESSION_TILE_COMPOSER_HEIGHT_SCOPE,
  composerHeightScopeForSplit,
} from '@/config/composer-height';

const WT = 'wt-2598';

beforeEach(() => {
  window.localStorage.clear();
});

describe('constants', () => {
  it('keeps the pre-#2598 textarea bounds', () => {
    // The floor is the textarea's own `minHeight`, and auto-grow still stops at
    // the cap it always had.
    expect(COMPOSER_MIN_HEIGHT_PX).toBe(36);
    expect(COMPOSER_AUTO_MAX_HEIGHT_PX).toBe(160);
  });

  it('spells the key the Issue specifies', () => {
    expect(COMPOSER_HEIGHT_STORAGE_KEY_PREFIX).toBe('commandmate:composer-height:');
    expect(getComposerHeightStorageKey(WT, composerHeightScopeForSplit(2))).toBe(
      'commandmate:composer-height:wt-2598:split:2',
    );
    expect(getComposerHeightStorageKey(WT, SESSION_TILE_COMPOSER_HEIGHT_SCOPE)).toBe(
      'commandmate:composer-height:wt-2598:session-tile',
    );
  });

  it('gives the sessions tile a scope of its own, not split 0', () => {
    expect(SESSION_TILE_COMPOSER_HEIGHT_SCOPE).not.toBe(composerHeightScopeForSplit(0));
  });
});

describe('parseStoredComposerHeight', () => {
  it.each([
    ['120', 120],
    [' 200 ', 200],
    ['36', COMPOSER_MIN_HEIGHT_PX],
    [String(COMPOSER_MAX_STORED_HEIGHT_PX), COMPOSER_MAX_STORED_HEIGHT_PX],
    ['99.6', 100],
  ])('reads %j as %d', (raw, expected) => {
    expect(parseStoredComposerHeight(raw)).toBe(expected);
  });

  it.each([
    ['missing', null],
    ['empty', ''],
    ['blank', '   '],
    ['not a number', 'tall'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['JSON object', '{"height":120}'],
    ['below the floor', '35'],
    ['zero', '0'],
    ['negative', '-120'],
    ['above the storable range', String(COMPOSER_MAX_STORED_HEIGHT_PX + 1)],
    ['absurd', '1e9'],
  ])('ignores a %s value', (_label, raw) => {
    expect(parseStoredComposerHeight(raw as string | null)).toBeNull();
  });
});

describe('clampComposerHeight', () => {
  it('never goes under the floor', () => {
    expect(clampComposerHeight(10)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(clampComposerHeight(10, 300)).toBe(COMPOSER_MIN_HEIGHT_PX);
  });

  it('bounds by the caller-supplied maximum', () => {
    expect(clampComposerHeight(400, 250)).toBe(250);
    expect(clampComposerHeight(200, 250)).toBe(200);
  });

  it('lets the floor win over a maximum below it (a pane too short for one line)', () => {
    expect(clampComposerHeight(200, 12)).toBe(COMPOSER_MIN_HEIGHT_PX);
    expect(clampComposerHeight(200, -40)).toBe(COMPOSER_MIN_HEIGHT_PX);
  });

  it('treats an unmeasured maximum as the storable range', () => {
    expect(clampComposerHeight(500, null)).toBe(500);
    expect(clampComposerHeight(500, undefined)).toBe(500);
    expect(clampComposerHeight(1e9, null)).toBe(COMPOSER_MAX_STORED_HEIGHT_PX);
  });
});

describe('read / write / clear', () => {
  it('round-trips a height under the worktree x scope key', () => {
    writeComposerHeight(WT, 'split:1', 222);
    expect(window.localStorage.getItem('commandmate:composer-height:wt-2598:split:1')).toBe('222');
    expect(readComposerHeight(WT, 'split:1')).toBe(222);
  });

  it('does not leak into another split, another worktree, or the tile', () => {
    writeComposerHeight(WT, composerHeightScopeForSplit(0), 222);
    expect(readComposerHeight(WT, composerHeightScopeForSplit(1))).toBeNull();
    expect(readComposerHeight('other-wt', composerHeightScopeForSplit(0))).toBeNull();
    expect(readComposerHeight(WT, SESSION_TILE_COMPOSER_HEIGHT_SCOPE)).toBeNull();
  });

  it('ignores a corrupted entry', () => {
    window.localStorage.setItem(getComposerHeightStorageKey(WT, 'split:0'), 'garbage');
    expect(readComposerHeight(WT, 'split:0')).toBeNull();
  });

  it('clears the entry', () => {
    writeComposerHeight(WT, 'split:0', 222);
    clearComposerHeight(WT, 'split:0');
    expect(window.localStorage.getItem(getComposerHeightStorageKey(WT, 'split:0'))).toBeNull();
  });

  it('survives a storage that throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      expect(readComposerHeight(WT, 'split:0')).toBeNull();
      expect(() => writeComposerHeight(WT, 'split:0', 100)).not.toThrow();
      expect(() => clearComposerHeight(WT, 'split:0')).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
      remove.mockRestore();
    }
  });
});

describe('useComposerHeight', () => {
  it('reports auto-grow when nothing is stored', () => {
    const { result } = renderHook(() => useComposerHeight({ worktreeId: WT, scope: 'split:0' }));
    expect(result.current.storedHeight).toBeNull();
    expect(result.current.height).toBeNull();
  });

  it('loads the stored height for its own key', () => {
    writeComposerHeight(WT, 'split:0', 180);
    writeComposerHeight(WT, 'split:1', 90);
    const { result } = renderHook(() => useComposerHeight({ worktreeId: WT, scope: 'split:1' }));
    expect(result.current.height).toBe(90);
  });

  it('reloads when the key changes', () => {
    writeComposerHeight(WT, 'split:0', 180);
    writeComposerHeight('other-wt', 'split:0', 70);
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useComposerHeight({ worktreeId: id, scope: 'split:0' }),
      { initialProps: { id: WT } },
    );
    expect(result.current.height).toBe(180);
    rerender({ id: 'other-wt' });
    expect(result.current.height).toBe(70);
  });

  it('starts the first drag from the drawn height, then accumulates', () => {
    const { result } = renderHook(() =>
      useComposerHeight({ worktreeId: WT, scope: 'split:0', maxHeight: 500 }),
    );
    act(() => {
      result.current.resizeBy(10, 36);
      // A second move before any re-render builds on the first.
      result.current.resizeBy(15, 36);
    });
    expect(result.current.height).toBe(61);
    expect(readComposerHeight(WT, 'split:0')).toBe(61);
  });

  it('stops at the maximum and at the floor while dragging', () => {
    const { result } = renderHook(() =>
      useComposerHeight({ worktreeId: WT, scope: 'split:0', maxHeight: 120 }),
    );
    act(() => result.current.resizeBy(1000, 36));
    expect(result.current.height).toBe(120);
    expect(readComposerHeight(WT, 'split:0')).toBe(120);
    act(() => result.current.resizeBy(-1000, 120));
    expect(result.current.height).toBe(COMPOSER_MIN_HEIGHT_PX);
  });

  it('clamps what it draws without rewriting what it stored', () => {
    writeComposerHeight(WT, 'split:0', 300);
    const { result, rerender } = renderHook(
      ({ max }: { max: number | null }) =>
        useComposerHeight({ worktreeId: WT, scope: 'split:0', maxHeight: max }),
      { initialProps: { max: 500 as number | null } },
    );
    expect(result.current.height).toBe(300);

    // The pane got shorter (a 2x2 grid, a smaller window).
    rerender({ max: 120 });
    expect(result.current.height).toBe(120);
    expect(result.current.storedHeight).toBe(300);
    expect(readComposerHeight(WT, 'split:0')).toBe(300);

    // …and taller again: the preference comes back.
    rerender({ max: 500 });
    expect(result.current.height).toBe(300);
  });

  it('drags from the clamped height the user sees, not from the hidden stored one', () => {
    writeComposerHeight(WT, 'split:0', 300);
    const { result } = renderHook(() =>
      useComposerHeight({ worktreeId: WT, scope: 'split:0', maxHeight: 120 }),
    );
    act(() => result.current.resizeBy(-20, 120));
    expect(result.current.height).toBe(100);
    expect(readComposerHeight(WT, 'split:0')).toBe(100);
  });

  it('reset forgets the height and returns to auto-grow', () => {
    writeComposerHeight(WT, 'split:0', 300);
    const { result } = renderHook(() => useComposerHeight({ worktreeId: WT, scope: 'split:0' }));
    act(() => result.current.reset());
    expect(result.current.height).toBeNull();
    expect(readComposerHeight(WT, 'split:0')).toBeNull();
  });

  it('applies and changes nothing when disabled (a phone) or without a scope', () => {
    writeComposerHeight(WT, 'split:0', 300);
    const disabled = renderHook(() =>
      useComposerHeight({ worktreeId: WT, scope: 'split:0', enabled: false }),
    );
    expect(disabled.result.current.height).toBeNull();
    act(() => disabled.result.current.resizeBy(50, 36));
    act(() => disabled.result.current.reset());
    expect(readComposerHeight(WT, 'split:0')).toBe(300);

    const noScope = renderHook(() => useComposerHeight({ worktreeId: WT, scope: null }));
    expect(noScope.result.current.height).toBeNull();
    act(() => noScope.result.current.resizeBy(50, 36));
    expect(noScope.result.current.height).toBeNull();
  });
});

describe('measureComposerMaxHeight', () => {
  /** A column of [header, body, footer>textarea] with stubbed geometry. */
  function buildColumn(opts: {
    column: number;
    header: number;
    footer: number;
    textarea: number;
    overlay?: boolean;
  }) {
    const column = document.createElement('div');
    const header = document.createElement('div');
    const body = document.createElement('div');
    const footer = document.createElement('div');
    const textarea = document.createElement('textarea');
    footer.appendChild(textarea);
    column.append(header, body, footer);
    if (opts.overlay) {
      const overlay = document.createElement('div');
      overlay.style.position = 'absolute';
      stubHeight(overlay, 999);
      column.appendChild(overlay);
    }
    // A 1px border top and bottom, as the split pane has: the content box is
    // what the children share.
    column.style.border = '1px solid';
    stubHeight(column, opts.column + 2);
    stubHeight(header, opts.header);
    stubHeight(footer, opts.footer);
    stubHeight(textarea, opts.textarea);
    // The body's own height is deliberately wrong (a CSS floor pins it):
    // the measurement must not read it.
    stubHeight(body, 9999);
    document.body.appendChild(column);
    return { body, textarea };
  }

  function stubHeight(el: HTMLElement, height: number) {
    el.getBoundingClientRect = () =>
      ({ height, width: 100, top: 0, left: 0, right: 100, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  }

  it('gives the textarea whatever the body has beyond its floor', () => {
    // 800 column − 30 header − 120 footer = 650 of body; 650 − 160 = 490 spare.
    const { body, textarea } = buildColumn({ column: 800, header: 30, footer: 120, textarea: 36 });
    expect(measureComposerMaxHeight(body, textarea, 160)).toBe(36 + 490);
  });

  it('is the same bound whatever height the textarea currently has', () => {
    // The textarea grew by 100; the footer grew with it.
    const { body, textarea } = buildColumn({ column: 800, header: 30, footer: 220, textarea: 136 });
    expect(measureComposerMaxHeight(body, textarea, 160)).toBe(36 + 490);
  });

  it('goes under the floor when the body is already short (the caller clamps)', () => {
    const { body, textarea } = buildColumn({ column: 300, header: 30, footer: 140, textarea: 36 });
    expect(measureComposerMaxHeight(body, textarea, 160)).toBe(36 + 300 - 30 - 140 - 160);
  });

  it('keeps sub-pixel geometry (a rounded clientHeight would cost the body half a pixel)', () => {
    const { body, textarea } = buildColumn({ column: 799.5, header: 30.5, footer: 120, textarea: 36 });
    // 36 + (799.5 − 30.5 − 120) − 160 = 525, exactly.
    expect(measureComposerMaxHeight(body, textarea, 160)).toBe(525);
  });

  it('ignores out-of-flow children', () => {
    const { body, textarea } = buildColumn({
      column: 800,
      header: 30,
      footer: 120,
      textarea: 36,
      overlay: true,
    });
    expect(measureComposerMaxHeight(body, textarea, 160)).toBe(36 + 490);
  });

  it('reports nothing while the textarea is not rendered', () => {
    const { body, textarea } = buildColumn({ column: 800, header: 30, footer: 0, textarea: 0 });
    expect(measureComposerMaxHeight(body, textarea, 160)).toBeNull();
  });
});
