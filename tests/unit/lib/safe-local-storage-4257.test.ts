/**
 * @vitest-environment jsdom
 *
 * Issue #4257: localStorage が例外を投げる環境でも落ちない入口。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { safeLocalStorage } from '@/lib/safe-local-storage';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('safeLocalStorage (Issue #4257)', () => {
  it('使える環境では保存・読み出し・削除がそのまま働く（陰性対照）', () => {
    safeLocalStorage.setItem('k', 'v');
    expect(window.localStorage.getItem('k')).toBe('v');
    expect(safeLocalStorage.getItem('k')).toBe('v');
    safeLocalStorage.removeItem('k');
    expect(safeLocalStorage.getItem('k')).toBeNull();
  });

  it('Storage が例外を投げても読みは null、書き・削除は無視する', () => {
    const boom = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);
    expect(safeLocalStorage.getItem('k')).toBeNull();
    expect(() => safeLocalStorage.setItem('k', 'v')).not.toThrow();
    expect(() => safeLocalStorage.removeItem('k')).not.toThrow();
  });
});
