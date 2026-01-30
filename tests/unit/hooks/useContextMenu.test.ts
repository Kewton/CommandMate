/**
 * Tests for useContextMenu hook
 *
 * @module tests/unit/hooks/useContextMenu
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useContextMenu } from '@/hooks/useContextMenu';

describe('useContextMenu', () => {
  describe('initial state', () => {
    it('should return closed menu state by default', () => {
      const { result } = renderHook(() => useContextMenu());

      expect(result.current.menuState.isOpen).toBe(false);
      expect(result.current.menuState.position).toEqual({ x: 0, y: 0 });
      expect(result.current.menuState.targetPath).toBeNull();
      expect(result.current.menuState.targetType).toBeNull();
    });

    it('should return openMenu, closeMenu, and resetMenu functions', () => {
      const { result } = renderHook(() => useContextMenu());

      expect(typeof result.current.openMenu).toBe('function');
      expect(typeof result.current.closeMenu).toBe('function');
      expect(typeof result.current.resetMenu).toBe('function');
    });
  });

  describe('openMenu', () => {
    it('should open menu at specified position for a file', () => {
      const { result } = renderHook(() => useContextMenu());

      const mockEvent = {
        preventDefault: vi.fn(),
        clientX: 100,
        clientY: 200,
      } as unknown as React.MouseEvent;

      act(() => {
        result.current.openMenu(mockEvent, 'docs/readme.md', 'file');
      });

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(result.current.menuState.isOpen).toBe(true);
      expect(result.current.menuState.position).toEqual({ x: 100, y: 200 });
      expect(result.current.menuState.targetPath).toBe('docs/readme.md');
      expect(result.current.menuState.targetType).toBe('file');
    });

    it('should open menu at specified position for a directory', () => {
      const { result } = renderHook(() => useContextMenu());

      const mockEvent = {
        preventDefault: vi.fn(),
        clientX: 150,
        clientY: 250,
      } as unknown as React.MouseEvent;

      act(() => {
        result.current.openMenu(mockEvent, 'src', 'directory');
      });

      expect(result.current.menuState.isOpen).toBe(true);
      expect(result.current.menuState.targetPath).toBe('src');
      expect(result.current.menuState.targetType).toBe('directory');
    });

    it('should replace previous menu state when opening at new location', () => {
      const { result } = renderHook(() => useContextMenu());

      const mockEvent1 = {
        preventDefault: vi.fn(),
        clientX: 100,
        clientY: 100,
      } as unknown as React.MouseEvent;

      const mockEvent2 = {
        preventDefault: vi.fn(),
        clientX: 200,
        clientY: 200,
      } as unknown as React.MouseEvent;

      act(() => {
        result.current.openMenu(mockEvent1, 'file1.md', 'file');
      });

      act(() => {
        result.current.openMenu(mockEvent2, 'file2.md', 'file');
      });

      expect(result.current.menuState.position).toEqual({ x: 200, y: 200 });
      expect(result.current.menuState.targetPath).toBe('file2.md');
    });
  });

  describe('closeMenu', () => {
    it('should close the menu while preserving target info', () => {
      const { result } = renderHook(() => useContextMenu());

      const mockEvent = {
        preventDefault: vi.fn(),
        clientX: 100,
        clientY: 200,
      } as unknown as React.MouseEvent;

      act(() => {
        result.current.openMenu(mockEvent, 'docs/readme.md', 'file');
      });

      act(() => {
        result.current.closeMenu();
      });

      expect(result.current.menuState.isOpen).toBe(false);
      // Target info is preserved for potential use after closing
      expect(result.current.menuState.targetPath).toBe('docs/readme.md');
      expect(result.current.menuState.targetType).toBe('file');
    });
  });

  describe('resetMenu', () => {
    it('should reset all menu state to initial values', () => {
      const { result } = renderHook(() => useContextMenu());

      const mockEvent = {
        preventDefault: vi.fn(),
        clientX: 100,
        clientY: 200,
      } as unknown as React.MouseEvent;

      act(() => {
        result.current.openMenu(mockEvent, 'docs/readme.md', 'file');
      });

      act(() => {
        result.current.resetMenu();
      });

      expect(result.current.menuState.isOpen).toBe(false);
      expect(result.current.menuState.position).toEqual({ x: 0, y: 0 });
      expect(result.current.menuState.targetPath).toBeNull();
      expect(result.current.menuState.targetType).toBeNull();
    });
  });

  describe('callback stability', () => {
    it('should have stable openMenu callback reference', () => {
      const { result, rerender } = renderHook(() => useContextMenu());

      const openMenu1 = result.current.openMenu;
      rerender();
      const openMenu2 = result.current.openMenu;

      expect(openMenu1).toBe(openMenu2);
    });

    it('should have stable closeMenu callback reference', () => {
      const { result, rerender } = renderHook(() => useContextMenu());

      const closeMenu1 = result.current.closeMenu;
      rerender();
      const closeMenu2 = result.current.closeMenu;

      expect(closeMenu1).toBe(closeMenu2);
    });

    it('should have stable resetMenu callback reference', () => {
      const { result, rerender } = renderHook(() => useContextMenu());

      const resetMenu1 = result.current.resetMenu;
      rerender();
      const resetMenu2 = result.current.resetMenu;

      expect(resetMenu1).toBe(resetMenu2);
    });
  });

  describe('click outside handling', () => {
    beforeEach(() => {
      // Mock document.addEventListener
      vi.spyOn(document, 'addEventListener');
      vi.spyOn(document, 'removeEventListener');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should add click listener when menu is open', async () => {
      const { result } = renderHook(() => useContextMenu());

      const mockEvent = {
        preventDefault: vi.fn(),
        clientX: 100,
        clientY: 200,
      } as unknown as React.MouseEvent;

      act(() => {
        result.current.openMenu(mockEvent, 'docs/readme.md', 'file');
      });

      await waitFor(() => {
        expect(document.addEventListener).toHaveBeenCalledWith(
          'click',
          expect.any(Function)
        );
      });
    });

    it('should remove click listener when menu is closed', async () => {
      const { result } = renderHook(() => useContextMenu());

      const mockEvent = {
        preventDefault: vi.fn(),
        clientX: 100,
        clientY: 200,
      } as unknown as React.MouseEvent;

      act(() => {
        result.current.openMenu(mockEvent, 'docs/readme.md', 'file');
      });

      act(() => {
        result.current.closeMenu();
      });

      await waitFor(() => {
        expect(document.removeEventListener).toHaveBeenCalledWith(
          'click',
          expect.any(Function)
        );
      });
    });
  });

  describe('ESC key handling', () => {
    beforeEach(() => {
      vi.spyOn(document, 'addEventListener');
      vi.spyOn(document, 'removeEventListener');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should add keydown listener when menu is open', async () => {
      const { result } = renderHook(() => useContextMenu());

      const mockEvent = {
        preventDefault: vi.fn(),
        clientX: 100,
        clientY: 200,
      } as unknown as React.MouseEvent;

      act(() => {
        result.current.openMenu(mockEvent, 'docs/readme.md', 'file');
      });

      await waitFor(() => {
        expect(document.addEventListener).toHaveBeenCalledWith(
          'keydown',
          expect.any(Function)
        );
      });
    });

    it('should close menu when ESC key is pressed', async () => {
      const { result } = renderHook(() => useContextMenu());

      const mockEvent = {
        preventDefault: vi.fn(),
        clientX: 100,
        clientY: 200,
      } as unknown as React.MouseEvent;

      act(() => {
        result.current.openMenu(mockEvent, 'docs/readme.md', 'file');
      });

      // Simulate ESC key press
      act(() => {
        const escEvent = new KeyboardEvent('keydown', { key: 'Escape' });
        document.dispatchEvent(escEvent);
      });

      await waitFor(() => {
        expect(result.current.menuState.isOpen).toBe(false);
      });
    });
  });
});
