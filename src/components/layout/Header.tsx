/**
 * Header Component
 * Main application header with navigation
 *
 * Issue #600: UX refresh - PC 5-screen horizontal navigation
 * Home | Sessions | Repos | Review | More
 */

'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Folder, Github, Search } from 'lucide-react';
import { PcDisplaySizeSelector } from './PcDisplaySizeSelector';
import { ThemeToggle } from '@/components/common/ThemeToggle';
import { Kbd } from '@/components/ui/Kbd';
import { useCommandPalette } from '@/contexts/CommandPaletteContext';

export interface HeaderProps {
  title?: string;
}

/**
 * Navigation items for the PC header.
 * Each entry maps a label to a href and a pathname match function.
 */
const NAV_ITEMS: Array<{ label: string; href: string; isActive: (pathname: string) => boolean }> = [
  { label: 'Home', href: '/', isActive: (p) => p === '/' },
  { label: 'Chat', href: '/chat', isActive: (p) => p.startsWith('/chat') },
  { label: 'Sessions', href: '/sessions', isActive: (p) => p.startsWith('/sessions') },
  { label: 'Repos', href: '/repositories', isActive: (p) => p.startsWith('/repositories') },
  { label: 'Review/Report', href: '/review', isActive: (p) => p.startsWith('/review') },
  { label: 'More', href: '/more', isActive: (p) => p.startsWith('/more') },
];

/**
 * Application header with branding and 5-screen navigation.
 *
 * @example
 * ```tsx
 * <Header title="CommandMate" />
 * ```
 */
export function Header({ title = 'CommandMate' }: HeaderProps) {
  const pathname = usePathname();
  const t = useTranslations('commandPalette');
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

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background supports-[backdrop-filter]:bg-background/80 backdrop-blur-md">
      <div className="container-custom">
        <div className="flex items-center justify-between h-16">
          {/* Logo and Title */}
          <div className="flex items-center space-x-4">
            <Link href="/" className="flex items-center space-x-2 hover:opacity-80 transition-opacity">
              <div className="w-8 h-8 bg-accent-600 rounded-lg flex items-center justify-center">
                <Folder size={20} strokeWidth={2} className="text-white" aria-hidden="true" />
              </div>
              <h1 className="text-xl font-bold text-foreground">{title}</h1>
            </Link>
          </div>

          {/* Navigation */}
          <nav className="flex items-center space-x-6" role="navigation">
            {NAV_ITEMS.map((item) => {
              const active = item.isActive(pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`text-sm font-medium transition-colors ${
                    active
                      ? 'text-accent-600 dark:text-accent-400'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            {/* ⌘K command palette entry point (Issue #1077) - desktop only */}
            <button
              type="button"
              data-testid="header-command-palette-trigger"
              onClick={() => setOpen(true)}
              aria-label={t('mobileTrigger')}
              className="hidden md:inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-surface-2 transition-colors"
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
            {/* PC display size selector (Issue #915) - hidden on mobile */}
            <PcDisplaySizeSelector />
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
