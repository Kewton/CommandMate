/**
 * @vitest-environment jsdom
 *
 * Issue #4257: Storage が例外を投げても useHistoryFilters が落ちない。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHistoryFilters } from '@/hooks/useHistoryFilters';
import { DEFAULT_MESSAGES_LIMIT } from '@/config/history-display-config';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useHistoryFilters — Storage が使えない (Issue #4257)', () => {
  it('既定値で描画でき、変更しても例外を投げない', () => {
    const boom = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);

    const { result } = renderHook(() => useHistoryFilters());
    expect(result.current.showArchived).toBe(false);
    expect(result.current.historyUserOnly).toBe(false);
    expect(result.current.historyDisplayLimit).toBe(DEFAULT_MESSAGES_LIMIT);

    act(() => {
      result.current.handleShowArchivedChange(true);
    });
    expect(result.current.showArchived).toBe(true);
  });
});
