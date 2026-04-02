/**
 * Tests for SortSelectorBase component
 *
 * Verifies that the presentational sort selector works without Context dependency.
 * Issue #606: Sessions page enhancement [DP-006]
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { SortSelectorBase } from '@/components/sidebar/SortSelectorBase';
import type { SortOption } from '@/components/sidebar/SortSelectorBase';
import type { SortKey, SortDirection } from '@/lib/sidebar-utils';

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
});
