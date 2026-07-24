'use client';

/**
 * TerminalEscapeHatch — detection-independent navigation safety net (Issue #1017, #1494).
 *
 * The read-only TerminalDisplay can only be driven through the selection window
 * (NavigationButtons / PromptPanel) or the special-keys API. When a CLI drops into
 * a TUI overlay that status detection does NOT classify as a selection list
 * (isUnclassifiedActive) — e.g. Claude's `/help` tab overlay — NavigationButtons is
 * not rendered, so before #1494 only Esc was reachable and the ←/→ tab-switching
 * those overlays rely on was impossible (Issue #1494: "ESC works, arrows don't").
 *
 * This hatch is therefore a full navigation pad (←/↑/↓/→/Enter/Esc), not just Esc:
 * it lets the user drive ANY unclassified overlay without depending on a footer
 * pattern match (the detection-independent design intent of #1017). Esc is safe
 * across supported CLIs; q is exposed only for Codex, where it is a known pager
 * quit key. The caller renders it only for a confirmed unclassified state, never at
 * a normal input prompt or over a detected prompt / selection-list UI, so Enter/q
 * can never reach the composer or a live input line.
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

interface HatchKeyDef {
  key: NavigationKey;
  /** Key-cap glyph / name shown inside the button. */
  label: string;
  /** Accessible name — the physical key's own name, used verbatim. */
  ariaLabel: string;
}

/* eslint-disable no-restricted-syntax -- i18n(#1271): these literals are physical
   key notation — key-cap glyphs (◀ ▲ ▼ ▶ ↵) and the key's own name in the aria
   label ("Send Left" / "Send Escape" / "Send q (quit)"). They are identical in
   every locale and are not translatable prose. */

/**
 * Issue #1494: detection-independent navigation keys. Sent to any unclassified TUI
 * overlay (e.g. Claude `/help`) whose footer does not match the selection-list
 * pattern that would otherwise render NavigationButtons.
 */
const NAVIGATION_KEYS: ReadonlyArray<HatchKeyDef> = [
  { key: 'Left', label: '◀', ariaLabel: 'Send Left' },
  { key: 'Up', label: '▲', ariaLabel: 'Send Up' },
  { key: 'Down', label: '▼', ariaLabel: 'Send Down' },
  { key: 'Right', label: '▶', ariaLabel: 'Send Right' },
  { key: 'Enter', label: '↵', ariaLabel: 'Send Enter' },
];

const ESCAPE_KEY: HatchKeyDef = { key: 'Escape', label: 'Esc', ariaLabel: 'Send Escape' };
const CODEX_QUIT_KEY: HatchKeyDef = { key: 'q', label: 'q', ariaLabel: 'Send q (quit)' };

/* eslint-enable no-restricted-syntax */

export function TerminalEscapeHatch({ worktreeId, cliToolId, instanceId, onKeysSent }: TerminalEscapeHatchProps) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const send = useSpecialKeys(worktreeId, cliToolId, instanceId, onKeysSent);
  // Base pad (arrows + Enter + Esc) for every CLI; Codex additionally gets the
  // pager 'q'. 'q' stays Codex-only so it can never insert a literal 'q' at
  // another CLI's input prompt.
  const hatchKeys: ReadonlyArray<HatchKeyDef> =
    cliToolId === 'codex'
      ? [...NAVIGATION_KEYS, ESCAPE_KEY, CODEX_QUIT_KEY]
      : [...NAVIGATION_KEYS, ESCAPE_KEY];

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
      aria-label="Terminal navigation keys"
    >
      <span
        className="text-xs text-amber-700 dark:text-amber-400 mx-2"
        title="Send navigation / escape keys when the terminal is stuck in a TUI overlay"
      >
        Navigate
      </span>
      {hatchKeys.map(({ key, label, ariaLabel }) => (
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
