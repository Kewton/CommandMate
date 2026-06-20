/**
 * Unit tests for PcDisplaySizeSelector (Issue #915)
 *
 * Verifies the PC-only display-size dropdown: rendering, persistence, and that
 * it is hidden on mobile.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const mockIsMobile = vi.fn(() => false);
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile(),
  MOBILE_BREAKPOINT: 768,
}));

import { PcDisplaySizeProvider } from '@/contexts/PcDisplaySizeContext';
import { PcDisplaySizeSelector } from '@/components/layout/PcDisplaySizeSelector';
import { PC_DISPLAY_SIZE_STORAGE_KEY } from '@/hooks/usePcDisplaySize';

describe('PcDisplaySizeSelector (Issue #915)', () => {
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (key: string) => mockStorage[key] ?? null,
        setItem: (key: string, value: string) => {
          mockStorage[key] = value;
        },
        removeItem: (key: string) => {
          delete mockStorage[key];
        },
        clear: () => {
          mockStorage = {};
        },
      },
      writable: true,
    });
    mockIsMobile.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const renderSelector = () =>
    render(
      <PcDisplaySizeProvider>
        <PcDisplaySizeSelector />
      </PcDisplaySizeProvider>
    );

  it('renders the selector with all four sizes on PC, defaulting to medium', () => {
    renderSelector();
    const select = screen.getByTestId('pc-display-size-select') as HTMLSelectElement;
    expect(select).toBeDefined();
    expect(select.options).toHaveLength(4);
    expect(select.value).toBe('medium');
    // Issue #918: the accessible label is localized via next-intl
    // (`common.displaySize.ariaLabel`) rather than a hard-coded Japanese string.
    // The global next-intl mock (tests/setup.ts) echoes the full key.
    expect(screen.getByLabelText('common.displaySize.ariaLabel')).toBeDefined();
  });

  it('labels each size option from the i18n dictionary, not hard-coded Japanese (Issue #918)', () => {
    renderSelector();
    const select = screen.getByTestId('pc-display-size-select') as HTMLSelectElement;
    const optionText = Array.from(select.options).map((o) => o.textContent);
    expect(optionText).toEqual([
      'common.displaySize.large',
      'common.displaySize.medium',
      'common.displaySize.small',
      'common.displaySize.xsmall',
    ]);
    // No raw Japanese label should leak through (regression guard for the bug).
    expect(optionText).not.toContain('大');
    expect(optionText).not.toContain('極小');
  });

  it('persists the chosen size to localStorage on change', () => {
    renderSelector();
    const select = screen.getByTestId('pc-display-size-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'small' } });
    expect(select.value).toBe('small');
    expect(mockStorage[PC_DISPLAY_SIZE_STORAGE_KEY]).toBe(JSON.stringify('small'));
  });

  it('is hidden on mobile', () => {
    mockIsMobile.mockReturnValue(true);
    renderSelector();
    expect(screen.queryByTestId('pc-display-size-select')).toBeNull();
  });
});
