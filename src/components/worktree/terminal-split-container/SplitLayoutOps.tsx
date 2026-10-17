/**
 * The action bar's layout ops — the maximized label, the layout icons, Equal
 * and Maximize — moved out of TerminalSplitContainer (Issue #3603).
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import {
  AlignHorizontalDistributeCenter,
  Square,
  Columns2,
  Columns3,
  LayoutGrid,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { SPLIT_LAYOUT_COUNTS } from '@/config/terminal-split-config';
import { Tooltip } from '@/components/common/Tooltip';

/**
 * Issue #3514: the glyph for each layout icon — what the terminal area will
 * look like, so 4 reads as the 2x2 grid it actually becomes.
 */
const SPLIT_LAYOUT_ICONS: Record<number, typeof Square> = {
  1: Square,
  2: Columns2,
  3: Columns3,
  4: LayoutGrid,
};

export interface SplitLayoutOpsProps {
  splitCount: number;
  isResizing: boolean;
  maxSelectableSplits: number;
  setSplitCount: (count: number) => void;
  canEqualize: boolean;
  handleEqualizeWidths: () => void;
  isMaximized: boolean;
  maximizedIndex: number | null;
  canMaximize: boolean;
  handleToggleMaximize: () => void;
}

export function SplitLayoutOps({
  splitCount,
  isResizing,
  maxSelectableSplits,
  setSplitCount,
  canEqualize,
  handleEqualizeWidths,
  isMaximized,
  maximizedIndex,
  canMaximize,
  handleToggleMaximize,
}: SplitLayoutOpsProps) {
  const t = useTranslations('worktree');
  const maximizeLabel = isMaximized
    ? t('terminal.restoreSplits')
    : t('terminal.maximizeFocusedSplit');
  // [Issue #2307] Tooltip content mirrors the former native `title` text
  // (label + shortcut hint) — only the delivery mechanism changed.
  const maximizeTooltip = `${maximizeLabel} — ${t('terminal.maximizeShortcutHint')}`;

  return (
      <>
        {/* Issue #2261: while a split is maximized the label says which split is
            filling the row — the one line that explains why the other panes
            vanished. Issue #3514: the "n / 4 splits" count it showed otherwise
            is gone; the pressed layout icon says the same thing. */}
        {isMaximized ? (
          <span
            data-testid="split-count-label"
            className="min-w-0 text-xs text-muted-foreground tabular-nums mr-1 truncate"
          >
            {t('terminal.maximizedStatus', { split: (maximizedIndex ?? 0) + 1 })}
          </span>
        ) : null}

        {/*
          Issue #3514: the layout icons (1 / 2 / 3 / 4) replace the "+ / -"
          stepper. One click goes straight to the layout; 4 is the 2x2 grid.
          Together with Equal / Maximize they form the LEFT group; an `ml-auto`
          hairline separator pushes the History / Files panel toggles to the
          RIGHT group ("layout ops | panel visibility", Issue #1079).
        */}
        <div
          role="group"
          aria-label={t('terminal.layoutGroupLabel')}
          data-testid="split-layout-picker"
          className="flex flex-shrink-0 items-center gap-0.5 rounded border border-border p-0.5"
        >
          {SPLIT_LAYOUT_COUNTS.map((count) => {
            const Icon = SPLIT_LAYOUT_ICONS[count] ?? Square;
            const active = splitCount === count;
            const disabled = isResizing || count > maxSelectableSplits;
            const label = t('terminal.layoutSplits', { count });
            return (
              <Tooltip key={count} content={label} placement="bottom">
                <button
                  type="button"
                  onClick={() => setSplitCount(count)}
                  disabled={disabled}
                  aria-disabled={disabled}
                  aria-pressed={active}
                  aria-label={label}
                  data-testid={`split-layout-${count}`}
                  className={`flex items-center justify-center h-6 w-6 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    active
                      ? 'bg-accent-500/15 text-accent-600 dark:text-accent-400'
                      : 'text-muted-foreground hover:text-surface-foreground hover:bg-muted'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </Tooltip>
            );
          })}
        </div>

        {/*
          Issue #861: equalize terminal split widths (each → 1/n) and reset the
          Message History width to default in one action. Disabled only when
          there is nothing to equalize (single split AND History hidden).
        */}
        <Tooltip content={t('terminal.equalizeWidthsHint')} placement="bottom">
          <button
            type="button"
            onClick={handleEqualizeWidths}
            disabled={!canEqualize}
            aria-disabled={!canEqualize}
            aria-label={t('terminal.equalizeWidthsHint')}
            data-testid="equalize-split-widths"
            className="flex flex-shrink-0 items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-surface-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
          >
            <AlignHorizontalDistributeCenter
              className="w-4 h-4 flex-shrink-0"
              aria-hidden="true"
            />
          </button>
        </Tooltip>

        {/* Issue #2261: maximize the focused split / restore the layout. */}
        <Tooltip content={maximizeTooltip} placement="bottom">
          <button
            type="button"
            onClick={handleToggleMaximize}
            disabled={!canMaximize}
            aria-disabled={!canMaximize}
            aria-pressed={isMaximized}
            aria-label={maximizeLabel}
            data-testid="toggle-maximize-split"
            className="flex flex-shrink-0 items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-surface-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
          >
            {isMaximized ? (
              <Minimize2 className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
            ) : (
              <Maximize2 className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
            )}
          </button>
        </Tooltip>
      </>
  );
}
