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
import { Button } from '@/components/ui';

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
  /** Hide view mode toggle buttons (for text-only mode, Issue #646) */
  hideViewModeToggle?: boolean;
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
  hideViewModeToggle,
}: MarkdownToolbarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted">
      {/* File path and dirty indicator */}
      <div className="flex items-center gap-2 min-w-0 flex-shrink">
        <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <span className="text-sm font-medium text-foreground truncate">{filePath}</span>
        {isDirty && (
          <span
            data-testid="dirty-indicator"
            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-warning-subtle text-warning-foreground flex-shrink-0"
          >
            Unsaved
          </span>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* View mode buttons - hide on mobile portrait with split mode, or in text-only mode */}
        {!showMobileTabs && !hideViewModeToggle && (
          <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
            {/* Issue #1061: セグメントコントロールのトグル（アクティブ thumb 表現）— 残置 */}
            <button
              data-testid="view-mode-split"
              aria-pressed={viewMode === 'split'}
              onClick={() => onViewModeChange('split')}
              className={`p-1.5 rounded ${
                viewMode === 'split'
                  ? 'bg-white dark:bg-input shadow-sm text-accent-600 dark:text-accent-400'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Split view"
            >
              <Columns className="h-4 w-4" />
            </button>
            {/* Issue #1061: セグメントコントロールのトグル（アクティブ thumb 表現）— 残置 */}
            <button
              data-testid="view-mode-editor"
              aria-pressed={viewMode === 'editor'}
              onClick={() => onViewModeChange('editor')}
              className={`p-1.5 rounded ${
                viewMode === 'editor'
                  ? 'bg-white dark:bg-input shadow-sm text-accent-600 dark:text-accent-400'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Editor only"
            >
              <FileText className="h-4 w-4" />
            </button>
            {/* Issue #1061: セグメントコントロールのトグル（アクティブ thumb 表現）— 残置 */}
            <button
              data-testid="view-mode-preview"
              aria-pressed={viewMode === 'preview'}
              onClick={() => onViewModeChange('preview')}
              className={`p-1.5 rounded ${
                viewMode === 'preview'
                  ? 'bg-white dark:bg-input shadow-sm text-accent-600 dark:text-accent-400'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Preview only"
            >
              <Eye className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Copy content button */}
        <Button
          variant="ghost"
          data-testid="copy-content-button"
          onClick={onCopy}
          className={`p-1.5 hover:bg-muted rounded ${
            copied ? 'text-success' : 'text-muted-foreground hover:text-foreground'
          }`}
          title="Copy content"
        >
          {copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>

        {/* Maximize button */}
        <Button
          variant="ghost"
          data-testid="maximize-button"
          onClick={onToggleFullscreen}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded"
          title={isMaximized ? 'Exit fullscreen (ESC)' : 'Enter fullscreen (Ctrl+Shift+F)'}
          aria-pressed={isMaximized}
        >
          {isMaximized ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </Button>

        {/* Auto-save toggle */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Auto</span>
          {/* Issue #1061: role=switch aria-checked トグルトラック（knob 描画）— 残置 */}
          <button
            data-testid="auto-save-toggle"
            role="switch"
            aria-checked={isAutoSaveEnabled}
            onClick={() => onAutoSaveToggle(!isAutoSaveEnabled)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              isAutoSaveEnabled ? 'bg-accent-600' : 'bg-input'
            }`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              isAutoSaveEnabled ? 'translate-x-4' : 'translate-x-0.5'
            }`} />
          </button>
        </div>

        {/* Save button OR auto-save indicator */}
        {isAutoSaveEnabled ? (
          <span data-testid="auto-save-indicator" className="text-sm text-muted-foreground">
            {isAutoSaving ? 'Saving...' : isDirty ? '' : 'Saved'}
          </span>
        ) : (
          <Button
            variant="ghost"
            data-testid="save-button"
            onClick={onSave}
            disabled={!isDirty || isSaving}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              isDirty && !isSaving
                ? 'bg-accent-600 text-white hover:bg-accent-700'
                : 'bg-muted text-muted-foreground cursor-not-allowed'
            }`}
          >
            <Save className="h-4 w-4" />
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        )}

        {/* Close button */}
        {onClose && (
          <Button
            variant="ghost"
            data-testid="close-button"
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded"
            title="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
});

export default MarkdownToolbar;
