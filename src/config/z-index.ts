/**
 * Centralized z-index management
 *
 * Defines z-index values for layered UI elements to avoid conflicts.
 * Higher values appear above lower values.
 *
 * @module config/z-index
 */

/**
 * Z-index values for layered UI elements
 *
 * Layer hierarchy (bottom to top):
 * 1. Base content (default stacking)
 * 2. Dropdown menus (10)
 * 3. Maximized editor (40)
 * 4. Modal dialogs (50)
 * 5. Toast notifications (60)
 * 6. Context menus (70)
 */
export const Z_INDEX = {
  /** Dropdown menus and select options */
  DROPDOWN: 10,

  /** Maximized editor overlay */
  MAXIMIZED_EDITOR: 40,

  /** Modal dialogs and overlays */
  MODAL: 50,

  /** Toast notifications */
  TOAST: 60,

  /** Context menus (right-click menus) */
  CONTEXT_MENU: 70,
} as const;

/**
 * Type for Z_INDEX values
 */
export type ZIndexValue = (typeof Z_INDEX)[keyof typeof Z_INDEX];
