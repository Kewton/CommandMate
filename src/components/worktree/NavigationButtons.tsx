'use client';

/**
 * NavigationButtons component for TUI selection list navigation.
 * Issue #473: Provides Up/Down/Enter/Escape buttons for OpenCode TUI interaction.
 *
 * Touch targets: minimum 44x44px for mobile accessibility.
 * Keyboard: Arrow keys intercepted only when component has focus.
 * [DR4-006] No dangerouslySetInnerHTML usage.
 */

import { useCallback, type KeyboardEvent } from 'react';
import type { CLIToolType } from '@/lib/cli-tools/types';

export interface NavigationButtonsProps {
  worktreeId: string;
  cliToolId: CLIToolType;
}

/** Navigation button configuration */
const NAVIGATION_BUTTONS = [
  { key: 'Up', label: '\u25B2', ariaLabel: 'Up' },
  { key: 'Down', label: '\u25BC', ariaLabel: 'Down' },
  { key: 'Enter', label: '\u21B5', ariaLabel: 'Enter' },
  { key: 'Escape', label: 'Esc', ariaLabel: 'Escape' },
] as const;

export function NavigationButtons({ worktreeId, cliToolId }: NavigationButtonsProps) {
  const sendKeys = useCallback(async (keys: string[]) => {
    try {
      await fetch(`/api/worktrees/${encodeURIComponent(worktreeId)}/special-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cliToolId, keys }),
      });
    } catch (err) {
      console.error('Failed to send special keys:', err);
    }
  }, [worktreeId, cliToolId]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    // Only intercept arrow keys when this component has focus
    const keyMap: Record<string, string> = {
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      Enter: 'Enter',
      Escape: 'Escape',
    };
    const mappedKey = keyMap[e.key];
    if (mappedKey) {
      e.preventDefault();
      sendKeys([mappedKey]);
    }
  }, [sendKeys]);

  return (
    <div
      className="flex items-center gap-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700"
      onKeyDown={handleKeyDown}
      role="toolbar"
      aria-label="TUI Navigation"
    >
      <span className="text-xs text-gray-500 dark:text-gray-400 mr-1">Nav</span>
      {NAVIGATION_BUTTONS.map(({ key, label, ariaLabel }) => (
        <button
          key={key}
          type="button"
          className="min-w-[44px] min-h-[44px] px-3 py-2 text-sm font-medium rounded-md
            bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600
            hover:bg-gray-50 dark:hover:bg-gray-600
            focus:outline-none focus:ring-2 focus:ring-blue-500
            active:bg-gray-100 dark:active:bg-gray-500
            transition-colors"
          aria-label={ariaLabel}
          onClick={() => sendKeys([key])}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
