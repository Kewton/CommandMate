/**
 * TerminalSplitPane Component (Issue #728)
 *
 * Single split within `TerminalSplitContainer`. Renders:
 *  - Header: CLI selector (with "other-split-uses" disabled options) +
 *    terminal-search button (Issue #47).
 *  - Body: caller-supplied terminal content (TerminalDisplay).
 *  - Footer: caller-supplied navigation / prompt / message input.
 *
 * `role="region"` + `aria-label="Terminal split N"` for a11y. The pane is
 * intentionally presentational: state ownership lives in the parent.
 */

'use client';

import React, { memo, useCallback } from 'react';
import {
  CLI_TOOL_IDS,
  type CLIToolType,
  getCliToolDisplayName,
} from '@/lib/cli-tools/types';

export interface TerminalSplitPaneProps {
  worktreeId: string;
  splitIndex: number;
  cliToolId: CLIToolType;
  availableCliTools: CLIToolType[];
  /** Called when the CLI selector picks a new tool. */
  onCliToolChange: (cliId: CLIToolType) => void;
  /** Called when the textarea (or any input) inside this pane gains focus. */
  onFocus: () => void;
  /** Whether tmux attach is in progress for this split. */
  attaching?: boolean;
  /** Rendered above the CLI selector — usually empty (`null`). */
  headerExtras?: React.ReactNode;
  /** Terminal output area (TerminalDisplay). */
  terminal: React.ReactNode;
  /** Navigation buttons + PromptPanel + MessageInput. */
  footer: React.ReactNode;
  /** Optional inline width (flex-grow ratio). When omitted, parent controls layout. */
  style?: React.CSSProperties;
}

export const TerminalSplitPane = memo(function TerminalSplitPane({
  splitIndex,
  cliToolId,
  availableCliTools,
  onCliToolChange,
  onFocus,
  attaching = false,
  headerExtras,
  terminal,
  footer,
  style,
}: TerminalSplitPaneProps) {
  const handleSelectorChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value as CLIToolType;
      onCliToolChange(next);
    },
    [onCliToolChange],
  );

  const handleSearchClick = useCallback(() => {
    // Issue #47: dispatch terminal-wide search-open event; TerminalDisplay listens.
    window.dispatchEvent(new CustomEvent('terminal-search-open'));
  }, []);

  // Bubble-up focus from anywhere inside (textarea, terminal click).
  // We use onFocusCapture so we don't depend on individual children calling onFocus.
  const handleFocusCapture = useCallback(() => {
    onFocus();
  }, [onFocus]);

  const splitLabel = `Terminal split ${splitIndex + 1}`;

  return (
    <div
      role="region"
      aria-label={splitLabel}
      data-testid={`terminal-split-pane-${splitIndex}`}
      data-split-index={splitIndex}
      style={style}
      className="flex flex-col min-w-0 h-full bg-white dark:bg-gray-900"
      onFocusCapture={handleFocusCapture}
      onMouseDown={onFocus}
    >
      {/* Header: CLI selector + search button */}
      <div className="px-2 py-1 flex items-center gap-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <label className="sr-only" htmlFor={`cli-selector-${splitIndex}`}>
          {`Select CLI for ${splitLabel}`}
        </label>
        <select
          id={`cli-selector-${splitIndex}`}
          value={cliToolId}
          onChange={handleSelectorChange}
          data-testid={`cli-selector-${splitIndex}`}
          aria-label={`Select CLI for ${splitLabel}`}
          className="text-xs bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5"
        >
          {CLI_TOOL_IDS.map(id => {
            const allowed = availableCliTools.includes(id) || id === cliToolId;
            return (
              <option key={id} value={id} disabled={!allowed}>
                {getCliToolDisplayName(id)}
                {!allowed ? ' (in use)' : ''}
              </option>
            );
          })}
        </select>

        <button
          type="button"
          onClick={handleSearchClick}
          aria-label={`Search terminal output for ${splitLabel}`}
          data-testid={`terminal-search-button-${splitIndex}`}
          className="ml-auto flex items-center gap-1 px-1.5 py-0.5 text-xs text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-3 w-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </button>
        {headerExtras}
      </div>

      {/* Body: terminal display (or attach skeleton) */}
      <div className="flex-1 min-h-0 relative">
        {attaching ? (
          <div
            data-testid={`terminal-attach-skeleton-${splitIndex}`}
            className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 dark:text-gray-400 bg-gray-50/80 dark:bg-gray-800/80"
            role="status"
            aria-live="polite"
          >
            Attaching {getCliToolDisplayName(cliToolId)} session...
          </div>
        ) : null}
        {terminal}
      </div>

      {/* Footer: navigation + prompt + message input */}
      <div className="flex-shrink-0 border-t border-gray-200 dark:border-gray-700 p-2 bg-gray-50 dark:bg-gray-800">
        {footer}
      </div>
    </div>
  );
});

export default TerminalSplitPane;
