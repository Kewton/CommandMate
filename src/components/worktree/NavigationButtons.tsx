'use client';

/**
 * NavigationButtons component for TUI selection list navigation.
 * Issue #473: Provides Up/Down/Enter/Escape buttons for OpenCode TUI interaction.
 *
 * Touch targets: minimum 44x44px for mobile accessibility.
 * Keyboard: Arrow keys intercepted only when component has focus.
 * [DR4-006] No dangerouslySetInnerHTML usage.
 */

import { useCallback, useState, type KeyboardEvent } from 'react';
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
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const sendKeys = useCallback((keys: string[]) => {
    // Show immediate visual feedback
    setActiveKey(keys[0]);
    setTimeout(() => setActiveKey(null), 150);

    // Fire-and-forget: don't await the fetch to avoid perceived latency
    fetch(`/api/worktrees/${encodeURIComponent(worktreeId)}/special-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliToolId, keys }),
    }).catch((err) => {
      console.error('Failed to send special keys:', err);
    });
  }, [worktreeId, cliToolId]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
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
      className="flex items-center gap-1.5 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-lg"
      onKeyDown={handleKeyDown}
      role="toolbar"
      aria-label="TUI Navigation"
    >
      <span className="text-xs text-gray-500 dark:text-gray-400 mx-2">Nav</span>
      {NAVIGATION_BUTTONS.map(({ key, label, ariaLabel }) => (
        <button
          key={key}
          type="button"
          className={`min-w-[44px] min-h-[44px] px-3 py-2 text-sm font-medium rounded-md
            border border-gray-300 dark:border-gray-600
            focus:outline-none focus:ring-2 focus:ring-blue-500
            transition-colors duration-75
            ${activeKey === key
              ? 'bg-blue-500 text-white border-blue-500 scale-95'
              : 'bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 active:bg-gray-100 dark:active:bg-gray-500'
            }`}
          aria-label={ariaLabel}
          onClick={() => sendKeys([key])}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
