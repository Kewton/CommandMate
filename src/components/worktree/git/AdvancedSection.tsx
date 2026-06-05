/**
 * AdvancedSection (Issue #815)
 *
 * Collapsible wrapper for the GitPane "Advanced operations" group: Fetch,
 * Branches (create/delete), Stash, and Danger Zone. Rendered below Commit
 * History and collapsed by default; the open/close state is persisted by the
 * caller (localStorage key `commandmate:gitPane:advancedOpen`).
 *
 * Pure layout: it only shows/hides its children. All section logic and handlers
 * live in the children, unchanged.
 */

'use client';

import React, { memo } from 'react';

interface AdvancedSectionProps {
  /** Whether the advanced group is expanded. */
  open: boolean;
  /** Toggle the expanded state (caller persists it). */
  onToggle: () => void;
  children: React.ReactNode;
}

export const AdvancedSection = memo(function AdvancedSection({
  open,
  onToggle,
  children,
}: AdvancedSectionProps) {
  return (
    <div
      className="flex flex-col border-t border-gray-200 dark:border-gray-700"
      data-testid="git-advanced-section"
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 cursor-pointer hover:text-gray-900 dark:hover:text-gray-100"
        data-testid="git-advanced-toggle"
        aria-expanded={open}
      >
        <span className="text-xs w-4 text-center">{open ? '▼' : '▶'}</span>
        Advanced operations
      </button>

      {open && (
        <div className="flex flex-col" data-testid="git-advanced-content">
          {children}
        </div>
      )}
    </div>
  );
});

export default AdvancedSection;
