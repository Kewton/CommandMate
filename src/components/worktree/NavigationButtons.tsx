'use client';

/**
 * NavigationButtons component for TUI selection list navigation.
 * Issue #473: Provides Up/Down/Enter/Escape buttons for OpenCode TUI interaction.
 * Issue #592: Added Left/Right buttons for Copilot reasoning effort adjustment.
 *
 * Touch targets: minimum 44x44px for mobile accessibility.
 * Keyboard: Arrow keys intercepted only when component has focus.
 * [DR4-006] No dangerouslySetInnerHTML usage.
 */

import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { NavigationKey } from '@/lib/tmux/tmux';
import { useSpecialKeys } from '@/hooks/useSpecialKeys';
import { KEY_PRESS_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';

export interface NavigationButtonsProps {
  worktreeId: string;
  cliToolId: CLIToolType;
  /**
   * Issue #869: agent instance id to target. Defaults to the primary instance
   * (`=== cliToolId`) when omitted, preserving pre-#869 behavior.
   */
  instanceId?: string;
  /** Optional callback to trigger immediate terminal refresh after key send */
  onKeysSent?: () => void;
  /**
   * Issue #1017: when true, append the Codex pager / edit-previous keys
   * (PgUp/PgDn/Home/End/q) so the read-only terminal can scroll and quit the
   * transcript pager. Off by default \u2014 the base arrow/Enter/Esc set is unchanged
   * for every existing selection-list (e.g. /model) caller.
   */
  showPagerKeys?: boolean;
}

/** Base navigation button configuration (arrow-key selection lists). */
const NAVIGATION_BUTTONS: ReadonlyArray<{ key: NavigationKey; label: string; ariaLabel: string }> = [
  { key: 'Left', label: '\u25C0', ariaLabel: 'Left' },
  { key: 'Up', label: '\u25B2', ariaLabel: 'Up' },
  { key: 'Down', label: '\u25BC', ariaLabel: 'Down' },
  { key: 'Right', label: '\u25B6', ariaLabel: 'Right' },
  { key: 'Enter', label: '\u21B5', ariaLabel: 'Enter' },
  { key: 'Escape', label: 'Esc', ariaLabel: 'Escape' },
];

/**
 * Issue #1017: Codex pager / edit-previous mode keys, appended when showPagerKeys
 * is set. PgUp/PgDn/Home/End scroll the transcript; 'q' quits the pager.
 */
const PAGER_BUTTONS: ReadonlyArray<{ key: NavigationKey; label: string; ariaLabel: string }> = [
  { key: 'PageUp', label: 'PgUp', ariaLabel: 'Page Up' },
  { key: 'PageDown', label: 'PgDn', ariaLabel: 'Page Down' },
  { key: 'Home', label: 'Home', ariaLabel: 'Home' },
  { key: 'End', label: 'End', ariaLabel: 'End' },
  { key: 'q', label: 'q', ariaLabel: 'Quit pager' },
];

export function NavigationButtons({ worktreeId, cliToolId, instanceId, onKeysSent, showPagerKeys = false }: NavigationButtonsProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const send = useSpecialKeys(worktreeId, cliToolId, instanceId, onKeysSent);

  const sendKeys = useCallback((keys: string[]) => {
    // Show immediate visual feedback, then delegate to the shared sender.
    setActiveKey(keys[0]);
    setTimeout(() => setActiveKey(null), KEY_PRESS_FEEDBACK_RESET_MS);
    send(keys);
  }, [send]);

  const buttons = useMemo(
    () => (showPagerKeys ? [...NAVIGATION_BUTTONS, ...PAGER_BUTTONS] : NAVIGATION_BUTTONS),
    [showPagerKeys],
  );

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    // Only arrow/Enter/Escape are handled via keyboard; the pager 'q'/PgUp/etc.
    // remain click-only to avoid capturing the literal 'q' character.
    const keyMap: Record<string, string> = {
      ArrowLeft: 'Left',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowRight: 'Right',
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
      className="flex flex-wrap items-center gap-1.5 py-1.5 bg-muted rounded-lg"
      onKeyDown={handleKeyDown}
      role="toolbar"
      aria-label="TUI Navigation"
    >
      <span className="text-xs text-muted-foreground mx-2">Nav</span>
      {buttons.map(({ key, label, ariaLabel }) => (
        <button
          key={key}
          type="button"
          className={`min-w-[44px] min-h-[44px] px-3 py-2 text-sm font-medium rounded-md
            border border-border
            focus:outline-none focus:ring-2 focus:ring-ring
            transition-colors duration-75
            ${activeKey === key
              ? 'bg-accent-500 text-white border-accent-500 scale-95'
              : 'bg-surface dark:bg-surface-2 hover:bg-muted active:bg-muted'
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
