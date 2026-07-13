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

import React, { useEffect, useRef, memo, useState, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Maximize2, Minimize2, ClipboardCopy, Check, Copy, Search } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FileTab } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';
import { useFileContentPolling } from '@/hooks/useFileContentPolling';
import { useFileContentSearch } from '@/hooks/useFileContentSearch';
import { FileSearchBar } from './FileSearchBar';
import { ImageViewer } from './ImageViewer';
import { VideoViewer } from './VideoViewer';
import { copyToClipboard } from '@/lib/clipboard-utils';
import { encodePathForUrl } from '@/lib/url-path-encoder';
import { isEditableExtension } from '@/config/editable-extensions';
import { VIEWER_OVERSCAN_LINES, VIEWER_CHUNK_LINE_SIZE } from '@/config/file-viewer-config';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { Z_INDEX } from '@/config/z-index';
import { COPY_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';
import { Skeleton } from '@/components/ui/Skeleton';
import { Spinner } from '@/components/ui/Spinner';

/** Fixed row height for the virtualized CodeViewer (px). Monospace + leading-6. */
const CODE_VIEWER_ROW_HEIGHT_PX = 24;

/** Shared loading fallback for dynamic imports */
function DynamicImportSpinner() {
  return (
    <div className="flex items-center justify-center py-12 bg-surface">
      <Spinner size="xl" variant="accent" />
    </div>
  );
}

/** Dynamic import of HtmlPreview for HTML files in tab panel - Issue #490 */
const HtmlPreview = dynamic(
  () =>
    import('@/components/worktree/HtmlPreview').then((mod) => ({
      default: mod.HtmlPreview,
    })),
  {
    ssr: false,
    loading: () => <DynamicImportSpinner />,
  },
);

/** Dynamic import of PdfPreview for PDF files in tab panel - Issue #673 */
const PdfPreview = dynamic(
  () =>
    import('@/components/worktree/PdfPreview').then((mod) => ({
      default: mod.PdfPreview,
    })),
  {
    ssr: false,
    loading: () => <DynamicImportSpinner />,
  },
);

/** Dynamic import of MarkdownEditor for .md files in tab panel */
const MarkdownEditor = dynamic(
  () =>
    import('@/components/worktree/MarkdownEditor').then((mod) => ({
      default: mod.MarkdownEditor,
    })),
  {
    ssr: false,
    loading: () => <DynamicImportSpinner />,
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
  /** Callback when isDirty state changes (Issue #469: polling control) */
  onDirtyChange?: (path: string, isDirty: boolean) => void;
  /** Callback to open a file from a link (Issue #505) */
  onOpenFile?: (path: string) => void;
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
      <Spinner size="xl" variant="accent" />
      <p className="ml-3 text-muted-foreground">Loading file...</p>
    </div>
  );
}

/** Error display */
function ErrorDisplay({ error }: { error: string }) {
  return (
    <div className="bg-danger-subtle border border-danger-border rounded-lg p-4 m-4">
      <div className="flex items-center gap-2">
        <svg
          className="w-5 h-5 text-danger-foreground"
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
        <p className="text-sm text-danger-foreground">{error}</p>
      </div>
    </div>
  );
}

/** Toolbar with path copy, content copy, search, and maximize/minimize buttons */
function FileToolbar({ filePath, isMaximized, onToggleMaximize, copyableContent, onSearch }: { filePath: string; isMaximized: boolean; onToggleMaximize: () => void; copyableContent?: string; onSearch?: () => void }) {
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
      pathTimerRef.current = setTimeout(() => setPathCopied(false), COPY_FEEDBACK_RESET_MS);
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
      contentTimerRef.current = setTimeout(() => setContentCopied(false), COPY_FEEDBACK_RESET_MS);
    } catch {
      // Silent failure
    }
  };

  return (
    <div className="flex items-center justify-between p-1 border-b border-border gap-1">
      <div className="flex items-center gap-1 min-w-0">
        <button
          type="button"
          onClick={handleCopyPath}
          className="flex-shrink-0 p-1 rounded-md hover:bg-muted text-muted-foreground transition-colors"
          aria-label="Copy file path"
          title="Copy path"
        >
          {pathCopied ? <Check className="w-3.5 h-3.5 text-success" /> : <ClipboardCopy className="w-3.5 h-3.5" />}
        </button>
        {/* [Issue #852] title shows full path on hover when truncated */}
        <span className="text-xs text-muted-foreground font-mono truncate" title={filePath}>{filePath}</span>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {/* [Issue #47] File content search button */}
        {onSearch && (
          <button
            type="button"
            onClick={onSearch}
            className="flex-shrink-0 p-1 rounded-md hover:bg-muted text-muted-foreground transition-colors"
            aria-label="Search in file"
            title="Search"
          >
            <Search className="w-3.5 h-3.5" />
          </button>
        )}
        {copyableContent && (
          <button
            type="button"
            onClick={handleCopyContent}
            className="flex-shrink-0 p-1 rounded-md hover:bg-muted text-muted-foreground transition-colors"
            aria-label="Copy file content"
            title="Copy content"
          >
            {contentCopied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={onToggleMaximize}
          className="flex-shrink-0 p-1.5 rounded-md hover:bg-muted text-muted-foreground transition-colors"
          aria-label={isMaximized ? 'Minimize' : 'Maximize'}
          title={isMaximized ? 'Minimize' : 'Maximize'}
        >
          {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

/**
 * [Issue #723] Lazy chunk-fetch hook for the virtualized CodeViewer.
 *
 * When the user scrolls outside the currently loaded slice, request the chunk
 * (aligned to {@link VIEWER_CHUNK_LINE_SIZE} boundaries) that contains the
 * first visible row. In-flight requests are tracked so the same chunk is not
 * fetched twice; only one chunk is requested per scroll position to keep the
 * effect cheap.
 *
 * The hook is a no-op whenever `worktreeId`, `filePath`, or
 * `onLineRangeFetched` is missing — that is, the consumer is showing a full
 * (non-paginated) file.
 */
function useLazyChunkFetcher({
  virtualItems,
  worktreeId,
  filePath,
  onLineRangeFetched,
  loadedStart,
  loadedLineCount,
}: {
  virtualItems: ReturnType<ReturnType<typeof useVirtualizer>['getVirtualItems']>;
  worktreeId?: string;
  filePath?: string;
  onLineRangeFetched?: (data: {
    content: string;
    range: { start: number; end: number };
    totalLines: number;
    totalBytes?: number;
  }) => void;
  loadedStart: number;
  loadedLineCount: number;
}) {
  const inflightChunksRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!worktreeId || !filePath || !onLineRangeFetched) return;
    if (virtualItems.length === 0) return;

    const firstVisible1 = virtualItems[0].index + 1;
    const lastVisible1 = virtualItems[virtualItems.length - 1].index + 1;
    const loadedEnd = loadedStart + loadedLineCount - 1;

    // Entire visible window already loaded — nothing to do.
    if (firstVisible1 >= loadedStart && lastVisible1 <= loadedEnd) return;

    // Round-down the first visible line to a chunk-aligned start.
    const targetStart =
      Math.max(1, Math.floor((firstVisible1 - 1) / VIEWER_CHUNK_LINE_SIZE) * VIEWER_CHUNK_LINE_SIZE + 1);
    const targetEnd = targetStart + VIEWER_CHUNK_LINE_SIZE - 1;
    const chunkKey = targetStart;
    if (inflightChunksRef.current.has(chunkKey)) return;
    inflightChunksRef.current.add(chunkKey);

    const url = `/api/worktrees/${worktreeId}/files/${encodePathForUrl(filePath)}?startLine=${targetStart}&endLine=${targetEnd}`;
    fetch(url)
      .then(async (res) => (res.ok ? res.json() : null))
      .then((data) => {
        inflightChunksRef.current.delete(chunkKey);
        if (!data || data.success !== true) return;
        onLineRangeFetched({
          content: data.content,
          range: data.range,
          totalLines: data.totalLines,
          totalBytes: data.totalBytes,
        });
      })
      .catch(() => {
        inflightChunksRef.current.delete(chunkKey);
      });
  }, [virtualItems, worktreeId, filePath, onLineRangeFetched, loadedStart, loadedLineCount]);
}

/**
 * Syntax-highlighted code viewer with line numbers and search support.
 *
 * [Issue #723] Rewritten to use `@tanstack/react-virtual` so that very large
 * files (tens of thousands of lines) only mount the visible rows + overscan,
 * preventing the previous full-DOM mount that caused PC hangs. Highlighting is
 * performed lazily on the visible chunk and cached in a `Map` keyed by chunk
 * index to avoid recomputation while scrolling.
 *
 * Props are unchanged for backward compat with `CodeViewerWithSearch` /
 * `MarkdownWithSearch`. When the parent supplies `worktreeId` + `filePath` and
 * the content's `totalLines` exceeds the loaded slice (i.e. line-range mode),
 * additional chunks are fetched lazily as the user scrolls.
 */
function CodeViewer({
  content,
  extension,
  searchMatches,
  searchCurrentIdx,
  totalLines,
  rangeStart,
  worktreeId,
  filePath,
  onLineRangeFetched,
}: {
  content: string;
  extension: string;
  searchMatches?: number[];
  searchCurrentIdx?: number;
  /** Total number of lines in the underlying file (defaults to lines in `content`). */
  totalLines?: number;
  /** 1-based start line of the currently loaded `content` slice (defaults to 1). */
  rangeStart?: number;
  /** When set together with `filePath`, enables chunked line-range fetching for partial slices. */
  worktreeId?: string;
  filePath?: string;
  /** Callback fired with a fetched chunk so the parent may merge it back into the FileContent state. */
  onLineRangeFetched?: (data: { content: string; range: { start: number; end: number }; totalLines: number; totalBytes?: number }) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Split loaded content into individual lines once per content change.
  const loadedLines = useMemo(() => content.split('\n'), [content]);

  // Effective totals (defaults preserve existing single-shot behaviour).
  const effectiveRangeStart = Math.max(1, rangeStart ?? 1);
  const loadedLineCount = loadedLines.length;
  const effectiveTotalLines = Math.max(totalLines ?? loadedLineCount, loadedLineCount);

  // Highlight cache: chunkIndex -> string[] (already split by line)
  const highlightCacheRef = useRef<Map<number, string[]>>(new Map());
  // Reset cache whenever content text or extension changes.
  useEffect(() => {
    highlightCacheRef.current.clear();
  }, [content, extension]);

  // [Issue #723] Per-chunk syntax highlight. Visible chunk index = floor(lineIdx / CHUNK).
  // Chunks are independent: minor cross-chunk boundary issues are accepted (documented).
  const getHighlightedLine = useCallback(
    (zeroBasedLineIdxInLoaded: number): string => {
      const chunkSize = VIEWER_CHUNK_LINE_SIZE;
      const chunkIndex = Math.floor(zeroBasedLineIdxInLoaded / chunkSize);
      const cache = highlightCacheRef.current;
      let chunkLines = cache.get(chunkIndex);
      if (!chunkLines) {
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, loadedLines.length);
        const chunkText = loadedLines.slice(start, end).join('\n');
        let highlighted = '';
        try {
          highlighted = hljs.highlight(chunkText, { language: extension, ignoreIllegals: true }).value;
        } catch {
          highlighted = hljs.highlightAuto(chunkText).value;
        }
        chunkLines = highlighted.split('\n');
        cache.set(chunkIndex, chunkLines);
      }
      const inChunkIdx = zeroBasedLineIdxInLoaded - chunkIndex * chunkSize;
      return chunkLines[inChunkIdx] ?? '';
    },
    [loadedLines, extension],
  );

  const matchSet = useMemo(() => new Set(searchMatches ?? []), [searchMatches]);
  const currentMatchLine = (searchMatches?.length ?? 0) > 0 ? searchMatches![searchCurrentIdx ?? 0] : -1;

  // Virtualizer over `effectiveTotalLines` so the scrollbar reflects the full
  // file even when only a slice is loaded.
  const virtualizer = useVirtualizer({
    count: effectiveTotalLines,
    getScrollElement: () => containerRef.current,
    estimateSize: () => CODE_VIEWER_ROW_HEIGHT_PX,
    overscan: VIEWER_OVERSCAN_LINES,
  });

  // Scroll to current match line (1-based)
  useEffect(() => {
    if (!searchMatches || searchMatches.length === 0) return;
    const lineNum = searchMatches[searchCurrentIdx ?? 0];
    if (!Number.isFinite(lineNum)) return;
    // Convert to 0-based index in the effective total line count
    const index = Math.max(0, Math.min(effectiveTotalLines - 1, lineNum - 1));
    virtualizer.scrollToIndex(index, { align: 'center' });
  }, [searchCurrentIdx, searchMatches, virtualizer, effectiveTotalLines]);

  // [Issue #723] Lazy chunk fetching for line-range mode (no-op unless worktreeId
  // + filePath + onLineRangeFetched are supplied).
  const virtualItems = virtualizer.getVirtualItems();
  useLazyChunkFetcher({
    virtualItems,
    worktreeId,
    filePath,
    onLineRangeFetched,
    loadedStart: effectiveRangeStart,
    loadedLineCount,
  });

  return (
    <div className="overflow-auto h-full" ref={containerRef} data-testid="file-content-code">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualRow) => {
          const lineNumber = virtualRow.index + 1; // 1-based line number in the full file
          const loadedIndex = lineNumber - effectiveRangeStart; // 0-based offset in loaded slice
          const isInLoaded = loadedIndex >= 0 && loadedIndex < loadedLineCount;
          const isCurrent = lineNumber === currentMatchLine;
          const isMatch = matchSet.has(lineNumber);
          const rowBg = isCurrent ? 'bg-warning/30' : isMatch ? 'bg-warning/15' : '';
          const html = isInLoaded ? getHighlightedLine(loadedIndex) : '';
          return (
            <div
              key={virtualRow.key}
              data-line={lineNumber}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className={`absolute left-0 right-0 flex font-mono text-sm ${rowBg}`}
              style={{
                top: 0,
                transform: `translateY(${virtualRow.start}px)`,
                height: `${CODE_VIEWER_ROW_HEIGHT_PX}px`,
                lineHeight: `${CODE_VIEWER_ROW_HEIGHT_PX}px`,
              }}
            >
              <div
                className={`px-3 text-right select-none border-r border-border bg-muted dark:bg-muted/50 whitespace-nowrap ${
                  isCurrent ? 'text-warning-foreground' : isMatch ? 'text-warning-foreground' : 'text-muted-foreground'
                }`}
                style={{ minWidth: '4rem' }}
              >
                {lineNumber}
              </div>
              <div className="px-4 text-foreground flex-1 min-w-0 overflow-hidden">
                {isInLoaded ? (
                  <code
                    className="hljs"
                    style={{ padding: 0, background: 'transparent', whiteSpace: 'pre' }}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                ) : (
                  <Skeleton className="h-4 w-3/4" />
                )}
              </div>
            </div>
          );
        })}
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
    return <div className="p-4 text-muted-foreground">No slides found in {fileName}</div>;
  }

  return (
    <div className="h-full flex flex-col" data-testid="marp-preview">
      <div className="flex items-center justify-between p-2 border-b border-border bg-muted">
        <button
          type="button"
          onClick={handlePrev}
          disabled={currentSlide === 0}
          className="px-3 py-1 text-sm rounded-md bg-muted disabled:opacity-50 hover:bg-muted/80 transition-colors"
        >
          Prev
        </button>
        <span className="text-sm text-muted-foreground">
          {currentSlide + 1} / {slides.length}
        </span>
        <button
          type="button"
          onClick={handleNext}
          disabled={currentSlide === slides.length - 1}
          className="px-3 py-1 text-sm rounded-md bg-muted disabled:opacity-50 hover:bg-muted/80 transition-colors"
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
/** [DR3-003] onOpenFile forwarded to MarkdownEditor in Editor mode */
function MarpEditorWithSlides({
  marpSlides,
  fileName,
  worktreeId,
  filePath,
  contentText,
  onFileSaved,
  isMaximized,
  onToggleMaximize,
  onDirtyChange,
  onOpenFile,
}: {
  marpSlides: string[];
  fileName: string;
  worktreeId: string;
  filePath: string;
  contentText?: string;
  onFileSaved?: (path: string) => void;
  isMaximized: boolean;
  onToggleMaximize: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  onOpenFile?: (path: string) => void;
}) {
  const [marpViewMode, setMarpViewMode] = useState<'slides' | 'editor'>('slides');

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between p-1 border-b border-border bg-muted">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setMarpViewMode('slides')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              marpViewMode === 'slides'
                ? 'bg-accent-100 dark:bg-accent-900/50 text-accent-700 dark:text-accent-300'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            Slides
          </button>
          <button
            type="button"
            onClick={() => setMarpViewMode('editor')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              marpViewMode === 'editor'
                ? 'bg-accent-100 dark:bg-accent-900/50 text-accent-700 dark:text-accent-300'
                : 'text-muted-foreground hover:bg-muted'
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
            onDirtyChange={onDirtyChange}
            onOpenFile={onOpenFile}
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
        className="fixed inset-0 bg-surface flex flex-col"
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

/** [Issue #47] Markdown editor with file content search (PC) [DR2-005] */
function MarkdownWithSearch({ tab, content, worktreeId, isMaximized, onToggleMaximize, onFileSaved, onDirtyChange, onOpenFile }: { tab: FileTab; content: FileContent; worktreeId: string; isMaximized: boolean; onToggleMaximize: () => void; onFileSaved?: (path: string) => void; onDirtyChange?: (isDirty: boolean) => void; onOpenFile?: (path: string) => void }) {
  const search = useFileContentSearch(content.content);

  return (
    <>
      {!isMaximized && (
        <FileToolbar filePath={tab.path} isMaximized={isMaximized} onToggleMaximize={onToggleMaximize} copyableContent={content.content} onSearch={search.openSearch} />
      )}
      {search.searchOpen && (
        <FileSearchBar
          inputRef={search.searchInputRef}
          searchQuery={search.searchQuery}
          onQueryChange={search.setSearchQuery}
          matchCount={search.searchMatches.length}
          currentIdx={search.searchCurrentIdx}
          onNextMatch={search.nextMatch}
          onPrevMatch={search.prevMatch}
          onClose={search.closeSearch}
        />
      )}
      <div className="flex-1 min-h-0">
        {search.searchOpen && search.searchQuery.length >= 2 ? (
          <CodeViewer
            content={content.content}
            extension="md"
            searchMatches={search.searchMatches}
            searchCurrentIdx={search.searchCurrentIdx}
          />
        ) : (
          <MarkdownEditor
            worktreeId={worktreeId}
            filePath={tab.path}
            onSave={onFileSaved}
            initialViewMode="preview"
            onDirtyChange={onDirtyChange}
            onOpenFile={onOpenFile}
          />
        )}
      </div>
    </>
  );
}

/** [Issue #47] Code viewer with file content search (PC) */
function CodeViewerWithSearch({
  tab,
  content,
  worktreeId,
  isMaximized,
  onToggleMaximize,
  onLoadContent,
}: {
  tab: FileTab;
  content: FileContent;
  worktreeId: string;
  isMaximized: boolean;
  onToggleMaximize: () => void;
  onLoadContent?: (path: string, content: FileContent) => void;
}) {
  const search = useFileContentSearch(content.content);

  // [Issue #723] When the loaded content is a partial slice (range != full file),
  // forward chunk-fetch results to the parent via onLoadContent so the cached
  // FileContent stays consistent.
  const handleLineRangeFetched = useCallback(
    (data: { content: string; range: { start: number; end: number }; totalLines: number; totalBytes?: number }) => {
      if (!onLoadContent) return;
      onLoadContent(tab.path, {
        ...content,
        content: data.content,
        totalLines: data.totalLines,
        totalBytes: data.totalBytes ?? content.totalBytes,
        range: data.range,
      });
    },
    [onLoadContent, tab.path, content],
  );

  // [Issue #723] Only enable chunk-fetch mode when the content is a partial slice
  // (has range AND totalLines bigger than slice length).
  const enableLineRangeFetch =
    content.range !== undefined && (content.totalLines ?? 0) > (content.range.end - content.range.start + 1);

  return (
    <div className="h-full flex flex-col">
      <FileToolbar filePath={tab.path} isMaximized={isMaximized} onToggleMaximize={onToggleMaximize} copyableContent={content.content} onSearch={search.openSearch} />
      {search.searchOpen && (
        <FileSearchBar
          inputRef={search.searchInputRef}
          searchQuery={search.searchQuery}
          onQueryChange={search.setSearchQuery}
          matchCount={search.searchMatches.length}
          currentIdx={search.searchCurrentIdx}
          onNextMatch={search.nextMatch}
          onPrevMatch={search.prevMatch}
          onClose={search.closeSearch}
        />
      )}
      <div className="flex-1 min-h-0">
        <CodeViewer
          content={content.content}
          extension={content.extension}
          searchMatches={search.searchOpen ? search.searchMatches : undefined}
          searchCurrentIdx={search.searchOpen ? search.searchCurrentIdx : undefined}
          totalLines={content.totalLines}
          rangeStart={content.range?.start}
          worktreeId={enableLineRangeFetch ? worktreeId : undefined}
          filePath={enableLineRangeFetch ? tab.path : undefined}
          onLineRangeFetched={enableLineRangeFetch ? handleLineRangeFetched : undefined}
        />
      </div>
    </div>
  );
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
  onDirtyChange,
  onOpenFile,
}: FilePanelContentProps) {
  const fetchingRef = useRef(false);
  const [marpSlides, setMarpSlides] = useState<string[] | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);

  // [Issue #469] File content polling for auto-update
  useFileContentPolling({ tab, worktreeId, onLoadContent });

  // Wrap onDirtyChange to bind tab.path (DRY: used by HtmlPreview, MarpEditor, MarkdownEditor)
  const handleDirtyChange = useMemo(
    () => onDirtyChange
      ? (isDirty: boolean) => onDirtyChange(tab.path, isDirty)
      : undefined,
    [onDirtyChange, tab.path],
  );

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
          `/api/worktrees/${worktreeId}/files/${encodePathForUrl(tab.path)}`,
        );

        // [Issue #469] Defensive 304 check for future-proofing
        if (response.status === 304) return;

        if (!response.ok) {
          const errorData = await response.json();
          const errMsg = typeof errorData.error === 'string'
            ? errorData.error
            : errorData.error?.message || 'Failed to load file';
          onLoadError(tab.path, errMsg);
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
  // Depend on content text (not object reference) to avoid re-fetching on polling updates
  const contentText = tab.content?.content ?? null;
  const contentExtension = tab.content?.extension ?? null;
  useEffect(() => {
    if (!contentText || contentExtension !== 'md') {
      setMarpSlides(null);
      return;
    }
    if (!MARP_FRONTMATTER_REGEX.test(contentText)) {
      setMarpSlides(null);
      return;
    }
    if (contentText.length > MAX_MARP_CONTENT_LENGTH) {
      setMarpSlides(null);
      return;
    }

    let cancelled = false;
    const fetchMarpSlides = async () => {
      try {
        const response = await fetch(
          `/api/worktrees/${worktreeId}/marp-render`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ markdownContent: contentText }),
          },
        );
        if (response.ok) {
          const data = await response.json();
          if (!cancelled) {
            setMarpSlides(Array.isArray(data.slides) ? data.slides : null);
          }
        }
      } catch {
        // MARP rendering is best-effort; fall back to text display
      }
    };

    void fetchMarpSlides();
    return () => {
      cancelled = true;
    };
  }, [contentText, contentExtension, worktreeId]);

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

  // [Issue #673] PDF preview (after isVideo, before isHtml)
  if (content.isPdf) {
    return (
      <MaximizableWrapper isMaximized={isMaximized} onToggle={toggleMaximize} filePath={tab.path}>
        <div className="h-full flex flex-col">
          <FileToolbar filePath={tab.path} isMaximized={isMaximized} onToggleMaximize={toggleMaximize} />
          <div className="flex-1 min-h-0">
            <PdfPreview dataUri={content.content} filePath={tab.path} />
          </div>
        </div>
      </MaximizableWrapper>
    );
  }

  // [Issue #490] HTML preview (after isVideo, before md - DR3-005)
  if (content.isHtml) {
    return (
      <MaximizableWrapper isMaximized={isMaximized} onToggle={toggleMaximize} filePath={tab.path}>
        <div className="h-full flex flex-col">
          <FileToolbar filePath={tab.path} isMaximized={isMaximized} onToggleMaximize={toggleMaximize} copyableContent={content.content} />
          <div className="flex-1 min-h-0">
            <HtmlPreview
              worktreeId={worktreeId}
              filePath={tab.path}
              htmlContent={content.content}
              onFileSaved={onFileSaved}
              onOpenFile={onOpenFile}
            />
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
              onDirtyChange={handleDirtyChange}
              onOpenFile={onOpenFile}
            />
          ) : (
            <MarkdownWithSearch
              tab={tab}
              content={content}
              worktreeId={worktreeId}
              isMaximized={isMaximized}
              onToggleMaximize={toggleMaximize}
              onFileSaved={onFileSaved}
              onDirtyChange={handleDirtyChange}
              onOpenFile={onOpenFile}
            />
          )}
        </div>
      </MaximizableWrapper>
    );
  }

  // Editable text files (YAML, etc.): text editor mode (Issue #646)
  if (isEditableExtension('.' + content.extension)) {
    return (
      <MaximizableWrapper isMaximized={isMaximized} onToggle={toggleMaximize} filePath={tab.path}>
        <div className="h-full flex flex-col">
          <MarkdownWithSearch
            tab={tab}
            content={content}
            worktreeId={worktreeId}
            isMaximized={isMaximized}
            onToggleMaximize={toggleMaximize}
            onFileSaved={onFileSaved}
            onDirtyChange={handleDirtyChange}
            onOpenFile={onOpenFile}
          />
        </div>
      </MaximizableWrapper>
    );
  }

  // Default: syntax-highlighted code with search
  return (
    <MaximizableWrapper isMaximized={isMaximized} onToggle={toggleMaximize} filePath={tab.path}>
      <CodeViewerWithSearch
        tab={tab}
        content={content}
        worktreeId={worktreeId}
        isMaximized={isMaximized}
        onToggleMaximize={toggleMaximize}
        onLoadContent={onLoadContent}
      />
    </MaximizableWrapper>
  );
});
