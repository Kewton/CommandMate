/**
 * The action controls of a split's header (search, maximize / restore, "…" menu).
 * Drawn in the split's title bar, or portalled into the action bar (Issue #3592).
 */

'use client';

import React from 'react';
import { Maximize2, Minimize2, MoreHorizontal, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Tooltip } from '@/components/common/Tooltip';

export interface SplitActionControlsProps {
  splitIndex: number;
  splitLabel: string;
  searchLabel: string;
  inActionBar: boolean;
  isMaximized: boolean;
  maximizeDisabled: boolean;
  onSearchClick: () => void;
  onToggleMaximize?: () => void;
  onEndSession?: () => void;
}

export function SplitActionControls({
  splitIndex,
  splitLabel,
  searchLabel,
  inActionBar,
  isMaximized,
  maximizeDisabled,
  onSearchClick,
  onToggleMaximize,
  onEndSession,
}: SplitActionControlsProps): React.ReactElement {
  const t = useTranslations('worktree');
  return (
    <>
      <Tooltip content={searchLabel} placement="bottom" className="ml-auto">
        <button
          type="button"
          onClick={onSearchClick}
          aria-label={searchLabel}
          data-testid={`terminal-search-button-${splitIndex}`}
          className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-surface-foreground hover:bg-muted-foreground/10 rounded transition-colors"
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
      </Tooltip>

      {/* Issue #2261: maximize / restore, at the far right of the title bar
          where a window control is looked for. `flex-shrink-0` (and the
          `truncate`d alias to its left) is what keeps the row from wrapping in
          a narrow split — this is the row's fourth control. Rendered only when
          the parent wired `onToggleMaximize`. */}
      {/* Issue #3592: not in the action bar — the bar has its own maximize
          (`toggle-maximize-split`), and two maximize icons side by side for
          one split read as two different things. The "…" menu keeps the item. */}
      {onToggleMaximize && !inActionBar ? (
        <Tooltip
          content={`${
            isMaximized
              ? t('terminal.restoreSplits')
              : t('terminal.maximizeSplit', { split: splitLabel })
          } — ${t('terminal.maximizeShortcutHint')}`}
          placement="bottom"
          className="flex-shrink-0"
        >
          <button
            type="button"
            onClick={onToggleMaximize}
            disabled={maximizeDisabled && !isMaximized}
            aria-disabled={maximizeDisabled && !isMaximized}
            aria-pressed={isMaximized}
            aria-label={
              isMaximized
                ? t('terminal.restoreSplits')
                : t('terminal.maximizeSplit', { split: splitLabel })
            }
            data-testid={`toggle-maximize-${splitIndex}`}
            className="flex flex-shrink-0 items-center justify-center px-1.5 py-0.5 text-muted-foreground hover:text-surface-foreground hover:bg-muted-foreground/10 rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isMaximized ? (
              <Minimize2 size={14} aria-hidden="true" />
            ) : (
              <Maximize2 size={14} aria-hidden="true" />
            )}
          </button>
        </Tooltip>
      ) : null}

      {/* Issue #3514: the "…" menu — maximize, search and end session in one
          place, the same three actions the row's icons offer, so the header
          reads the same in every split (and the actions stay reachable when a
          narrow split clips the row). */}
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid={`split-more-menu-${splitIndex}`}
          aria-label={t('terminal.moreActions')}
          className="flex flex-shrink-0 items-center justify-center px-1 py-0.5 rounded text-muted-foreground hover:text-surface-foreground hover:bg-muted-foreground/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:ring-2 data-[state=open]:ring-ring transition-colors"
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[12rem]">
          {onToggleMaximize ? (
            <DropdownMenuItem
              data-testid={`split-more-maximize-${splitIndex}`}
              onSelect={onToggleMaximize}
              disabled={maximizeDisabled && !isMaximized}
            >
              {isMaximized ? (
                <Minimize2 size={14} aria-hidden="true" className="opacity-70" />
              ) : (
                <Maximize2 size={14} aria-hidden="true" className="opacity-70" />
              )}
              {isMaximized
                ? t('terminal.restoreSplits')
                : t('terminal.maximizeSplit', { split: splitLabel })}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            data-testid={`split-more-search-${splitIndex}`}
            onSelect={onSearchClick}
          >
            <Search size={14} aria-hidden="true" className="opacity-70" />
            {t('terminal.searchTerminal')}
          </DropdownMenuItem>
          {onEndSession ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid={`split-more-end-session-${splitIndex}`}
                onSelect={onEndSession}
                className="text-danger-foreground focus:text-danger-foreground"
              >
                <X size={14} aria-hidden="true" />
                {t('terminal.endSession')}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
