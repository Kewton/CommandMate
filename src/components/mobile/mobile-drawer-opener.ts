/**
 * The phone's drawer openers (Issue #3515).
 *
 * The buttons that open the mobile drawer — the bottom tab bar's "Branches"
 * (`GlobalMobileNav`, #2642) and the worktree header's ☰ (`MobileHeader`) —
 * carry {@link MOBILE_DRAWER_OPENER_ATTR}. When the drawer closes with focus
 * inside it (a row was tapped: × , New task, search, a destination), AppShell
 * moves focus to the opener on screen, so a dialog or the command palette
 * opened from the drawer records that opener and returns focus there on
 * close, not to a button in the closed, off-screen drawer.
 *
 * @module components/mobile/mobile-drawer-opener
 */

/** Attribute on every button that opens the mobile drawer. */
export const MOBILE_DRAWER_OPENER_ATTR = 'data-mobile-drawer-opener';

/** Spread onto an opener button. */
export const MOBILE_DRAWER_OPENER_PROPS = { [MOBILE_DRAWER_OPENER_ATTR]: '' } as const;

/**
 * Focus the drawer opener on screen. Only one is mounted at a time (the bottom
 * tab bar is absent on `/worktrees/*`, which is the only screen with the ☰).
 * Returns false when there is none.
 */
export function focusMobileDrawerOpener(doc: Document = document): boolean {
  const opener = doc.querySelector<HTMLElement>(`[${MOBILE_DRAWER_OPENER_ATTR}]`);
  if (!opener) return false;
  opener.focus();
  return true;
}
