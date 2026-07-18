/**
 * Tests for FileMetadataToggle component (Issue #969, #1365)
 *
 * The gear button in the file-tree toolbar opens a popover of metadata
 * checkboxes. [Issue #1365] The popover is anchored `absolute right-0 top-full`
 * off the button, so it can open past the bottom or the left edge of the
 * viewport; once open it is measured and nudged back with a transform. It stays
 * absolutely positioned (rather than portalled) because the click-outside
 * handler asks whether the click landed inside the container — a portalled menu
 * would read as "outside" and close on its own first click.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileMetadataToggle } from '@/components/worktree/FileMetadataToggle';
import type { FileMetadataDisplaySettings } from '@/hooks/useFileMetadataDisplay';

const SETTINGS: FileMetadataDisplaySettings = {
  showSize: true,
  showCreated: false,
  showModified: false,
};

function makeRect(overrides: Partial<DOMRect>): DOMRect {
  return {
    top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0,
    ...overrides,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Only the popover reports a box; everything else is zeroed. */
function menuRect(rect: Partial<DOMRect>): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element
  ) {
    return this.getAttribute('data-testid') === 'file-metadata-toggle-menu'
      ? makeRect(rect)
      : makeRect({});
  });
}

function openMenu(onToggle = vi.fn()): HTMLElement {
  render(<FileMetadataToggle settings={SETTINGS} onToggle={onToggle} />);
  fireEvent.click(screen.getByTestId('file-metadata-toggle-button'));
  return screen.getByTestId('file-metadata-toggle-menu');
}

describe('FileMetadataToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens and closes the popover from the gear button', () => {
    menuRect({ top: 40, left: 700, width: 192, height: 120 });
    const menu = openMenu();

    expect(menu).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('file-metadata-toggle-button'));
    expect(screen.queryByTestId('file-metadata-toggle-menu')).not.toBeInTheDocument();
  });

  it('reports a toggled key to the parent', () => {
    menuRect({ top: 40, left: 700, width: 192, height: 120 });
    const onToggle = vi.fn();
    openMenu(onToggle);

    fireEvent.click(screen.getByTestId('file-metadata-toggle-showCreated'));
    expect(onToggle).toHaveBeenCalledWith('showCreated');
  });

  it('closes when clicking outside (the popover is not portalled away)', () => {
    menuRect({ top: 40, left: 700, width: 192, height: 120 });
    openMenu();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('file-metadata-toggle-menu')).not.toBeInTheDocument();
  });

  it('stays open when clicking inside the popover [Issue #1365 regression]', () => {
    // A portalled menu would count as "outside" the container ref and close on
    // its own first click. Guard the absolute-positioning decision.
    menuRect({ top: 40, left: 700, width: 192, height: 120 });
    const menu = openMenu();

    fireEvent.mouseDown(menu);
    expect(screen.getByTestId('file-metadata-toggle-menu')).toBeInTheDocument();
  });

  describe('viewport clamping (Issue #1365)', () => {
    it('does not shift a popover that already fits on screen', () => {
      menuRect({ top: 40, left: 700, width: 192, height: 120 });

      expect(openMenu().style.transform).toBe('');
    });

    it('pulls a popover that overflows the bottom edge back into view', () => {
      // 700 + 120 + 8 - 768 = 60 over the bottom.
      menuRect({ top: 700, left: 700, width: 192, height: 120 });

      expect(openMenu().style.transform).toBe('translate(0px, -60px)');
    });

    it('pushes a right-aligned popover that overflows the left edge back into view', () => {
      // `right-0` anchoring puts a 192px popover at left -40 when the gear sits
      // near the left edge of the tree: nudged to the 8px margin.
      menuRect({ top: 40, left: -40, width: 192, height: 120 });

      expect(openMenu().style.transform).toBe('translate(48px, 0px)');
    });
  });
});
