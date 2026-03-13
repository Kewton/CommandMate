/**
 * MarkdownToolbar Component
 * Issue #479: Extracted from MarkdownEditor.tsx for single responsibility
 *
 * Renders the toolbar/header for the MarkdownEditor, including:
 * - File path and dirty indicator
 * - View mode buttons (split/editor/preview)
 * - Copy content button
 * - Maximize/fullscreen button
 * - Auto-save toggle
 * - Save button / auto-save indicator
 * - Close button
 */

'use client';

import React, { memo } from 'react';
import {
  Save,
  X,
  Columns,
  FileText,
  Eye,
  Maximize2,
  Minimize2,
  Copy,
  Check,
} from 'lucide-react';
import type { ViewMode } from '@/types/markdown-editor';

// ============================================================================
// Types
// ============================================================================

export interface MarkdownToolbarProps {
  /** Current file path */
  filePath: string;
  /** Whether content has unsaved changes */
  isDirty: boolean;
  /** Current view mode */
  viewMode: ViewMode;
  /** Callback to change view mode */
  onViewModeChange: (mode: ViewMode) => void;
  /** Whether to show mobile tabs instead of view mode buttons */
  showMobileTabs: boolean;
  /** Whether content was recently copied */
  copied: boolean;
  /** Callback to copy content */
  onCopy: () => void;
  /** Whether editor is maximized */
  isMaximized: boolean;
  /** Callback to toggle fullscreen */
  onToggleFullscreen: () => void;
  /** Whether auto-save is enabled */
  isAutoSaveEnabled: boolean;
  /** Callback to toggle auto-save */
  onAutoSaveToggle: (enabled: boolean) => void;
  /** Whether auto-save is currently saving */
  isAutoSaving: boolean;
  /** Whether manual save is in progress */
  isSaving: boolean;
  /** Callback for manual save */
  onSave: () => void;
  /** Callback for close */
  onClose?: () => void;
}

// ============================================================================
// Component
// ============================================================================

export const MarkdownToolbar = memo(function MarkdownToolbar({
  filePath,
  isDirty,
  viewMode,
  onViewModeChange,
  showMobileTabs,
  copied,
  onCopy,
  isMaximized,
  onToggleFullscreen,
  isAutoSaveEnabled,
  onAutoSaveToggle,
  isAutoSaving,
  isSaving,
  onSave,
  onClose,
}: MarkdownToolbarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
      {/* File path and dirty indicator */}
      <div className="flex items-center gap-2 min-w-0 flex-shrink">
        <FileText className="h-4 w-4 text-gray-500 dark:text-gray-400 flex-shrink-0" />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">{filePath}</span>
        {isDirty && (
          <span
            data-testid="dirty-indicator"
            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-300 flex-shrink-0"
          >
            Unsaved
          </span>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* View mode buttons - hide on mobile portrait with split mode */}
        {!showMobileTabs && (
          <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
            <button
              data-testid="view-mode-split"
              aria-pressed={viewMode === 'split'}
              onClick={() => onViewModeChange('split')}
              className={`p-1.5 rounded ${
                viewMode === 'split'
                  ? 'bg-white dark:bg-gray-600 shadow-sm text-cyan-600 dark:text-cyan-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
              title="Split view"
            >
              <Columns className="h-4 w-4" />
            </button>
            <button
              data-testid="view-mode-editor"
              aria-pressed={viewMode === 'editor'}
              onClick={() => onViewModeChange('editor')}
              className={`p-1.5 rounded ${
                viewMode === 'editor'
                  ? 'bg-white dark:bg-gray-600 shadow-sm text-cyan-600 dark:text-cyan-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
              title="Editor only"
            >
              <FileText className="h-4 w-4" />
            </button>
            <button
              data-testid="view-mode-preview"
              aria-pressed={viewMode === 'preview'}
              onClick={() => onViewModeChange('preview')}
              className={`p-1.5 rounded ${
                viewMode === 'preview'
                  ? 'bg-white dark:bg-gray-600 shadow-sm text-cyan-600 dark:text-cyan-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
              title="Preview only"
            >
              <Eye className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Copy content button */}
        <button
          data-testid="copy-content-button"
          onClick={onCopy}
          className={`p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded ${
            copied ? 'text-green-500' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
          }`}
          title="Copy content"
        >
          {copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </button>

        {/* Maximize button */}
        <button
          data-testid="maximize-button"
          onClick={onToggleFullscreen}
          className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
          title={isMaximized ? 'Exit fullscreen (ESC)' : 'Enter fullscreen (Ctrl+Shift+F)'}
          aria-pressed={isMaximized}
        >
          {isMaximized ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </button>

        {/* Auto-save toggle */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 dark:text-gray-400">Auto</span>
          <button
            data-testid="auto-save-toggle"
            role="switch"
            aria-checked={isAutoSaveEnabled}
            onClick={() => onAutoSaveToggle(!isAutoSaveEnabled)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              isAutoSaveEnabled ? 'bg-cyan-600' : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              isAutoSaveEnabled ? 'translate-x-4' : 'translate-x-0.5'
            }`} />
          </button>
        </div>

        {/* Save button OR auto-save indicator */}
        {isAutoSaveEnabled ? (
          <span data-testid="auto-save-indicator" className="text-sm text-gray-500 dark:text-gray-400">
            {isAutoSaving ? 'Saving...' : isDirty ? '' : 'Saved'}
          </span>
        ) : (
          <button
            data-testid="save-button"
            onClick={onSave}
            disabled={!isDirty || isSaving}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              isDirty && !isSaving
                ? 'bg-cyan-600 text-white hover:bg-cyan-700'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
            }`}
          >
            <Save className="h-4 w-4" />
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        )}

        {/* Close button */}
        {onClose && (
          <button
            data-testid="close-button"
            onClick={onClose}
            className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
});

export default MarkdownToolbar;
