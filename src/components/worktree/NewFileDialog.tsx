/**
 * NewFileDialog Component (Issue #646)
 *
 * Dialog for creating new files with extension selection.
 * Supports file name input with a dropdown for extension selection.
 *
 * Extension resolution logic (resolveFileName):
 * (a) File name already has an EDITABLE_EXTENSIONS extension -> use as-is
 * (b) File name has no extension -> append selected extension from dropdown
 * (c) File name has a different extension -> file name's extension takes priority
 */

'use client';

import React, { useState, useCallback, useRef, useEffect, memo } from 'react';
import { Modal } from '@/components/ui/Modal';
import { EDITABLE_EXTENSIONS } from '@/config/editable-extensions';

export interface NewFileDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Parent directory path for the new file */
  parentPath: string;
  /** Callback when user confirms file creation */
  onConfirm: (finalName: string) => void;
  /** Callback when user cancels */
  onCancel: () => void;
}

/**
 * Resolve the final file name based on user input and selected extension.
 *
 * (a) If fileName already has an EDITABLE_EXTENSIONS extension -> return as-is
 * (b) If fileName has no extension (no dot, or ends with dot) -> append selectedExt
 * (c) If fileName has a non-editable extension -> return as-is (file name's extension takes priority)
 *
 * @param fileName - User-entered file name
 * @param selectedExt - Extension from dropdown (e.g., '.md')
 * @returns Resolved file name
 */
export function resolveFileName(fileName: string, selectedExt: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) return '';

  // Find the last dot position
  const lastDotIndex = trimmed.lastIndexOf('.');

  // No extension in file name (no dot, or dot is first character like ".gitignore")
  if (lastDotIndex <= 0) {
    return trimmed + selectedExt;
  }

  // Extract the extension from the file name
  const fileExt = trimmed.substring(lastDotIndex).toLowerCase();

  // (a) File name already has an editable extension -> use as-is
  if (EDITABLE_EXTENSIONS.includes(fileExt)) {
    return trimmed;
  }

  // (c) File name has a non-editable extension -> file name takes priority
  return trimmed;
}

/**
 * NewFileDialog - Dialog component for new file creation with extension selection.
 */
export const NewFileDialog = memo(function NewFileDialog({
  isOpen,
  parentPath,
  onConfirm,
  onCancel,
}: NewFileDialogProps) {
  const [fileName, setFileName] = useState('');
  const [selectedExt, setSelectedExt] = useState('.md');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when dialog opens
  useEffect(() => {
    if (isOpen) {
      setFileName('');
      setSelectedExt('.md');
      // Delay focus to ensure DOM is ready
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleConfirm = useCallback(() => {
    const resolved = resolveFileName(fileName, selectedExt);
    if (!resolved) return;
    onConfirm(resolved);
  }, [fileName, selectedExt, onConfirm]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
      }
    },
    [handleConfirm]
  );

  // Preview the resolved file name
  const resolvedName = resolveFileName(fileName, selectedExt);
  const displayPath = parentPath
    ? `${parentPath}/${resolvedName}`
    : resolvedName;

  return (
    <Modal isOpen={isOpen} onClose={onCancel} title="New File" size="sm">
      <div className="space-y-4">
        {/* File name input with extension dropdown */}
        <div>
          <label
            htmlFor="new-file-name"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            File name
          </label>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              id="new-file-name"
              data-testid="new-file-name-input"
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="document"
              className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
            />
            <select
              data-testid="new-file-ext-select"
              value={selectedExt}
              onChange={(e) => setSelectedExt(e.target.value)}
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
            >
              {EDITABLE_EXTENSIONS.map((ext) => (
                <option key={ext} value={ext}>
                  {ext}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* File path preview */}
        {resolvedName && (
          <div className="text-xs text-gray-500 dark:text-gray-400 font-mono bg-gray-50 dark:bg-gray-800 rounded px-2 py-1">
            {displayPath}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="new-file-confirm-button"
            onClick={handleConfirm}
            disabled={!resolvedName}
            className="px-4 py-2 text-sm font-medium text-white bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
});
