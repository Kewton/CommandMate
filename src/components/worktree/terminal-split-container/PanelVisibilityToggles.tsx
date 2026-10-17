/**
 * The action bar's History / Files visibility toggles, moved out of
 * TerminalSplitContainer (Issue #3603).
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { History, PanelRight } from 'lucide-react';
import { FILE_PANEL_PANE_ID } from '@/hooks/useFilePanelState';
import { Tooltip } from '@/components/common/Tooltip';

export interface PanelVisibilityTogglesProps {
  historyVisible: boolean;
  toggleHistory: () => void;
  historySlotIds: string;
  filesVisible: boolean;
  filesUnavailable: boolean;
  toggleFilePanel: () => void;
  openFileCount: number;
  compactToggles: boolean;
}

export function PanelVisibilityToggles({
  historyVisible,
  toggleHistory,
  historySlotIds,
  filesVisible,
  filesUnavailable,
  toggleFilePanel,
  openFileCount,
  compactToggles,
}: PanelVisibilityTogglesProps) {
  const t = useTranslations('worktree');
  // [Issue #2307] Tooltip content mirrors the former native `title` text.
  const historyTooltip = `${
    historyVisible ? t('terminal.hideHistory') : t('terminal.showHistory')
  } — ${t('terminal.historyAllSplitsHint')}`;
  const filesTooltip = filesUnavailable
    ? t('terminal.filesEmptyHint')
    : filesVisible
      ? t('terminal.hideFiles')
      : t('terminal.showFiles');

  return (
      <>
        {/*
          Issue #841 (Phase 2): History / Files visibility toggles. Always
          shown (split-count independent). Active = cyan accent, inactive =
          gray. `aria-pressed` reflects current visibility. The existing
          vertical collapse strips remain and share this state (SSOT).
        */}
        <Tooltip content={historyTooltip} placement="bottom" className="flex-shrink-0">
          <button
            type="button"
            onClick={toggleHistory}
            aria-pressed={historyVisible}
            aria-expanded={historyVisible}
            aria-controls={historySlotIds}
            aria-label={
              historyVisible
                ? t('terminal.hideHistory')
                : t('terminal.showHistory')
            }
            data-testid="toggle-history-pane"
            className={`flex flex-shrink-0 items-center gap-1 whitespace-nowrap text-xs px-2 py-0.5 rounded border transition-colors ${
              historyVisible
                ? 'border-accent-300 dark:border-accent-700 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300'
                : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            <History className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            {/* Issue #3590: dropped first when the bar is too narrow; the
                aria-label and the tooltip still name the toggle. */}
            {!compactToggles && <span>{t('terminal.historyLabel')}</span>}
          </button>
        </Tooltip>
        <Tooltip content={filesTooltip} placement="bottom" className="flex-shrink-0">
          <button
            type="button"
            onClick={toggleFilePanel}
            disabled={filesUnavailable}
            aria-disabled={filesUnavailable}
            aria-pressed={filesVisible}
            aria-expanded={filesVisible}
            aria-controls={FILE_PANEL_PANE_ID}
            aria-label={
              filesVisible ? t('terminal.hideFiles') : t('terminal.showFiles')
            }
            data-testid="toggle-file-panel"
            className={`flex flex-shrink-0 items-center gap-1 whitespace-nowrap text-xs px-2 py-0.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              filesVisible
                ? 'border-accent-300 dark:border-accent-700 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300'
                : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            {/* Issue #2616: `Files` is the Activity Bar file tree's icon; this
                toggle shows a side panel, so it must not share it. */}
            <PanelRight className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            {!compactToggles && <span>{t('terminal.filesLabel')}</span>}
            {openFileCount > 0 && (
              <span
                data-testid="open-files-count"
                className="ml-0.5 min-w-[1.25rem] px-1 rounded-full bg-muted text-[10px] leading-4 text-muted-foreground tabular-nums text-center"
              >
                {openFileCount}
              </span>
            )}
          </button>
        </Tooltip>
      </>
  );
}
