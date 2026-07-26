/**
 * MobileFileActionsSheet (Issue #1519)
 *
 * Bottom sheet holding the file actions that used to be split across the
 * FileViewer toolbar and the separate Markdown editor modal: search, copy
 * content, copy path, download. Follows the `MobileTerminalActionsSheet`
 * (Issue #1080) pattern so mobile keeps one sheet idiom.
 *
 * Maximize is deliberately NOT here — it stays on the toolbar so it is one tap
 * away at any time.
 */

'use client';

import React, { useCallback, useEffect, useId } from 'react';
import { useTranslations } from 'next-intl';
import { Search, Copy, Check, ClipboardCopy, Download } from 'lucide-react';
import { useFocusTrap } from '@/hooks/useFocusTrap';

/** Shared row styling: 44px tap target (Issue #1127) with a label. */
const ROW_CLASS =
  'flex w-full items-center gap-3 rounded-lg px-3 min-h-[44px] py-3 text-sm text-foreground hover:bg-muted transition-colors touch-manipulation';

export interface MobileFileActionsSheetProps {
  /** Whether the sheet is visible. */
  open: boolean;
  /** Dismiss the sheet (overlay tap / after an action). */
  onClose: () => void;
  /** Open the in-file search bar. */
  onSearch: () => void;
  /** Copy the file content to the clipboard. */
  onCopyContent: () => void;
  /** Copy the file path to the clipboard. */
  onCopyPath: () => void;
  /** Download href for the raw file (`?download=1`). */
  downloadUrl: string;
  /** Suggested filename for the download attribute. */
  downloadName: string;
  /** Whether the content copy just succeeded (Check icon feedback). */
  contentCopied: boolean;
  /** Whether the path copy just succeeded (Check icon feedback). */
  pathCopied: boolean;
}

/**
 * Bottom action sheet for the mobile file screen.
 */
export function MobileFileActionsSheet({
  open,
  onClose,
  onSearch,
  onCopyContent,
  onCopyPath,
  downloadUrl,
  downloadName,
  contentCopied,
  pathCopied,
}: MobileFileActionsSheetProps) {
  const t = useTranslations('worktree');
  const labelId = useId();

  const sheetRef = useFocusTrap<HTMLDivElement>({ active: open });

  const handleSearch = useCallback(() => {
    onSearch();
    onClose();
  }, [onSearch, onClose]);

  const handleCopyContent = useCallback(() => {
    onCopyContent();
    onClose();
  }, [onCopyContent, onClose]);

  const handleCopyPath = useCallback(() => {
    onCopyPath();
    onClose();
  }, [onCopyPath, onClose]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        data-testid="file-actions-overlay"
        onClick={onClose}
        className="fixed inset-0 bg-black/50 z-50"
        aria-hidden="true"
      />

      <div
        ref={sheetRef}
        data-testid="mobile-file-actions-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        className="fixed bottom-0 inset-x-0 z-50 rounded-t-2xl border-t border-border bg-surface pb-safe"
      >
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 rounded-full bg-muted-foreground/30" aria-hidden="true" />
        </div>

        <h2 id={labelId} className="px-4 pb-2 text-sm font-medium text-muted-foreground">
          {t('fileViewer.moreActions')}
        </h2>

        <div className="px-2 pb-4">
          <button
            type="button"
            data-testid="file-actions-sheet-search"
            onClick={handleSearch}
            className={ROW_CLASS}
          >
            <Search size={18} aria-hidden="true" className="text-muted-foreground" />
            {t('actions.searchInFile')}
          </button>
          <button
            type="button"
            data-testid="file-actions-sheet-copy-content"
            onClick={handleCopyContent}
            className={ROW_CLASS}
          >
            {contentCopied ? (
              <Check size={18} aria-hidden="true" className="text-success" />
            ) : (
              <Copy size={18} aria-hidden="true" className="text-muted-foreground" />
            )}
            {t('actions.copyFileContent')}
          </button>
          <button
            type="button"
            data-testid="file-actions-sheet-copy-path"
            onClick={handleCopyPath}
            className={ROW_CLASS}
          >
            {pathCopied ? (
              <Check size={18} aria-hidden="true" className="text-success" />
            ) : (
              <ClipboardCopy size={18} aria-hidden="true" className="text-muted-foreground" />
            )}
            {t('actions.copyFilePath')}
          </button>
          <a
            data-testid="download-file-button"
            href={downloadUrl}
            download={downloadName}
            onClick={onClose}
            className={ROW_CLASS}
            aria-label={t('actions.downloadFile')}
          >
            <Download size={18} aria-hidden="true" className="text-muted-foreground" />
            {t('actions.downloadFile')}
          </a>
        </div>
      </div>
    </>
  );
}

export default MobileFileActionsSheet;
