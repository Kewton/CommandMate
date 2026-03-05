/**
 * FilePanelContent Component
 *
 * Renders file content in the file panel tab view.
 * Supports text (with syntax highlighting), images, videos,
 * markdown editor/preview, and MARP slides.
 *
 * Issue #438: PC file display panel with tabs
 */

'use client';

import React, { useEffect, useRef, memo, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Maximize2, Minimize2, ClipboardCopy, Check, Copy } from 'lucide-react';
import type { FileTab } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';
import { ImageViewer } from './ImageViewer';
import { VideoViewer } from './VideoViewer';
import { copyToClipboard } from '@/lib/clipboard-utils';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { Z_INDEX } from '@/config/z-index';

/** Dynamic import of MarkdownEditor for .md files in tab panel */
const MarkdownEditor = dynamic(
  () =>
    import('@/components/worktree/MarkdownEditor').then((mod) => ({
      default: mod.MarkdownEditor,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center py-12 bg-white dark:bg-gray-900">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 dark:border-gray-600 border-t-cyan-600 dark:border-t-cyan-400" />
      </div>
    ),
  },
);

// ============================================================================
// Types
// ============================================================================

export interface FilePanelContentProps {
  /** The file tab to display */
  tab: FileTab;
  /** Worktree ID for API calls */
  worktreeId: string;
  /** Callback when content is loaded */
  onLoadContent: (path: string, content: FileContent) => void;
  /** Callback when loading fails */
  onLoadError: (path: string, error: string) => void;
  /** Callback to set loading state */
  onSetLoading: (path: string, loading: boolean) => void;
  /** Callback when file is saved (refresh tree) */
  onFileSaved?: (path: string) => void;
}

// ============================================================================
// Constants
// ============================================================================

/** Maximum MARP content length (1MB) */
const MAX_MARP_CONTENT_LENGTH = 1_000_000;

/** MARP frontmatter detection pattern */
const MARP_FRONTMATTER_REGEX = /^---\s*\nmarp:\s*true/;

// ============================================================================
// Sub-components
// ============================================================================

/** Loading spinner */
function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 dark:border-gray-600 border-t-cyan-600 dark:border-t-cyan-400" />
      <p className="ml-3 text-gray-600 dark:text-gray-400">Loading file...</p>
    </div>
  );
}

/** Error display */
function ErrorDisplay({ error }: { error: string }) {
  return (
    <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4 m-4">
      <div className="flex items-center gap-2">
        <svg
          className="w-5 h-5 text-red-600 dark:text-red-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
      </div>
    </div>
  );
}

/** Toolbar with path copy, content copy, and maximize/minimize buttons */
function FileToolbar({ filePath, isMaximized, onToggleMaximize, copyableContent }: { filePath: string; isMaximized: boolean; onToggleMaximize: () => void; copyableContent?: string }) {
  const [pathCopied, setPathCopied] = useState(false);
  const [contentCopied, setContentCopied] = useState(false);
  const pathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (pathTimerRef.current) clearTimeout(pathTimerRef.current);
      if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
    };
  }, []);

  const handleCopyPath = async () => {
    try {
      await copyToClipboard(filePath);
      setPathCopied(true);
      if (pathTimerRef.current) clearTimeout(pathTimerRef.current);
      pathTimerRef.current = setTimeout(() => setPathCopied(false), 2000);
    } catch {
      // Silent failure
    }
  };

  const handleCopyContent = async () => {
    if (!copyableContent) return;
    try {
      await copyToClipboard(copyableContent);
      setContentCopied(true);
      if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
      contentTimerRef.current = setTimeout(() => setContentCopied(false), 2000);
    } catch {
      // Silent failure
    }
  };

  return (
    <div className="flex items-center justify-between p-1 border-b border-gray-200 dark:border-gray-700 gap-1">
      <div className="flex items-center gap-1 min-w-0">
        <button
          type="button"
          onClick={handleCopyPath}
          className="flex-shrink-0 p-1 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
          aria-label="Copy file path"
          title="Copy path"
        >
          {pathCopied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <ClipboardCopy className="w-3.5 h-3.5" />}
        </button>
        <span className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">{filePath}</span>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {copyableContent && (
          <button
            type="button"
            onClick={handleCopyContent}
            className="flex-shrink-0 p-1 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
            aria-label="Copy file content"
            title="Copy content"
          >
            {contentCopied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={onToggleMaximize}
          className="flex-shrink-0 p-1.5 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
          aria-label={isMaximized ? 'Minimize' : 'Maximize'}
          title={isMaximized ? 'Minimize' : 'Maximize'}
        >
          {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

/** Syntax-highlighted code viewer with line numbers */
function CodeViewer({ content, extension }: { content: string; extension: string }) {
  let highlighted: { value: string };
  try {
    highlighted = hljs.highlight(content, { language: extension, ignoreIllegals: true });
  } catch {
    // Unknown language — fall back to auto-detection
    highlighted = hljs.highlightAuto(content);
  }
  const lineCount = content.split('\n').length;
  return (
    <div className="overflow-auto h-full">
      <div className="flex text-sm">
        <div className="flex-shrink-0 py-4 pl-3 pr-2 text-right select-none text-gray-400 dark:text-gray-600 font-mono border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 sticky left-0">
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i + 1} className="leading-[1.5rem]">{i + 1}</div>
          ))}
        </div>
        <pre className="flex-1 p-4 overflow-x-auto text-gray-900 dark:text-gray-100 m-0">
          <code
            data-testid="file-content-code"
            className={`language-${extension} hljs`}
            style={{ lineHeight: '1.5rem' }}
            dangerouslySetInnerHTML={{ __html: highlighted.value }}
          />
        </pre>
      </div>
    </div>
  );
}

/** MARP slide preview */
function MarpPreview({
  slides,
  fileName,
}: {
  slides: string[];
  fileName: string;
}) {
  const [currentSlide, setCurrentSlide] = useState(0);

  const handlePrev = () => {
    setCurrentSlide((prev) => Math.max(0, prev - 1));
  };

  const handleNext = () => {
    setCurrentSlide((prev) => Math.min(slides.length - 1, prev + 1));
  };

  if (slides.length === 0) {
    return <div className="p-4 text-gray-500">No slides found in {fileName}</div>;
  }

  return (
    <div className="h-full flex flex-col" data-testid="marp-preview">
      <div className="flex items-center justify-between p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <button
          type="button"
          onClick={handlePrev}
          disabled={currentSlide === 0}
          className="px-3 py-1 text-sm rounded-md bg-gray-200 dark:bg-gray-700 disabled:opacity-50 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
        >
          Prev
        </button>
        <span className="text-sm text-gray-600 dark:text-gray-400">
          {currentSlide + 1} / {slides.length}
        </span>
        <button
          type="button"
          onClick={handleNext}
          disabled={currentSlide === slides.length - 1}
          className="px-3 py-1 text-sm rounded-md bg-gray-200 dark:bg-gray-700 disabled:opacity-50 hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
        >
          Next
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        <iframe
          srcDoc={slides[currentSlide]}
          sandbox=""
          title={`${fileName} - Slide ${currentSlide + 1}`}
          className="w-full h-full border-0"
        />
      </div>
    </div>
  );
}

/** MARP file with slides view + editor toggle */
function MarpEditorWithSlides({
  marpSlides,
  fileName,
  worktreeId,
  filePath,
  contentText,
  onFileSaved,
  isMaximized,
  onToggleMaximize,
}: {
  marpSlides: string[];
  fileName: string;
  worktreeId: string;
  filePath: string;
  contentText?: string;
  onFileSaved?: (path: string) => void;
  isMaximized: boolean;
  onToggleMaximize: () => void;
}) {
  const [marpViewMode, setMarpViewMode] = useState<'slides' | 'editor'>('slides');

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between p-1 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setMarpViewMode('slides')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              marpViewMode === 'slides'
                ? 'bg-cyan-100 dark:bg-cyan-900/50 text-cyan-700 dark:text-cyan-300'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            Slides
          </button>
          <button
            type="button"
            onClick={() => setMarpViewMode('editor')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              marpViewMode === 'editor'
                ? 'bg-cyan-100 dark:bg-cyan-900/50 text-cyan-700 dark:text-cyan-300'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            Editor
          </button>
        </div>
        <FileToolbar filePath={filePath} isMaximized={isMaximized} onToggleMaximize={onToggleMaximize} copyableContent={contentText} />
      </div>
      <div className="flex-1 min-h-0">
        {marpViewMode === 'slides' ? (
          <MarpPreview slides={marpSlides} fileName={fileName} />
        ) : (
          <MarkdownEditor
            worktreeId={worktreeId}
            filePath={filePath}
            onSave={onFileSaved}
            initialViewMode="split"
          />
        )}
      </div>
    </div>
  );
}

/** Wrapper that adds a maximize overlay */
function MaximizableWrapper({
  children,
  isMaximized,
  onToggle,
  filePath,
}: {
  children: React.ReactNode;
  isMaximized: boolean;
  onToggle: () => void;
  filePath: string;
}) {
  if (isMaximized) {
    return (
      <div
        className="fixed inset-0 bg-white dark:bg-gray-900 flex flex-col"
        style={{ zIndex: Z_INDEX.MAXIMIZED_EDITOR }}
      >
        <FileToolbar filePath={filePath} isMaximized={isMaximized} onToggleMaximize={onToggle} />
        <div className="flex-1 min-h-0 overflow-hidden">
          {children}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * FilePanelContent - Displays file content in the tab panel.
 *
 * Auto-fetches content when tab has no content loaded.
 * Renders appropriate viewer based on file type.
 * Supports maximize mode for all content types.
 * Markdown files get full editor/preview with save support.
 */
export const FilePanelContent = memo(function FilePanelContent({
  tab,
  worktreeId,
  onLoadContent,
  onLoadError,
  onSetLoading,
  onFileSaved,
}: FilePanelContentProps) {
  const fetchingRef = useRef(false);
  const [marpSlides, setMarpSlides] = useState<string[] | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  const toggleMaximize = useCallback(() => {
    setIsMaximized((prev) => !prev);
  }, []);

  // ESC to exit maximize
  useEffect(() => {
    if (!isMaximized) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsMaximized(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMaximized]);

  // Auto-fetch content when needed
  useEffect(() => {
    if (tab.content !== null || tab.loading || tab.error !== null) return;
    if (fetchingRef.current) return;

    fetchingRef.current = true;
    onSetLoading(tab.path, true);

    const fetchContent = async () => {
      try {
        const response = await fetch(
          `/api/worktrees/${worktreeId}/files/${tab.path}`,
        );

        if (!response.ok) {
          const errorData = await response.json();
          onLoadError(tab.path, errorData.error || 'Failed to load file');
          return;
        }

        const data: FileContent = await response.json();
        onLoadContent(tab.path, data);
      } catch (err: unknown) {
        onLoadError(
          tab.path,
          err instanceof Error ? err.message : 'Failed to load file',
        );
      } finally {
        fetchingRef.current = false;
      }
    };

    fetchContent();
  }, [tab.content, tab.loading, tab.error, tab.path, worktreeId, onLoadContent, onLoadError, onSetLoading]);

  // Fetch MARP slides when content is loaded and is a MARP file
  useEffect(() => {
    if (!tab.content || tab.content.extension !== 'md') return;
    if (!MARP_FRONTMATTER_REGEX.test(tab.content.content)) return;
    if (tab.content.content.length > MAX_MARP_CONTENT_LENGTH) return;

    const fetchMarpSlides = async () => {
      try {
        const response = await fetch(
          `/api/worktrees/${worktreeId}/marp-render`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ markdownContent: tab.content!.content }),
          },
        );
        if (response.ok) {
          const data = await response.json();
          setMarpSlides(data.slides);
        }
      } catch {
        // MARP rendering is best-effort; fall back to text display
      }
    };

    fetchMarpSlides();
  }, [tab.content, worktreeId]);

  // Loading state
  if (tab.loading) {
    return <LoadingSpinner />;
  }

  // Error state
  if (tab.error) {
    return <ErrorDisplay error={tab.error} />;
  }

  // No content yet (should not normally reach here due to auto-fetch)
  if (!tab.content) {
    return null;
  }

  const { content } = tab;

  // Image viewer
  if (content.isImage) {
    return (
      <MaximizableWrapper isMaximized={isMaximized} onToggle={toggleMaximize} filePath={tab.path}>
        <div className="h-full flex flex-col">
          <FileToolbar filePath={tab.path} isMaximized={isMaximized} onToggleMaximize={toggleMaximize} />
          <div className="flex-1 overflow-auto">
            <ImageViewer src={content.content} alt={content.path} mimeType={content.mimeType} />
          </div>
        </div>
      </MaximizableWrapper>
    );
  }

  // Video viewer
  if (content.isVideo) {
    return (
      <MaximizableWrapper isMaximized={isMaximized} onToggle={toggleMaximize} filePath={tab.path}>
        <div className="h-full flex flex-col">
          <FileToolbar filePath={tab.path} isMaximized={isMaximized} onToggleMaximize={toggleMaximize} />
          <div className="flex-1 overflow-auto">
            <VideoViewer src={content.content} mimeType={content.mimeType} />
          </div>
        </div>
      </MaximizableWrapper>
    );
  }

  // Markdown (including MARP): editor with preview/edit modes, save, auto-save
  // MARP files get an additional "Slides" tab to view rendered slides
  if (content.extension === 'md') {
    return (
      <MaximizableWrapper isMaximized={isMaximized} onToggle={toggleMaximize} filePath={tab.path}>
        <div className="h-full flex flex-col">
          {marpSlides ? (
            <MarpEditorWithSlides
              marpSlides={marpSlides}
              fileName={tab.name}
              worktreeId={worktreeId}
              filePath={tab.path}
              contentText={content.content}
              onFileSaved={onFileSaved}
              isMaximized={isMaximized}
              onToggleMaximize={toggleMaximize}
            />
          ) : (
            <>
              {!isMaximized && (
                <FileToolbar filePath={tab.path} isMaximized={isMaximized} onToggleMaximize={toggleMaximize} copyableContent={content.content} />
              )}
              <div className="flex-1 min-h-0">
                <MarkdownEditor
                  worktreeId={worktreeId}
                  filePath={tab.path}
                  onSave={onFileSaved}
                  initialViewMode="preview"
                />
              </div>
            </>
          )}
        </div>
      </MaximizableWrapper>
    );
  }

  // Default: syntax-highlighted code
  return (
    <MaximizableWrapper isMaximized={isMaximized} onToggle={toggleMaximize} filePath={tab.path}>
      <div className="h-full flex flex-col">
        <FileToolbar filePath={tab.path} isMaximized={isMaximized} onToggleMaximize={toggleMaximize} copyableContent={content.content} />
        <div className="flex-1 min-h-0">
          <CodeViewer content={content.content} extension={content.extension} />
        </div>
      </div>
    </MaximizableWrapper>
  );
});
