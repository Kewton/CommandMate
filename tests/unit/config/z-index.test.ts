/**
 * Tests for z-index configuration
 *
 * Validates z-index layer hierarchy and constant values
 * to prevent stacking context issues (Issue #299).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { Z_INDEX } from '@/config/z-index';
import type { ZIndexValue } from '@/config/z-index';

describe('Z_INDEX configuration', () => {
  describe('Constant values', () => {
    it('should define DROPDOWN as 10', () => {
      expect(Z_INDEX.DROPDOWN).toBe(10);
    });

    it('should define SIDEBAR as 30', () => {
      expect(Z_INDEX.SIDEBAR).toBe(30);
    });

    it('should define MODAL as 50', () => {
      expect(Z_INDEX.MODAL).toBe(50);
    });

    it('should define MAXIMIZED_EDITOR as 55', () => {
      expect(Z_INDEX.MAXIMIZED_EDITOR).toBe(55);
    });

    it('should define TOAST as 60', () => {
      expect(Z_INDEX.TOAST).toBe(60);
    });

    it('should define CONTEXT_MENU as 70', () => {
      expect(Z_INDEX.CONTEXT_MENU).toBe(70);
    });
  });

  describe('Layer hierarchy order', () => {
    it('should have DROPDOWN < SIDEBAR', () => {
      expect(Z_INDEX.DROPDOWN).toBeLessThan(Z_INDEX.SIDEBAR);
    });

    it('should have SIDEBAR < MODAL', () => {
      expect(Z_INDEX.SIDEBAR).toBeLessThan(Z_INDEX.MODAL);
    });

    it('should have MODAL < MAXIMIZED_EDITOR', () => {
      expect(Z_INDEX.MODAL).toBeLessThan(Z_INDEX.MAXIMIZED_EDITOR);
    });

    it('should have MAXIMIZED_EDITOR < TOAST', () => {
      expect(Z_INDEX.MAXIMIZED_EDITOR).toBeLessThan(Z_INDEX.TOAST);
    });

    it('should have TOAST < CONTEXT_MENU', () => {
      expect(Z_INDEX.TOAST).toBeLessThan(Z_INDEX.CONTEXT_MENU);
    });

    it('should maintain complete ordering: DROPDOWN < SIDEBAR < MODAL < MAXIMIZED_EDITOR < TOAST < CONTEXT_MENU', () => {
      const orderedValues = [
        Z_INDEX.DROPDOWN,
        Z_INDEX.SIDEBAR,
        Z_INDEX.MODAL,
        Z_INDEX.MAXIMIZED_EDITOR,
        Z_INDEX.TOAST,
        Z_INDEX.CONTEXT_MENU,
      ];

      for (let i = 0; i < orderedValues.length - 1; i++) {
        expect(orderedValues[i]).toBeLessThan(orderedValues[i + 1]);
      }
    });
  });

  describe('Type safety', () => {
    it('should be readonly (as const)', () => {
      // Verify all values are numbers (compile-time check via ZIndexValue)
      const values: ZIndexValue[] = [
        Z_INDEX.DROPDOWN,
        Z_INDEX.SIDEBAR,
        Z_INDEX.MODAL,
        Z_INDEX.MAXIMIZED_EDITOR,
        Z_INDEX.TOAST,
        Z_INDEX.CONTEXT_MENU,
      ];

      values.forEach((value) => {
        expect(typeof value).toBe('number');
      });
    });

    it('should have exactly 6 z-index levels', () => {
      const keys = Object.keys(Z_INDEX);
      expect(keys).toHaveLength(6);
    });

    it('should contain all expected keys', () => {
      const keys = Object.keys(Z_INDEX);
      expect(keys).toContain('DROPDOWN');
      expect(keys).toContain('SIDEBAR');
      expect(keys).toContain('MODAL');
      expect(keys).toContain('MAXIMIZED_EDITOR');
      expect(keys).toContain('TOAST');
      expect(keys).toContain('CONTEXT_MENU');
    });
  });
});
