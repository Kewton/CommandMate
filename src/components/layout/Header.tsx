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
import { Folder, Github } from 'lucide-react';
import { PcDisplaySizeSelector } from './PcDisplaySizeSelector';

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

  return (
    <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 sticky top-0 z-50">
      <div className="container-custom">
        <div className="flex items-center justify-between h-16">
          {/* Logo and Title */}
          <div className="flex items-center space-x-4">
            <Link href="/" className="flex items-center space-x-2 hover:opacity-80 transition-opacity">
              <div className="w-8 h-8 bg-accent-600 rounded-lg flex items-center justify-center">
                <Folder size={20} strokeWidth={2} className="text-white" aria-hidden="true" />
              </div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
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
                      : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            {/* PC display size selector (Issue #915) - hidden on mobile */}
            <PcDisplaySizeSelector />
            <a
              href="https://github.com/kewton/MyCodeBranchDesk"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 transition-colors flex items-center space-x-1"
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
