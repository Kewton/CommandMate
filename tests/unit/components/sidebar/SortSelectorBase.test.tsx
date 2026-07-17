/**
 * Tests for SortSelectorBase component
 *
 * Verifies that the presentational sort selector works without Context dependency.
 * Issue #606: Sessions page enhancement [DP-006]
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { SortSelectorBase } from '@/components/sidebar/SortSelectorBase';
import type { SortOption } from '@/components/sidebar/SortSelectorBase';
import type { SortKey, SortDirection } from '@/lib/sidebar-utils';
import { TOOLTIP_DELAY_MS } from '@/components/common/Tooltip';

const TEST_OPTIONS: SortOption[] = [
  { key: 'repositoryName', label: 'Repository' },
  { key: 'status', label: 'Status' },
  { key: 'lastSent', label: 'Last Sent' },
];

function renderSelector(overrides: Partial<{
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSortKeyChange: (key: SortKey) => void;
  onSortDirectionChange: (dir: SortDirection) => void;
  options: ReadonlyArray<SortOption>;
  defaultDirections: Partial<Record<SortKey, SortDirection>>;
  tooltip: string;
  iconClassName: string;
}> = {}) {
  const props = {
    sortKey: 'lastSent' as SortKey,
    sortDirection: 'desc' as SortDirection,
    onSortKeyChange: vi.fn(),
    onSortDirectionChange: vi.fn(),
    options: TEST_OPTIONS,
    ...overrides,
  };
  const result = render(<SortSelectorBase {...props} />);
  return { ...result, ...props };
}

describe('SortSelectorBase', () => {
  it('should render without Context dependency', () => {
    // No SidebarProvider wrapper - must work standalone
    renderSelector();
    expect(screen.getByTestId('sort-selector-base')).toBeDefined();
  });

  it('should display current sort label', () => {
    renderSelector({ sortKey: 'lastSent' });
    expect(screen.getByText('Last Sent')).toBeDefined();
  });

  it('should open dropdown and show options on click', () => {
    renderSelector();
    const trigger = screen.getByRole('button', { name: /Sort by/i });
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeDefined();
    // Check that all option buttons are rendered inside the listbox
    const optionButtons = screen.getAllByRole('option');
    expect(optionButtons).toHaveLength(3);
  });

  it('should call onSortKeyChange when selecting a different key', () => {
    const { onSortKeyChange, onSortDirectionChange } = renderSelector({
      sortKey: 'lastSent',
    });

    // Open dropdown
    fireEvent.click(screen.getByRole('button', { name: /Sort by/i }));
    // Select Repository
    fireEvent.click(screen.getByText('Repository'));

    expect(onSortKeyChange).toHaveBeenCalledWith('repositoryName');
    expect(onSortDirectionChange).toHaveBeenCalledWith('asc'); // default for non-time keys
  });

  it('should toggle direction when selecting the same key (toggle-on-reselect)', () => {
    const { onSortDirectionChange } = renderSelector({
      sortKey: 'lastSent',
      sortDirection: 'desc',
    });

    // Open dropdown
    fireEvent.click(screen.getByRole('button', { name: /Sort by/i }));
    // Select same key (Last Sent) via option role
    const options = screen.getAllByRole('option');
    const lastSentOption = options.find(opt => opt.getAttribute('aria-selected') === 'true');
    fireEvent.click(lastSentOption!);

    expect(onSortDirectionChange).toHaveBeenCalledWith('asc');
  });

  it('should apply defaultDirections when switching key', () => {
    const { onSortKeyChange, onSortDirectionChange } = renderSelector({
      sortKey: 'repositoryName',
      sortDirection: 'asc',
      defaultDirections: { lastSent: 'desc', updatedAt: 'desc' },
    });

    // Open dropdown and select Last Sent
    fireEvent.click(screen.getByRole('button', { name: /Sort by/i }));
    fireEvent.click(screen.getByText('Last Sent'));

    expect(onSortKeyChange).toHaveBeenCalledWith('lastSent');
    expect(onSortDirectionChange).toHaveBeenCalledWith('desc'); // from defaultDirections
  });

  it('should fallback to asc when defaultDirections does not include the key', () => {
    const { onSortKeyChange, onSortDirectionChange } = renderSelector({
      sortKey: 'lastSent',
      sortDirection: 'desc',
      defaultDirections: { lastSent: 'desc' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Sort by/i }));
    fireEvent.click(screen.getByText('Status'));

    expect(onSortKeyChange).toHaveBeenCalledWith('status');
    expect(onSortDirectionChange).toHaveBeenCalledWith('asc'); // fallback
  });

  it('should toggle direction via direction button', () => {
    const { onSortDirectionChange } = renderSelector({
      sortDirection: 'desc',
    });

    const dirButton = screen.getByRole('button', { name: /Sort descending/i });
    fireEvent.click(dirButton);

    expect(onSortDirectionChange).toHaveBeenCalledWith('asc');
  });

  it('should show ASC/DESC indicator for selected key', () => {
    renderSelector({ sortKey: 'lastSent', sortDirection: 'desc' });

    fireEvent.click(screen.getByRole('button', { name: /Sort by/i }));

    // The selected key should show DESC indicator
    expect(screen.getByText('DESC')).toBeDefined();
  });

  it('should close dropdown after selection', () => {
    renderSelector();

    fireEvent.click(screen.getByRole('button', { name: /Sort by/i }));
    expect(screen.getByRole('listbox')).toBeDefined();

    fireEvent.click(screen.getByText('Repository'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  // Issue #882: optional shared Tooltip on the trigger button
  describe('tooltip prop (Issue #882)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows the shared Tooltip on hover when tooltip prop is provided', () => {
      renderSelector({ tooltip: 'Sort branches' });

      const trigger = screen.getByRole('button', { name: /Sort by/i });
      // mouseenter bubbles up to the Tooltip wrapper span
      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
      });

      const tooltip = screen.getByRole('tooltip', { hidden: true });
      expect(tooltip).toHaveTextContent('Sort branches');
      expect(tooltip).toHaveAttribute('aria-hidden', 'true');
    });

    it('does NOT render a tooltip wrapper when tooltip prop is omitted', () => {
      renderSelector();

      const trigger = screen.getByRole('button', { name: /Sort by/i });
      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
      });

      expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    });
  });

  // Issue #946: the sort/direction icon size must be controllable per-consumer so
  // the sidebar header can enlarge them WITHOUT affecting the Sessions page, which
  // shares this component and must keep the original w-3 h-3 size.
  describe('icon sizing (Issue #946)', () => {
    it('defaults the sort and direction icons to w-3 h-3 when iconClassName is omitted (Sessions regression guard)', () => {
      const { container } = renderSelector();

      const svgs = Array.from(container.querySelectorAll('svg'));
      // Trigger SortIcon + direction Arrow icon are rendered when the dropdown is closed
      expect(svgs.length).toBeGreaterThanOrEqual(2);
      svgs.forEach((svg) => {
        const cls = svg.getAttribute('class') ?? '';
        expect(cls).toContain('w-3');
        expect(cls).toContain('h-3');
      });
    });

    it('applies a custom iconClassName to the sort and direction icons (sidebar header enlargement)', () => {
      const { container } = renderSelector({ iconClassName: 'w-4 h-4' });

      const svgs = Array.from(container.querySelectorAll('svg'));
      expect(svgs.length).toBeGreaterThanOrEqual(2);
      svgs.forEach((svg) => {
        const cls = svg.getAttribute('class') ?? '';
        expect(cls).toContain('w-4');
        expect(cls).toContain('h-4');
        expect(cls).not.toContain('w-3');
      });
    });
  });
});

/**
 * [Issue #1365] The dropdown is anchored to the trigger with `absolute
 * right-0 top-full`. The sidebar header has no overflow clipping, so nothing
 * cuts the menu off — but a selector sitting low in the viewport, or hard
 * against an edge, can still open partly off-screen. Once open the menu is
 * measured and nudged back with a transform.
 */
describe('SortSelectorBase viewport clamping (Issue #1365)', () => {
  const VIEWPORT_WIDTH = 1024;
  const VIEWPORT_HEIGHT = 768;

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT_WIDTH });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT_HEIGHT });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeRect(overrides: Partial<DOMRect>): DOMRect {
    return {
      top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0,
      ...overrides,
      toJSON: () => ({}),
    } as DOMRect;
  }

  /** Only the dropdown (role=listbox) reports a box; everything else is zeroed. */
  function menuRect(rect: Partial<DOMRect>): void {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      return this.getAttribute('role') === 'listbox' ? makeRect(rect) : makeRect({});
    });
  }

  function openMenu(): HTMLElement {
    fireEvent.click(screen.getByLabelText(/^Sort by/));
    return screen.getByRole('listbox');
  }

  it('does not shift a dropdown that already fits on screen', () => {
    menuRect({ top: 100, left: 400, width: 140, height: 120 });
    renderSelector();

    expect(openMenu().style.transform).toBe('');
  });

  it('pulls a dropdown that overflows the bottom and right edges back into view', () => {
    // bottom: 700 + 120 + 8 - 768 = 60 over. right: 900 + 140 + 8 - 1024 = 24 over.
    menuRect({ top: 700, left: 900, width: 140, height: 120 });
    renderSelector();

    expect(openMenu()).toHaveStyle({ transform: 'translate(-24px, -60px)' });
  });

  it('keeps the leading edge of a dropdown taller than the viewport on screen', () => {
    // A 900px menu cannot fit: it is pinned at the top margin rather than
    // having its head pushed off-screen.
    menuRect({ top: 100, left: 400, width: 140, height: 900 });
    renderSelector();

    expect(openMenu()).toHaveStyle({ transform: 'translate(0px, -92px)' });
  });
});
