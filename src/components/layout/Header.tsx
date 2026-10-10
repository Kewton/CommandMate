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
 */

'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ConnectionStatusIndicator } from '@/components/common/ConnectionStatusIndicator';
import { AppUpdateButton } from '@/components/common/AppUpdateButton';

export interface HeaderProps {
  /** Shown on screens without a name of their own (`/`). */
  title?: string;
}

/** Screen name per route prefix, as a `common` translation key. First match wins. */
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
 * Screen header: the screen's name, then the connection status and the app
 * update button.
 *
 * @example
 * ```tsx
 * <Header title="CommandMate" />
 * ```
 */
export function Header({ title = 'CommandMate' }: HeaderProps) {
  const pathname = usePathname() ?? '';
  const tCommon = useTranslations('common');
  const titleKey = resolveScreenTitleKey(pathname);

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background supports-[backdrop-filter]:bg-background/80 backdrop-blur-md">
      <div className="container-custom">
        <div className="flex items-center justify-between h-16">
          <h1 data-testid="header-screen-title" className="min-w-0 truncate text-xl font-bold text-foreground">
            {titleKey ? tCommon(titleKey) : title}
          </h1>
          <div className="flex items-center gap-4">
            {/* Realtime connection status (Issue #1120) - only shows when the
                live push connection is down (polling fallback active). */}
            <ConnectionStatusIndicator />
            {/* App update entry point (Issue #2654) - hidden on mobile */}
            <AppUpdateButton />
          </div>
        </div>
      </div>
    </header>
  );
}
