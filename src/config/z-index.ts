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
 * 7. Radix overlay popovers - Select/DropdownMenu/Tooltip (65)
 * 8. Context menus (70)
 *
 * [Issue #2294] These numbers only order elements that share a stacking
 * context. `main[role="main"]` in AppShell carries `view-transition-name:
 * cm-content` (globals.css, Issue #1122), and any value other than `none`
 * opens a stacking context — so a `fixed` element rendered *inline* inside
 * main is compared against main's siblings as if it were main itself
 * (`position: static; z-index: auto` = 0), not at the value below. The Sidebar
 * (30) is one of those siblings, so an inline overlay at 55 still renders
 * underneath it. Anything at Modal level or above must therefore be drawn
 * through `createPortal(..., document.body)` — as Modal, Toast,
 * FullScreenModal, CommandPalette, the maximized file overlay
 * (FilePanelContent), the MarkdownEditor CSS-fallback fullscreen and
 * ContextMenu all do.
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

  /**
   * Maximized editor overlay - above Modal for iPad fullscreen support.
   * Issue #2294: only effective when the overlay is portalled to document.body
   * (see the stacking-context note above).
   */
  MAXIMIZED_EDITOR: 55,

  /** Toast notifications */
  TOAST: 60,

  /**
   * Radix overlay primitives (Select / DropdownMenu / Tooltip) content.
   * Sits above Modal (50) so popovers opened from within a dialog are not
   * clipped, and below Context menus (70) which remain the topmost layer.
   */
  POPOVER: 65,

  /** Context menus (right-click menus) */
  CONTEXT_MENU: 70,
} as const;

/**
 * Type for Z_INDEX values
 */
export type ZIndexValue = (typeof Z_INDEX)[keyof typeof Z_INDEX];
