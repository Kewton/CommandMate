/**
 * FileMetadataToggle Component (Issue #969)
 *
 * A small gear button in the file-tree toolbar that opens a popover with three
 * checkboxes controlling which metadata columns (size / created / modified) are
 * shown inline in each file row. State is owned by `useFileMetadataDisplay`
 * (localStorage-persisted) and passed in by the parent so the same settings can
 * also drive `TreeNode` rendering without prop drilling through it.
 */

'use client';

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type {
  FileMetadataDisplaySettings,
} from '@/hooks/useFileMetadataDisplay';

export interface FileMetadataToggleProps {
  /** Current visibility settings. */
  settings: FileMetadataDisplaySettings;
  /** Toggle a single key. */
  onToggle: (key: keyof FileMetadataDisplaySettings) => void;
}

interface Row {
  key: keyof FileMetadataDisplaySettings;
  labelKey: string;
}

const ROWS: Row[] = [
  { key: 'showSize', labelKey: 'fileTree.metadata.showSize' },
  { key: 'showCreated', labelKey: 'fileTree.metadata.showCreated' },
  { key: 'showModified', labelKey: 'fileTree.metadata.showModified' },
];

export const FileMetadataToggle = memo(function FileMetadataToggle({
  settings,
  onToggle,
}: FileMetadataToggleProps) {
  const t = useTranslations('worktree');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close the popover when clicking outside or pressing Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: MouseEvent): void => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleToggle = useCallback(
    (key: keyof FileMetadataDisplaySettings) => {
      onToggle(key);
    },
    [onToggle]
  );

  return (
    <div className="relative" ref={containerRef} data-testid="file-metadata-toggle">
      <button
        type="button"
        data-testid="file-metadata-toggle-button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('fileTree.metadata.settingsLabel')}
        title={t('fileTree.metadata.settingsLabel')}
        className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
      >
        <Settings2 className="w-4 h-4" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          data-testid="file-metadata-toggle-menu"
          className="absolute right-0 top-full z-20 mt-1 min-w-[12rem] rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg p-1"
        >
          <div className="px-2 py-1 text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wide">
            {t('fileTree.metadata.settingsTitle')}
          </div>
          {ROWS.map((row) => (
            <label
              key={row.key}
              className="flex items-center gap-2 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/60 rounded cursor-pointer"
            >
              <input
                type="checkbox"
                data-testid={`file-metadata-toggle-${row.key}`}
                checked={settings[row.key]}
                onChange={() => handleToggle(row.key)}
                className="h-3.5 w-3.5 accent-cyan-500"
              />
              <span>{t(row.labelKey)}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
});

export default FileMetadataToggle;
