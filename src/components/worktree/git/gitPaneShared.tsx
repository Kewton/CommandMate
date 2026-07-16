/**
 * GitPane shared primitives (Issue #922)
 *
 * Small presentational atoms and constants shared across the extracted GitPane
 * panels (status / changes / history / branches / stash / danger zone). Moved
 * verbatim out of the former GitPane god-component so each panel file can import
 * them without re-declaring. Behavior is unchanged.
 */

'use client';

import { memo } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import type { ChangedFile } from '@/types/git';

// ============================================================================
// Status -> color mapping (Issue #780)
// Exhaustive Record over ChangedFile['status']; untracked/unmerged get distinct
// colors so they never silently fall back to the modified yellow.
// ============================================================================

export const STATUS_TEXT_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-success-foreground',
  modified: 'text-warning-foreground',
  deleted: 'text-danger-foreground',
  renamed: 'text-info',
  untracked: 'text-teal-600 dark:text-teal-400',
  unmerged: 'text-warning-foreground',
};

/**
 * Working-tree diff mode for the Changes section (Issue #780). Identifies which
 * git working-tree diff the per-file Diff button should request.
 */
export type ChangesDiffMode = 'staged' | 'unstaged' | 'untracked';

/** Number of diff lines shown in the Changes inline preview (Issue #816, C). */
export const CHANGES_PREVIEW_LINES = 20;

export const RefreshIcon = memo(function RefreshIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
});

/**
 * "Ask AI" button (Issue #817). Drafts a context-rich prompt into the active CLI
 * tab's MessageInput composer (no auto-send) so the user can review/edit before
 * sending. Presentational only: the call site owns the `onClick` (it builds the
 * prompt from a `git-ai-prompt-templates` builder and closes any open dialog),
 * and gates rendering on whether an `onInsertToMessage` handler is wired.
 */
export const AskAiButton = memo(function AskAiButton({
  onClick,
  disabled = false,
  testId,
  className = '',
}: {
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  className?: string;
}) {
  const t = useTranslations('worktree');
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-info-border text-info-foreground hover:bg-info-subtle disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      data-testid={testId}
      title={t('git.askAiTooltip')}
    >
      <Sparkles size={14} aria-hidden="true" />
      {t('git.askAi')}
    </button>
  );
});

/**
 * Render a single diff line with appropriate color
 */
export const DiffLine = memo(function DiffLine({ line }: { line: string }) {
  let className = 'whitespace-pre font-mono text-xs';

  if (line.startsWith('+') && !line.startsWith('+++')) {
    className += ' text-success-foreground bg-success-subtle';
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    className += ' text-danger-foreground bg-danger-subtle';
  } else if (line.startsWith('@@')) {
    className += ' text-info';
  } else {
    className += ' text-foreground';
  }

  return <div className={className}>{line}</div>;
});

/**
 * Inline error display for sub-section errors
 */
export const InlineError = memo(function InlineError({ message }: { message: string }) {
  return (
    <div className="px-3 py-2 text-xs text-danger-foreground" role="alert">
      {message}
    </div>
  );
});
