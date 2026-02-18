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
 * 3. Sidebar (30) - Desktop layout only
 * 4. Modal dialogs (50)
 * 5. Maximized editor overlay (55)
 * 6. Toast notifications (60)
 * 7. Context menus (70)
 */
export const Z_INDEX = {
  /** Dropdown menus and select options */
  DROPDOWN: 10,

  /**
   * Desktop sidebar - Issue #112: transform-based animation
   * Note: Mobile uses MobileHeader (z-40) and drawer (z-50) in separate hierarchy
   */
  SIDEBAR: 30,

  /** Modal dialogs and overlays */
  MODAL: 50,

  /** Maximized editor overlay - above Modal for iPad fullscreen support */
  MAXIMIZED_EDITOR: 55,

  /** Toast notifications */
  TOAST: 60,

  /** Context menus (right-click menus) */
  CONTEXT_MENU: 70,
} as const;

/**
 * Type for Z_INDEX values
 */
export type ZIndexValue = (typeof Z_INDEX)[keyof typeof Z_INDEX];
