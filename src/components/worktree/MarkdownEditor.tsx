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
 * - Maximize/fullscreen mode (Ctrl/Cmd+Shift+F, ESC to exit)
 * - Resizable split view with PaneResizer
 * - Mobile-responsive with tab switching UI
 * - Mermaid diagram rendering [Issue #100]
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
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { Save, X, Columns, FileText, Eye, AlertTriangle, Maximize2, Minimize2, Copy, Check } from 'lucide-react';
import { debounce } from '@/lib/utils';
import { copyToClipboard } from '@/lib/clipboard-utils';
import { ToastContainer, useToast } from '@/components/common/Toast';
import { PaneResizer } from '@/components/worktree/PaneResizer';
import { MermaidCodeBlock } from '@/components/worktree/MermaidCodeBlock';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useFullscreen } from '@/hooks/useFullscreen';
import { useLocalStorageState } from '@/hooks/useLocalStorageState';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';
import { useVirtualKeyboard } from '@/hooks/useVirtualKeyboard';
import { Z_INDEX } from '@/config/z-index';
import type { EditorProps, ViewMode } from '@/types/markdown-editor';
import type { Components } from 'react-markdown';
import {
  VIEW_MODE_STRATEGIES,
  LOCAL_STORAGE_KEY,
  LOCAL_STORAGE_KEY_SPLIT_RATIO,
  LOCAL_STORAGE_KEY_MAXIMIZED,
  PREVIEW_DEBOUNCE_MS,
  FILE_SIZE_LIMITS,
  DEFAULT_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  isValidSplitRatio,
  isValidBoolean,
} from '@/types/markdown-editor';

/**
 * Mobile tab type for portrait mode
 */
type MobileTab = 'editor' | 'preview';

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
  onMaximizedChange,
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

  // [Issue #162] Copy to clipboard state
  const [copied, setCopied] = useState(false);

  // Mobile tab state (for portrait mode)
  const [mobileTab, setMobileTab] = useState<MobileTab>('editor');

  // Portal container state for maximized mode (Issue #104)
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);

  // Toast hook
  const { toasts, showToast, removeToast } = useToast();

  // Refs
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const beforeUnloadRef = useRef<((e: BeforeUnloadEvent) => void) | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentAreaRef = useRef<HTMLDivElement>(null);

  // Mobile detection
  const isMobile = useIsMobile();

  // Virtual keyboard detection (for mobile)
  const { isKeyboardVisible, keyboardHeight } = useVirtualKeyboard();

  // Fullscreen/maximize state with localStorage persistence
  const { value: isMaximizedPersisted, setValue: setMaximizedPersisted } = useLocalStorageState({
    key: LOCAL_STORAGE_KEY_MAXIMIZED,
    defaultValue: false,
    validate: isValidBoolean,
  });

  // Fullscreen hook
  const {
    isFullscreen: isMaximized,
    isFallbackMode,
    enterFullscreen,
    exitFullscreen,
    toggleFullscreen,
  } = useFullscreen({
    elementRef: containerRef,
    onEnter: () => setMaximizedPersisted(true),
    onExit: () => setMaximizedPersisted(false),
  });

  // Split ratio state with localStorage persistence
  const { value: splitRatio, setValue: setSplitRatio } = useLocalStorageState({
    key: LOCAL_STORAGE_KEY_SPLIT_RATIO,
    defaultValue: DEFAULT_SPLIT_RATIO,
    validate: isValidSplitRatio,
  });

  // Swipe gesture for exiting maximized mode (mobile)
  const { ref: swipeRef } = useSwipeGesture({
    onSwipeDown: () => {
      if (isMaximized) {
        exitFullscreen();
      }
    },
    threshold: 150,
    enabled: isMaximized && isMobile,
  });

  // Computed state
  const isDirty = content !== originalContent;
  const strategy = VIEW_MODE_STRATEGIES[viewMode];

  // In mobile portrait mode with split view, use tab switching
  const isMobilePortrait = isMobile && typeof window !== 'undefined' && window.innerHeight > window.innerWidth;
  const showMobileTabs = isMobilePortrait && viewMode === 'split';

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
   * [Issue #162] Handle copy content to clipboard
   */
  const handleCopy = useCallback(async () => {
    try {
      await copyToClipboard(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently fail - clipboard may not be available
    }
  }, [content]);

  /**
   * Handle resize from PaneResizer (delta in pixels)
   */
  const handleResize = useCallback(
    (delta: number) => {
      if (!contentAreaRef.current) return;

      const containerWidth = contentAreaRef.current.offsetWidth;
      if (containerWidth === 0) return;

      // Convert pixel delta to ratio delta
      const ratioDelta = delta / containerWidth;

      // Update split ratio with bounds checking
      setSplitRatio((prev) => {
        const newRatio = prev + ratioDelta;
        return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, newRatio));
      });
    },
    [setSplitRatio]
  );

  /**
   * Reset split ratio to 50:50 on double-click
   */
  const handleResetRatio = useCallback(() => {
    setSplitRatio(DEFAULT_SPLIT_RATIO);
  }, [setSplitRatio]);

  /**
   * Handle keyboard shortcuts
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ctrl+S or Cmd+S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveContent();
        return;
      }

      // Ctrl+Shift+F or Cmd+Shift+F to toggle maximize
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
        return;
      }

      // ESC to exit maximized mode
      if (e.key === 'Escape' && isMaximized) {
        e.preventDefault();
        exitFullscreen();
        return;
      }
    },
    [saveContent, toggleFullscreen, exitFullscreen, isMaximized]
  );

  // Global ESC key handler for maximized mode
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isMaximized) {
        e.preventDefault();
        exitFullscreen();
      }
    };

    if (isMaximized) {
      document.addEventListener('keydown', handleGlobalKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [isMaximized, exitFullscreen]);

  // Restore maximized state from localStorage on mount
  useEffect(() => {
    if (isMaximizedPersisted && !isMaximized) {
      enterFullscreen();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Issue #104: Create/cleanup portal container for maximized mode
  // Portal is needed because Modal's transform property creates a new stacking context
  // which prevents fixed positioning from covering the viewport
  useEffect(() => {
    if (typeof document === 'undefined') return;

    // Create portal container if it doesn't exist
    let container = document.getElementById('markdown-editor-portal');
    if (!container) {
      container = document.createElement('div');
      container.id = 'markdown-editor-portal';
      document.body.appendChild(container);
    }
    setPortalContainer(container);

    // Cleanup: remove container if empty when component unmounts
    return () => {
      const portalEl = document.getElementById('markdown-editor-portal');
      if (portalEl && portalEl.childNodes.length === 0) {
        portalEl.remove();
      }
    };
  }, []);

  // Issue #104: Notify parent when maximized state changes
  // This allows Modal to disable its ESC/backdrop handlers
  useEffect(() => {
    onMaximizedChange?.(isMaximized);
  }, [isMaximized, onMaximizedChange]);

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

  // Calculate container classes for maximized state
  const containerClasses = useMemo(() => {
    const base = 'flex flex-col bg-white';

    if (isMaximized && isFallbackMode) {
      // CSS fallback for fullscreen (iOS Safari, etc.)
      return `${base} fixed inset-0`;
    }

    return `${base} h-full`;
  }, [isMaximized, isFallbackMode]);

  // Calculate container style for z-index when maximized
  // Issue #104: z-index must be set for ALL maximized states, not just fallback mode.
  // On iPad Chrome landscape, Fullscreen API works (isFallbackMode=false), but we still
  // need z-index to ensure the editor appears above other UI elements like terminal tabs.
  // Note: containerClasses only applies `fixed inset-0` in fallback mode, as Fullscreen API
  // handles positioning natively. However, z-index is needed in BOTH modes.
  const containerStyle = useMemo(() => {
    if (isMaximized) {
      return { zIndex: Z_INDEX.MAXIMIZED_EDITOR };
    }
    return undefined;
  }, [isMaximized]);

  // Calculate editor width style for split view with custom ratio
  const editorWidthStyle = useMemo(() => {
    if (viewMode === 'split' && !showMobileTabs) {
      return { width: `${splitRatio * 100}%`, flexShrink: 0 };
    }
    return undefined;
  }, [viewMode, splitRatio, showMobileTabs]);

  // Calculate preview width style for split view with custom ratio
  const previewWidthStyle = useMemo(() => {
    if (viewMode === 'split' && !showMobileTabs) {
      return { width: `${(1 - splitRatio) * 100}%`, flexShrink: 0 };
    }
    return undefined;
  }, [viewMode, splitRatio, showMobileTabs]);

  // Adjust content area height for virtual keyboard
  const contentAreaStyle = useMemo(() => {
    if (isKeyboardVisible && keyboardHeight > 0) {
      return { paddingBottom: keyboardHeight };
    }
    return undefined;
  }, [isKeyboardVisible, keyboardHeight]);

  // Memoized ReactMarkdown components configuration (DRY principle)
  const markdownComponents: Partial<Components> = useMemo(
    () => ({
      code: MermaidCodeBlock, // [Issue #100] mermaid diagram support
    }),
    []
  );

  /**
   * Memoized ReactMarkdown element to avoid duplication (DRY principle)
   * Used in both mobile and desktop preview panes
   */
  const markdownPreview = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeSanitize, // [SEC-MF-001] XSS protection
          rehypeHighlight,
        ]}
        components={markdownComponents}
      >
        {previewContent}
      </ReactMarkdown>
    ),
    [previewContent, markdownComponents]
  );

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

  // Main editor content (may be rendered via Portal when maximized)
  const editorContent = (
    <div
      ref={(el) => {
        // Merge refs for containerRef and swipeRef
        (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        (swipeRef as React.MutableRefObject<HTMLElement | null>).current = el;
      }}
      data-testid="markdown-editor"
      className={containerClasses}
      style={containerStyle}
      onKeyDown={handleKeyDown}
      role={isMaximized && isFallbackMode ? 'dialog' : undefined}
      aria-modal={isMaximized && isFallbackMode ? 'true' : undefined}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-gray-50">
        {/* File path and dirty indicator */}
        <div className="flex items-center gap-2 min-w-0 flex-shrink">
          <FileText className="h-4 w-4 text-gray-500 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-700 truncate">{filePath}</span>
          {isDirty && (
            <span
              data-testid="dirty-indicator"
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 flex-shrink-0"
            >
              Unsaved
            </span>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* View mode buttons - hide on mobile portrait with split mode */}
          {!showMobileTabs && (
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
          )}

          {/* [Issue #162] Copy content button */}
          <button
            data-testid="copy-content-button"
            onClick={handleCopy}
            className={`p-1.5 hover:bg-gray-100 rounded ${
              copied ? 'text-green-500' : 'text-gray-500 hover:text-gray-700'
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
            onClick={toggleFullscreen}
            className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded"
            title={isMaximized ? 'Exit fullscreen (ESC)' : 'Enter fullscreen (Ctrl+Shift+F)'}
            aria-pressed={isMaximized}
          >
            {isMaximized ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>

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

      {/* ESC hint when maximized */}
      {isMaximized && (
        <div
          data-testid="maximize-hint"
          className="flex items-center justify-center px-4 py-1 bg-gray-800 text-gray-300 text-xs"
        >
          Press ESC to exit fullscreen {isMobile && '(or swipe down)'}
        </div>
      )}

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

      {/* Mobile tab bar (portrait mode with split view) */}
      {showMobileTabs && (
        <div className="flex border-b border-gray-200">
          <button
            data-testid="mobile-tab-editor"
            onClick={() => setMobileTab('editor')}
            className={`flex-1 py-2 text-sm font-medium ${
              mobileTab === 'editor'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500'
            }`}
          >
            <FileText className="h-4 w-4 inline-block mr-1" />
            Editor
          </button>
          <button
            data-testid="mobile-tab-preview"
            onClick={() => setMobileTab('preview')}
            className={`flex-1 py-2 text-sm font-medium ${
              mobileTab === 'preview'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-500'
            }`}
          >
            <Eye className="h-4 w-4 inline-block mr-1" />
            Preview
          </button>
        </div>
      )}

      {/* Main content area */}
      <div
        ref={contentAreaRef}
        className="flex flex-1 overflow-hidden"
        style={contentAreaStyle}
      >
        {/* Editor */}
        {showMobileTabs ? (
          // Mobile portrait: show based on tab
          mobileTab === 'editor' && (
            <div
              data-testid="markdown-editor-container"
              className="flex flex-col overflow-hidden w-full"
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
          )
        ) : (
          // Desktop or mobile landscape: normal layout
          <div
            data-testid="markdown-editor-container"
            className={`flex flex-col overflow-hidden transition-all duration-200 ${
              !strategy.showEditor ? 'hidden' : ''
            }`}
            style={viewMode === 'split' ? editorWidthStyle : { width: strategy.showEditor ? '100%' : '0%' }}
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
        )}

        {/* Resizer (only in split mode, not on mobile portrait) */}
        {viewMode === 'split' && strategy.showEditor && strategy.showPreview && !showMobileTabs && (
          <PaneResizer
            onResize={handleResize}
            onDoubleClick={handleResetRatio}
            orientation="horizontal"
            ariaValueNow={Math.round(splitRatio * 100)}
            minRatio={MIN_SPLIT_RATIO}
          />
        )}

        {/* Preview */}
        {showMobileTabs ? (
          // Mobile portrait: show based on tab
          mobileTab === 'preview' && (
            <div
              data-testid="markdown-preview-container"
              className="flex flex-col overflow-hidden w-full"
            >
              <div
                data-testid="markdown-preview"
                className="flex-1 p-4 overflow-y-auto prose prose-sm max-w-none"
              >
                {markdownPreview}
              </div>
            </div>
          )
        ) : (
          // Desktop or mobile landscape: normal layout
          <div
            data-testid="markdown-preview-container"
            className={`flex flex-col overflow-hidden transition-all duration-200 ${
              !strategy.showPreview ? 'hidden' : ''
            }`}
            style={viewMode === 'split' ? previewWidthStyle : { width: strategy.showPreview ? '100%' : '0%' }}
          >
            <div
              data-testid="markdown-preview"
              className="flex-1 p-4 overflow-y-auto prose prose-sm max-w-none"
            >
              {markdownPreview}
            </div>
          </div>
        )}
      </div>

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onClose={removeToast} />
    </div>
  );

  // Issue #104: Use Portal for maximized mode in CSS fallback
  // This breaks out of Modal's transform stacking context
  const usePortal = isMaximized && isFallbackMode && portalContainer;

  if (usePortal) {
    return createPortal(editorContent, portalContainer);
  }

  return editorContent;
}
