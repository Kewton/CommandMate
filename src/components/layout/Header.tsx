/**
 * Header Component
 * The PC screen header on every shell screen except `/worktrees/*`.
 *
 * Issue #600: UX refresh - PC horizontal navigation
 * Issue #2642: Home / Chat を外して 4 項目にした
 * Issue #2709: 「設定」は素の左クリックで設定モーダルを開いた
 *
 * Issue #3512: the header is the screen's name and the screen's state only.
 * Everything else moved to the sidebar, which on the PC is always there either
 * open or as the icon rail (`SidebarRail`):
 *
 * | was in the header            | now                                              |
 * |------------------------------|--------------------------------------------------|
 * | logo → `/`                   | sidebar top row (`SidebarTopControls`)           |
 * | Sessions / Repos / Review    | sidebar rows, rail icons                         |
 * | Settings (modal)             | `SettingsMenu` → Settings… (sidebar footer, rail)|
 * | ⌘K search pill               | sidebar search row, rail search icon, ⌘K         |
 * | display size / repo tab mode | `SettingsMenu` (`showDisplayPreferences`)        |
 * | theme toggle / GitHub        | `SettingsMenu`                                   |
 *
 * Kept here, under the same conditions as before: `ConnectionStatusIndicator`
 * (shows only while the live connection is down) and `AppUpdateButton` (only
 * while an update is available).
 *
 * Issue #3579: no band, and no second screen name. Every screen in
 * `SCREEN_TITLE_KEYS` names itself in its own <h1>, so the header no longer
 * repeats it; only a screen without a name of its own (`/`, the first-run
 * screen) keeps the `title` fallback here. A 64px full-width band pushed the
 * sidebar / icon rail (and the open/close button) down on the list screens
 * only; what is left is a row at the top of the content column (AppShell puts
 * it in <main>, right of the sidebar), which collapses to nothing
 * (`empty:hidden`) while it has nothing to show.
 */

'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { ConnectionStatusIndicator } from '@/components/common/ConnectionStatusIndicator';
import { AppUpdateButton } from '@/components/common/AppUpdateButton';

export interface HeaderProps {
  /** Shown on screens without a name of their own (`/`). */
  title?: string;
}

/**
 * Screens that name themselves (their page draws the <h1>), per route prefix,
 * with the `common` key of that name. First match wins.
 */
export const SCREEN_TITLE_KEYS: ReadonlyArray<{ prefix: string; labelKey: string }> = [
  { prefix: '/sessions', labelKey: 'nav.sessions' },
  { prefix: '/repositories', labelKey: 'nav.repositories' },
  { prefix: '/review', labelKey: 'nav.review' },
  { prefix: '/skills', labelKey: 'nav.skills' },
  { prefix: '/more', labelKey: 'nav.more' },
];

/** The `common` key naming the screen at `pathname`, or null (use the title prop). */
export function resolveScreenTitleKey(pathname: string): string | null {
  return SCREEN_TITLE_KEYS.find((entry) => pathname.startsWith(entry.prefix))?.labelKey ?? null;
}

/**
 * Screen status row: the fallback title where the screen has no name of its
 * own, then the connection status and the app update button, right aligned.
 * Takes no height while none of them has anything to show.
 *
 * @example
 * ```tsx
 * <Header title="CommandMate" />
 * ```
 */
export function Header({ title = 'CommandMate' }: HeaderProps) {
  const pathname = usePathname() ?? '';
  const namedByPage = resolveScreenTitleKey(pathname) !== null;

  return (
    <header
      data-testid="screen-status-row"
      className="flex flex-shrink-0 items-center justify-end gap-4 px-4 py-1.5 border-b border-border bg-background supports-[backdrop-filter]:bg-background/80 backdrop-blur-md empty:hidden"
    >
      {!namedByPage && (
        <h1 data-testid="header-screen-title" className="mr-auto min-w-0 truncate text-lg font-bold text-foreground">
          {title}
        </h1>
      )}
      {/* Realtime connection status (Issue #1120) - only shows when the
          live push connection is down (polling fallback active). */}
      <ConnectionStatusIndicator />
      {/* App update entry point (Issue #2654) - hidden on mobile */}
      <AppUpdateButton />
    </header>
  );
}
