/**
 * Header Component
 * Main application header with navigation
 *
 * Issue #600: UX refresh - PC horizontal navigation
 * Sessions | Repos | Review | Settings
 *
 * Issue #2642: Home / Chat を外して 4 項目にした。ロゴは `/` へのリンクのまま
 * Issue #2709: 「設定」は `/more` へのリンクのまま、素の左クリックだけ設定モーダルを開く
 */

'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { TransitionLink } from '@/components/view-transitions/TransitionLink';
import { useTranslations } from 'next-intl';
import { Folder, Github, Search } from 'lucide-react';
import { PcDisplaySizeSelector } from './PcDisplaySizeSelector';
import { RepositoryTabBarModeSelector } from './RepositoryTabBarModeSelector';
import { ThemeToggle } from '@/components/common/ThemeToggle';
import { ConnectionStatusIndicator } from '@/components/common/ConnectionStatusIndicator';
import { AppUpdateButton } from '@/components/common/AppUpdateButton';
import { Kbd } from '@/components/ui/Kbd';
import { useCommandPalette } from '@/contexts/CommandPaletteContext';
import { useSettingsDialog } from '@/contexts/SettingsDialogContext';

export interface HeaderProps {
  title?: string;
}

/**
 * Navigation items for the PC header.
 * Each entry maps a `common` translation key to a href and a pathname match function.
 *
 * The header abbreviates where the mobile bar does not: `repositoriesShort`
 * ("Repos") keeps the space-x-6 row from overflowing, and `reviewReport`
 * ("Review/Report") preserves that /review also covers reports.
 */
const NAV_ITEMS: Array<{
  labelKey: string;
  href: string;
  isActive: (pathname: string) => boolean;
  /** Issue #2709: a plain left-click opens the settings modal instead. */
  opensSettings?: boolean;
}> = [
  { labelKey: 'nav.sessions', href: '/sessions', isActive: (p) => p.startsWith('/sessions') },
  { labelKey: 'nav.repositoriesShort', href: '/repositories', isActive: (p) => p.startsWith('/repositories') },
  { labelKey: 'nav.reviewReport', href: '/review', isActive: (p) => p.startsWith('/review') },
  { labelKey: 'nav.more', href: '/more', isActive: (p) => p.startsWith('/more'), opensSettings: true },
];

/**
 * Application header with branding and 4-screen navigation.
 *
 * @example
 * ```tsx
 * <Header title="CommandMate" />
 * ```
 */
export function Header({ title = 'CommandMate' }: HeaderProps) {
  const pathname = usePathname();
  const t = useTranslations('commandPalette');
  const tCommon = useTranslations('common');
  const { setOpen } = useCommandPalette();

  // Platform-specific modifier resolved after mount to avoid SSR hydration
  // mismatch (server can't know the OS). Null until then → no key badge shown.
  const [modKey, setModKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    const isMac =
      typeof navigator !== 'undefined' &&
      /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '');
    setModKey(isMac ? '⌘' : 'Ctrl');
  }, []);

  const { open: openSettings } = useSettingsDialog();

  // Issue #2709: "Settings" stays an <a href="/more"> — the active
  // underline, the accessible name and ⌘-click / middle-click all depend on it
  // being a real link — but a plain left-click opens the modal instead of
  // navigating. TransitionLink runs this handler first and bails on
  // defaultPrevented, so the modified-click path is untouched.
  const handleSettingsClick = React.useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      openSettings();
    },
    [openSettings]
  );

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background supports-[backdrop-filter]:bg-background/80 backdrop-blur-md">
      <div className="container-custom">
        <div className="flex items-center justify-between h-16">
          {/* Logo and Title */}
          <div className="flex items-center space-x-4">
            <TransitionLink href="/" className="flex items-center space-x-2 hover:opacity-80 transition-opacity">
              <div className="w-8 h-8 bg-accent-600 rounded-lg flex items-center justify-center">
                <Folder size={20} strokeWidth={2} className="text-white" aria-hidden="true" />
              </div>
              <h1 className="text-xl font-bold text-foreground">{title}</h1>
            </TransitionLink>
          </div>

          {/* Navigation */}
          <nav className="flex items-center space-x-6" role="navigation">
            {NAV_ITEMS.map((item) => {
              const active = item.isActive(pathname);
              return (
                <TransitionLink
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  aria-haspopup={item.opensSettings ? 'dialog' : undefined}
                  onClick={item.opensSettings ? handleSettingsClick : undefined}
                  className={`relative py-1 text-sm font-medium transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent-600 dark:after:bg-accent-400 after:origin-center motion-safe:after:transition-transform after:duration-200 after:ease-[var(--motion-ease-out)] ${
                    active
                      ? 'text-accent-600 dark:text-accent-400 after:scale-x-100'
                      : 'text-muted-foreground hover:text-foreground after:scale-x-0'
                  }`}
                >
                  {tCommon(item.labelKey)}
                </TransitionLink>
              );
            })}
            {/* ⌘K command palette entry point (Issue #1077) - desktop only */}
            <button
              type="button"
              data-testid="header-command-palette-trigger"
              onClick={() => setOpen(true)}
              aria-label={t('mobileTrigger')}
              className="hidden md:inline-flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-surface-2 transition-colors"
            >
              <Search size={16} strokeWidth={2} aria-hidden="true" className="shrink-0" />
              <span>{t('searchAction')}</span>
              {modKey && (
                <span className="flex items-center gap-0.5">
                  <Kbd>{modKey}</Kbd>
                  <Kbd>K</Kbd>
                </span>
              )}
            </button>
            {/* Realtime connection status (Issue #1120) - only shows when the
                live push connection is down (polling fallback active). */}
            <ConnectionStatusIndicator />
            {/* PC display size selector (Issue #915) - hidden on mobile */}
            <PcDisplaySizeSelector />
            {/* Repository tab strip visibility (Issue #2374) - hidden on mobile */}
            <RepositoryTabBarModeSelector />
            {/* App update entry point (Issue #2654) - hidden on mobile */}
            <AppUpdateButton />
            {/* Theme toggle promoted to the header (Issue #1071) */}
            <ThemeToggle />
            <a
              href="https://github.com/kewton/MyCodeBranchDesk"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center space-x-1"
            >
              <Github size={20} strokeWidth={2} aria-hidden="true" />
              <span>GitHub</span>
            </a>
          </nav>
        </div>
      </div>
    </header>
  );
}
