/**
 * SidebarToggle Component
 *
 * Button to toggle sidebar visibility.
 * Shows different icons based on sidebar state.
 */

'use client';

import React, { memo } from 'react';
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
  const { isOpen, toggle } = useSidebarContext();

  return (
    <button
      data-testid="sidebar-toggle"
      onClick={toggle}
      aria-label={isOpen ? 'Close sidebar' : 'Open sidebar'}
      aria-expanded={isOpen}
      className={`
        absolute z-10 p-2 rounded-md
        bg-gray-800 hover:bg-gray-700
        text-gray-300 hover:text-white
        transition-all duration-200
        focus:outline-none focus:ring-2 focus:ring-blue-500
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
