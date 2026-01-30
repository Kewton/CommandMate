/**
 * MarkdownEditor Component
 *
 * A markdown editor with live preview, supporting:
 * - Split/Editor-only/Preview-only view modes
 * - Debounced preview updates
 * - Manual save (Ctrl/Cmd+S, save button)
 * - Unsaved changes warning (beforeunload)
 * - Large file warning (>500KB)
 * - XSS protection via rehype-sanitize [SEC-MF-001]
 * - LocalStorage persistence for view mode
 *
 * @module components/worktree/MarkdownEditor
 */

'use client';

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import { Save, X, Columns, FileText, Eye, AlertTriangle } from 'lucide-react';
import { debounce } from '@/lib/utils';
import { ToastContainer, useToast } from '@/components/common/Toast';
import type { EditorProps, ViewMode } from '@/types/markdown-editor';
import {
  VIEW_MODE_STRATEGIES,
  LOCAL_STORAGE_KEY,
  PREVIEW_DEBOUNCE_MS,
  FILE_SIZE_LIMITS,
} from '@/types/markdown-editor';

/**
 * Validate and parse view mode from storage
 */
function isValidViewMode(value: unknown): value is ViewMode {
  return value === 'split' || value === 'editor' || value === 'preview';
}

/**
 * Get initial view mode from localStorage or props
 */
function getInitialViewMode(initialViewMode?: ViewMode): ViewMode {
  if (initialViewMode && isValidViewMode(initialViewMode)) {
    return initialViewMode;
  }

  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (stored && isValidViewMode(stored)) {
      return stored;
    }
  }

  return 'split';
}

/**
 * MarkdownEditor Component
 *
 * @example
 * ```tsx
 * <MarkdownEditor
 *   worktreeId="123"
 *   filePath="docs/readme.md"
 *   onClose={() => setShowEditor(false)}
 *   onSave={(path) => console.log('Saved:', path)}
 * />
 * ```
 */
export function MarkdownEditor({
  worktreeId,
  filePath,
  onClose,
  onSave,
  initialViewMode,
}: EditorProps) {
  // State
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [previewContent, setPreviewContent] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    getInitialViewMode(initialViewMode)
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLargeFileWarning, setShowLargeFileWarning] = useState(false);

  // Toast hook
  const { toasts, showToast, removeToast } = useToast();

  // Refs
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const beforeUnloadRef = useRef<((e: BeforeUnloadEvent) => void) | null>(null);

  // Computed state
  const isDirty = content !== originalContent;
  const strategy = VIEW_MODE_STRATEGIES[viewMode];

  /**
   * Debounced preview update
   */
  const updatePreview = useMemo(
    () =>
      debounce((value: string) => {
        setPreviewContent(value);
      }, PREVIEW_DEBOUNCE_MS),
    []
  );

  /**
   * Load file content
   */
  const loadContent = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/files/${filePath}`
      );
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error?.message || 'Failed to load file');
      }

      const fileContent = data.content || '';
      setContent(fileContent);
      setOriginalContent(fileContent);
      setPreviewContent(fileContent);

      // Check file size for warning
      const size = new Blob([fileContent]).size;
      if (size > FILE_SIZE_LIMITS.WARNING_THRESHOLD) {
        setShowLargeFileWarning(true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load file';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [worktreeId, filePath]);

  /**
   * Save file content
   */
  const saveContent = useCallback(async () => {
    if (!isDirty || isSaving) return;

    setIsSaving(true);

    try {
      const response = await fetch(
        `/api/worktrees/${worktreeId}/files/${filePath}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        }
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error?.message || 'Failed to save file');
      }

      // Update original content to mark as not dirty
      setOriginalContent(content);
      showToast('File saved successfully', 'success');

      if (onSave) {
        onSave(filePath);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save file';
      showToast(message, 'error');
    } finally {
      setIsSaving(false);
    }
  }, [worktreeId, filePath, content, isDirty, isSaving, onSave, showToast]);

  /**
   * Handle content change
   */
  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value;
      setContent(newContent);
      updatePreview(newContent);
    },
    [updatePreview]
  );

  /**
   * Handle view mode change
   */
  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    if (typeof window !== 'undefined') {
      localStorage.setItem(LOCAL_STORAGE_KEY, mode);
    }
  }, []);

  /**
   * Handle close with unsaved changes check
   */
  const handleClose = useCallback(() => {
    if (isDirty) {
      const confirmed = window.confirm(
        'You have unsaved changes. Are you sure you want to close?'
      );
      if (!confirmed) return;
    }
    if (onClose) {
      onClose();
    }
  }, [isDirty, onClose]);

  /**
   * Handle keyboard shortcuts
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ctrl+S or Cmd+S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveContent();
      }
    },
    [saveContent]
  );

  // Load content on mount
  useEffect(() => {
    loadContent();
  }, [loadContent]);

  // Manage beforeunload handler
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    if (isDirty) {
      beforeUnloadRef.current = handleBeforeUnload;
      window.addEventListener('beforeunload', handleBeforeUnload);
    } else {
      if (beforeUnloadRef.current) {
        window.removeEventListener('beforeunload', beforeUnloadRef.current);
        beforeUnloadRef.current = null;
      }
    }

    return () => {
      if (beforeUnloadRef.current) {
        window.removeEventListener('beforeunload', beforeUnloadRef.current);
      }
    };
  }, [isDirty]);

  // Render loading state
  if (isLoading) {
    return (
      <div
        data-testid="markdown-editor"
        className="flex items-center justify-center h-full bg-white"
      >
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 border-t-blue-600" />
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // Render error state
  if (error) {
    return (
      <div
        data-testid="markdown-editor-error"
        className="flex items-center justify-center h-full bg-white"
      >
        <div className="text-center">
          <AlertTriangle className="h-12 w-12 text-red-500 mx-auto mb-4" />
          <p className="text-red-600">{error}</p>
          {onClose && (
            <button
              onClick={onClose}
              className="mt-4 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              Close
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="markdown-editor"
      className="flex flex-col h-full bg-white"
      onKeyDown={handleKeyDown}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-gray-50">
        {/* File path and dirty indicator */}
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-gray-500" />
          <span className="text-sm font-medium text-gray-700">{filePath}</span>
          {isDirty && (
            <span
              data-testid="dirty-indicator"
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800"
            >
              Unsaved
            </span>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          {/* View mode buttons */}
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            <button
              data-testid="view-mode-split"
              aria-pressed={viewMode === 'split'}
              onClick={() => handleViewModeChange('split')}
              className={`p-1.5 rounded ${
                viewMode === 'split'
                  ? 'bg-white shadow-sm text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              title="Split view"
            >
              <Columns className="h-4 w-4" />
            </button>
            <button
              data-testid="view-mode-editor"
              aria-pressed={viewMode === 'editor'}
              onClick={() => handleViewModeChange('editor')}
              className={`p-1.5 rounded ${
                viewMode === 'editor'
                  ? 'bg-white shadow-sm text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              title="Editor only"
            >
              <FileText className="h-4 w-4" />
            </button>
            <button
              data-testid="view-mode-preview"
              aria-pressed={viewMode === 'preview'}
              onClick={() => handleViewModeChange('preview')}
              className={`p-1.5 rounded ${
                viewMode === 'preview'
                  ? 'bg-white shadow-sm text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              title="Preview only"
            >
              <Eye className="h-4 w-4" />
            </button>
          </div>

          {/* Save button */}
          <button
            data-testid="save-button"
            onClick={saveContent}
            disabled={!isDirty || isSaving}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              isDirty && !isSaving
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
            }`}
          >
            <Save className="h-4 w-4" />
            {isSaving ? 'Saving...' : 'Save'}
          </button>

          {/* Close button */}
          {onClose && (
            <button
              data-testid="close-button"
              onClick={handleClose}
              className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Large file warning */}
      {showLargeFileWarning && (
        <div
          data-testid="large-file-warning"
          className="flex items-center gap-2 px-4 py-2 bg-yellow-50 border-b border-yellow-200 text-yellow-800 text-sm"
        >
          <AlertTriangle className="h-4 w-4" />
          Large file: Performance may be affected.
          <button
            onClick={() => setShowLargeFileWarning(false)}
            className="ml-auto text-yellow-600 hover:text-yellow-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Editor */}
        <div
          data-testid="markdown-editor-container"
          className={`flex flex-col overflow-hidden transition-all duration-200 ${strategy.editorWidth} ${
            !strategy.showEditor ? 'hidden' : ''
          }`}
        >
          <textarea
            ref={textareaRef}
            data-testid="markdown-editor-textarea"
            value={content}
            onChange={handleContentChange}
            onKeyDown={handleKeyDown}
            className="flex-1 p-4 font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-inset"
            placeholder="Start typing markdown..."
            spellCheck={false}
          />
        </div>

        {/* Divider */}
        {strategy.showEditor && strategy.showPreview && (
          <div className="w-px bg-gray-200" />
        )}

        {/* Preview */}
        <div
          data-testid="markdown-preview-container"
          className={`flex flex-col overflow-hidden transition-all duration-200 ${strategy.previewWidth} ${
            !strategy.showPreview ? 'hidden' : ''
          }`}
        >
          <div
            data-testid="markdown-preview"
            className="flex-1 p-4 overflow-y-auto prose prose-sm max-w-none"
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[
                rehypeSanitize, // [SEC-MF-001] XSS protection
                rehypeHighlight,
              ]}
            >
              {previewContent}
            </ReactMarkdown>
          </div>
        </div>
      </div>

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onClose={removeToast} />
    </div>
  );
}
