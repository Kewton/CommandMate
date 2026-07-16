/**
 * SidebarToggle Component
 *
 * Button to toggle sidebar visibility.
 * Shows different icons based on sidebar state.
 */

'use client';

import React, { memo } from 'react';
import { useTranslations } from 'next-intl';
import { useSidebarContext } from '@/contexts/SidebarContext';

// ============================================================================
// Component
// ============================================================================

/**
 * SidebarToggle button component
 *
 * Toggles the sidebar open/closed state.
 *
 * @example
 * ```tsx
 * <SidebarToggle />
 * ```
 */
export const SidebarToggle = memo(function SidebarToggle() {
  const t = useTranslations('common');
  const { isOpen, toggle } = useSidebarContext();

  return (
    <button
      data-testid="sidebar-toggle"
      onClick={toggle}
      aria-label={isOpen ? t('sidebar.close') : t('sidebar.open')}
      aria-expanded={isOpen}
      className={`
        absolute z-10 p-2 rounded-md
        bg-muted hover:bg-muted/80
        text-foreground
        transition-all duration-200
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
        ${isOpen ? 'left-[284px]' : 'left-2'}
        top-16
      `}
    >
      <svg
        className="w-5 h-5 transition-transform duration-200"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        {isOpen ? (
          // Chevron left (close)
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 19l-7-7 7-7"
          />
        ) : (
          // Chevron right (open)
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        )}
      </svg>
    </button>
  );
});
