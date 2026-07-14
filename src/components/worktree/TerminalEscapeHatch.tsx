'use client';

/**
 * TerminalEscapeHatch — detection-independent Esc/q safety net (Issue #1017, C-lite).
 *
 * The read-only TerminalDisplay can only be driven through the selection window
 * (NavigationButtons / PromptPanel) or the special-keys API. When a CLI drops into
 * a TUI mode that status detection does not (yet) recognize, none of those surface
 * and the session becomes unreachable — exactly the failure this issue fixes for
 * the Codex pager (via CODEX_PAGER_FOOTER_PATTERN).
 *
 * This component is the permanent insurance against the NEXT undetected TUI mode.
 * Esc is safe across supported CLIs; q is exposed only for Codex, where it is a
 * known pager quit key. The caller renders it only for a confirmed unclassified
 * state, never at a normal input prompt or over a detected prompt/navigation UI.
 */

import { useCallback, useState } from 'react';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { NavigationKey } from '@/lib/tmux/tmux';
import { useSpecialKeys } from '@/hooks/useSpecialKeys';
import { KEY_PRESS_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';

export interface TerminalEscapeHatchProps {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Issue #869: agent instance to target (defaults to primary when omitted). */
  instanceId?: string;
  /** Trigger an immediate terminal refresh after the key is sent. */
  onKeysSent?: () => void;
}

const ESCAPE_KEY: { key: NavigationKey; label: string; ariaLabel: string } =
  { key: 'Escape', label: 'Esc', ariaLabel: 'Send Escape' };
const CODEX_QUIT_KEY: { key: NavigationKey; label: string; ariaLabel: string } =
  { key: 'q', label: 'q', ariaLabel: 'Send q (quit)' };

const CODEX_ESCAPE_KEYS: ReadonlyArray<{ key: NavigationKey; label: string; ariaLabel: string }> = [
  ESCAPE_KEY,
  CODEX_QUIT_KEY,
];

export function TerminalEscapeHatch({ worktreeId, cliToolId, instanceId, onKeysSent }: TerminalEscapeHatchProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const send = useSpecialKeys(worktreeId, cliToolId, instanceId, onKeysSent);
  const escapeKeys = cliToolId === 'codex' ? CODEX_ESCAPE_KEYS : [ESCAPE_KEY];

  const handleClick = useCallback(
    (key: NavigationKey) => {
      setActiveKey(key);
      setTimeout(() => setActiveKey(null), KEY_PRESS_FEEDBACK_RESET_MS);
      send([key]);
    },
    [send],
  );

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 py-1.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg"
      role="toolbar"
      aria-label="Terminal escape keys"
    >
      <span className="text-xs text-amber-700 dark:text-amber-400 mx-2" title="Send an escape key when the terminal is stuck in a TUI mode">
        Escape
      </span>
      {escapeKeys.map(({ key, label, ariaLabel }) => (
        <button
          key={key}
          type="button"
          className={`min-w-[44px] min-h-[44px] px-3 py-2 text-sm font-medium rounded-md
            border border-amber-300 dark:border-amber-700
            focus:outline-none focus:ring-2 focus:ring-amber-500
            transition-colors duration-75
            ${activeKey === key
              ? 'bg-amber-500 text-white border-amber-500 scale-95'
              : 'bg-white dark:bg-gray-700 hover:bg-amber-50 dark:hover:bg-gray-600 active:bg-amber-100 dark:active:bg-gray-500'
            }`}
          aria-label={ariaLabel}
          onClick={() => handleClick(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default TerminalEscapeHatch;
