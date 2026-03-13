/**
 * FileViewer Component
 *
 * Displays file contents in a modal with syntax highlighting.
 * Supports both text files and image files.
 *
 * Image file handling flow:
 * 1. API returns isImage: true for image files
 * 2. FileViewer detects isImage flag
 * 3. ImageViewer component renders the Base64 data URI
 *
 * Text file features:
 * - Syntax highlighting via language-specific CSS classes
 * - Copy to clipboard with visual feedback (Copy -> Check icon, 2s)
 *
 * @module components/worktree/FileViewer
 */

'use client';

import React, { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Modal } from '@/components/ui';
import { FileContent } from '@/types/models';
import { ImageViewer } from './ImageViewer';
import { VideoViewer } from './VideoViewer';
import type { SandboxLevel } from '@/config/html-extensions';
import { SANDBOX_ATTRIBUTES } from '@/config/html-extensions';
import { copyToClipboard } from '@/lib/clipboard-utils';
import { Copy, Check, Maximize2, Minimize2, ClipboardCopy, Pencil, Search, X } from 'lucide-react';
import { Z_INDEX } from '@/config/z-index';
import { encodePathForUrl } from '@/lib/url-path-encoder';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';

/** MARP frontmatter detection pattern */
const MARP_FRONTMATTER_REGEX = /^---\s*\nmarp:\s*true/;

/** Maximum MARP content length (1MB) */
const MAX_MARP_CONTENT_LENGTH = 1_000_000;

/**
 * [Issue #490] Mobile HTML preview with tab switching (Source/Preview)
 * No split view on mobile due to space constraints.
 */
function HtmlPreviewMobile({
  htmlContent,
  filePath,
}: {
  htmlContent: string;
  filePath: string;
}) {
  const [activeTab, setActiveTab] = useState<'source' | 'preview'>('preview');
  const [sandboxLevel, setSandboxLevel] = useState<SandboxLevel>('safe');
  const confirmedFilesRef = useRef<Set<string>>(new Set());

  const handleSandboxChange = useCallback((newLevel: SandboxLevel) => {
    if (newLevel === 'interactive' && !confirmedFilesRef.current.has(filePath)) {
      const confirmed = window.confirm(
        'Interactiveモードではスクリプトが実行されます。信頼できないHTMLファイルではSafeモードを使用してください。'
      );
      if (!confirmed) return;
      confirmedFilesRef.current.add(filePath);
    }
    setSandboxLevel(newLevel);
  }, [filePath]);

  const highlightedHtml = useMemo(() => {
    try {
      return hljs.highlight(htmlContent, { language: 'html', ignoreIllegals: true }).value;
    } catch {
      return hljs.highlightAuto(htmlContent).value;
    }
  }, [htmlContent]);

  const lineNumbers = useMemo(
    () => Array.from({ length: htmlContent.split('\n').length }, (_, i) => i + 1),
    [htmlContent],
  );
  const highlightedLines = useMemo(() => highlightedHtml.split('\n'), [highlightedHtml]);

  return (
    <div className="flex flex-col h-full" data-testid="html-preview-mobile">
      {/* Tab bar */}
      <div className="flex items-center justify-between p-1 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div className="flex gap-1">
          {(['source', 'preview'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                activeTab === tab
                  ? 'bg-cyan-100 dark:bg-cyan-900/50 text-cyan-700 dark:text-cyan-300'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(['safe', 'interactive'] as const).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => handleSandboxChange(level)}
              className={`px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                sandboxLevel === level
                  ? level === 'safe'
                    ? 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300'
                    : 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {level.charAt(0).toUpperCase() + level.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-auto min-h-0">
        {activeTab === 'source' ? (
          <table className="text-sm w-full border-collapse">
            <tbody>
              {lineNumbers.map((lineNumber) => {
                const idx = lineNumber - 1;
                return (
                  <tr key={lineNumber}>
                    <td className="pl-3 pr-2 text-right select-none font-mono border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 sticky left-0 align-top whitespace-nowrap text-gray-400 dark:text-gray-600">
                      {lineNumber}
                    </td>
                    <td className="px-4 text-gray-900 dark:text-gray-100 align-top">
                      <pre className="m-0 whitespace-pre-wrap break-words font-mono">
                        <code
                          className="hljs"
                          dangerouslySetInnerHTML={{ __html: highlightedLines[idx] ?? '' }}
                        />
                      </pre>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <iframe
            key={`${filePath}-${sandboxLevel}`}
            srcDoc={htmlContent}
            sandbox={SANDBOX_ATTRIBUTES[sandboxLevel]}
            title={`HTML Preview: ${filePath}`}
            className="w-full h-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  );
}

export interface FileViewerProps {
  isOpen: boolean;
  onClose: () => void;
  worktreeId: string;
  filePath: string;
  /** Callback to open markdown editor (mobile) */
  onEditMarkdown?: (path: string) => void;
}

/**
 * File viewer modal component
 *
 * @example
 * ```tsx
 * <FileViewer
 *   isOpen={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   worktreeId="main"
 *   filePath="src/components/Foo.tsx"
 * />
 * ```
 */
export const FileViewer = memo(function FileViewer({ isOpen, onClose, worktreeId, filePath, onEditMarkdown }: FileViewerProps) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);
  const [marpSlides, setMarpSlides] = useState<string[] | null>(null);
  const [marpCurrentSlide, setMarpCurrentSlide] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<number[]>([]);
  const [searchCurrentIdx, setSearchCurrentIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const codeContainerRef = useRef<HTMLDivElement>(null);

  /** Whether the current content supports clipboard copy (text files only, not image/video) */
  const canCopy = useMemo(
    () => Boolean(content?.content && !content.isImage && !content.isVideo),
    [content]
  );

  /**
   * [Issue #162] Copy file content to clipboard.
   * Icon changes from Copy to Check for 2 seconds on success.
   * Failure is silently handled (icon remains unchanged).
   */
  const handleCopy = useCallback(async () => {
    if (!canCopy || !content?.content) return;
    try {
      await copyToClipboard(content.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Failure is indicated by icon not changing
    }
  }, [canCopy, content]);

  /** Copy file path to clipboard */
  const handleCopyPath = useCallback(async () => {
    try {
      await copyToClipboard(filePath);
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 2000);
    } catch {
      // Silent failure
    }
  }, [filePath]);

  /** Toggle fullscreen mode */
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  /** [Issue #47] Open file content search */
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);

  /** Close file content search */
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchMatches([]);
    setSearchCurrentIdx(0);
  }, []);

  /** Find line numbers matching query in file content */
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2 || !content?.content) {
      setSearchMatches([]);
      setSearchCurrentIdx(0);
      return;
    }
    const lines = content.content.split('\n');
    const lowerQuery = searchQuery.toLowerCase();
    const matches: number[] = [];
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes(lowerQuery)) {
        matches.push(idx + 1); // 1-based line numbers
      }
    });
    setSearchMatches(matches);
    setSearchCurrentIdx(0);
  }, [searchQuery, content?.content]);

  /** Scroll to the current match line */
  useEffect(() => {
    if (searchMatches.length === 0 || !codeContainerRef.current) return;
    const lineNum = searchMatches[searchCurrentIdx];
    const lineEl = codeContainerRef.current.querySelector(`[data-line="${lineNum}"]`);
    if (lineEl && typeof lineEl.scrollIntoView === 'function') {
      lineEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [searchCurrentIdx, searchMatches]);

  const nextSearchMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    setSearchCurrentIdx((prev) => (prev + 1) % searchMatches.length);
  }, [searchMatches.length]);

  const prevSearchMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    setSearchCurrentIdx((prev) => (prev - 1 + searchMatches.length) % searchMatches.length);
  }, [searchMatches.length]);

  // ESC to exit fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  useEffect(() => {
    if (!isOpen || !filePath) {
      setContent(null);
      setError(null);
      setCopied(false);
      closeSearch();
      return;
    }

    const fetchFile = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/worktrees/${worktreeId}/files/${encodePathForUrl(filePath)}`
        );

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to load file');
        }

        const data = await response.json();
        setContent(data);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load file');
      } finally {
        setLoading(false);
      }
    };

    fetchFile();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- closeSearch is stable (only resets state)
  }, [isOpen, worktreeId, filePath]);

  // Fetch MARP slides when content is a MARP markdown file
  useEffect(() => {
    setMarpSlides(null);
    setMarpCurrentSlide(0);
    if (!content || content.extension !== 'md') return;
    if (!MARP_FRONTMATTER_REGEX.test(content.content)) return;
    if (content.content.length > MAX_MARP_CONTENT_LENGTH) return;

    const fetchMarpSlides = async () => {
      try {
        const response = await fetch(
          `/api/worktrees/${worktreeId}/marp-render`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ markdownContent: content.content }),
          },
        );
        if (response.ok) {
          const data = await response.json();
          setMarpSlides(data.slides);
        }
      } catch {
        // Best-effort; fall back to text
      }
    };

    fetchMarpSlides();
  }, [content, worktreeId]);

  /** Whether the current file is a MARP presentation */
  const isMarp = Boolean(marpSlides && marpSlides.length > 0);

  /** Whether current file is editable markdown */
  const isMarkdown = content?.extension === 'md';

  /** Open markdown editor (closes this viewer first) */
  const handleEditMarkdown = useCallback(() => {
    if (onEditMarkdown && filePath) {
      onClose();
      onEditMarkdown(filePath);
    }
  }, [onEditMarkdown, filePath, onClose]);

  const codeViewData = useMemo(() => {
    if (!content || content.isImage || content.isVideo || content.isHtml || (isMarp && marpSlides)) {
      return null;
    }
    const lineNumbers = Array.from(
      { length: content.content.split('\n').length },
      (_, i) => i + 1,
    );
    try {
      return {
        lineNumbers,
        highlightedHtml: hljs.highlight(content.content, {
          language: content.extension,
          ignoreIllegals: true,
        }).value,
      };
    } catch {
      return {
        lineNumbers,
        highlightedHtml: hljs.highlightAuto(content.content).value,
      };
    }
  }, [content, isMarp, marpSlides]);

  /** Render the file content body */
  const renderContent = () => {
    if (!content) return null;

    if (content.isImage) {
      return <ImageViewer src={content.content} alt={content.path} mimeType={content.mimeType} />;
    }
    if (content.isVideo) {
      return <VideoViewer src={content.content} mimeType={content.mimeType} />;
    }
    // [Issue #490] HTML preview with mobile tab switching (Source/Preview)
    if (content.isHtml) {
      return (
        <HtmlPreviewMobile
          htmlContent={content.content}
          filePath={filePath}
        />
      );
    }
    if (isMarp && marpSlides) {
      return (
        <div className="flex flex-col">
          <div className="flex items-center justify-between p-2 bg-gray-100 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-600">
            <button
              type="button"
              onClick={() => setMarpCurrentSlide((prev) => Math.max(0, prev - 1))}
              disabled={marpCurrentSlide === 0}
              className="px-3 py-1 text-sm rounded-md bg-gray-200 dark:bg-gray-600 disabled:opacity-50 hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors"
            >
              Prev
            </button>
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {marpCurrentSlide + 1} / {marpSlides.length}
            </span>
            <button
              type="button"
              onClick={() => setMarpCurrentSlide((prev) => Math.min(marpSlides.length - 1, prev + 1))}
              disabled={marpCurrentSlide === marpSlides.length - 1}
              className="px-3 py-1 text-sm rounded-md bg-gray-200 dark:bg-gray-600 disabled:opacity-50 hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors"
            >
              Next
            </button>
          </div>
          <iframe
            srcDoc={marpSlides[marpCurrentSlide]}
            sandbox=""
            title={`${filePath} - Slide ${marpCurrentSlide + 1}`}
            className="w-full border-0"
            style={{ height: isFullscreen ? 'calc(100vh - 100px)' : '50vh' }}
          />
        </div>
      );
    }
    if (!codeViewData) return null;

    const matchSet = new Set(searchMatches);
    const currentMatchLine = searchMatches.length > 0 ? searchMatches[searchCurrentIdx] : -1;

    const highlightedLines = codeViewData.highlightedHtml.split('\n');

    return (
      <div ref={codeContainerRef}>
        <table className="text-sm w-full border-collapse">
          <tbody>
            {codeViewData.lineNumbers.map((lineNumber) => {
              const idx = lineNumber - 1;
              const isCurrent = lineNumber === currentMatchLine;
              const isMatch = matchSet.has(lineNumber);
              const rowBg = isCurrent ? 'bg-orange-400/30' : isMatch ? 'bg-yellow-400/15' : '';
              return (
                <tr key={lineNumber} data-line={lineNumber} className={rowBg}>
                  <td className={`pl-3 pr-2 text-right select-none font-mono border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 sticky left-0 align-top whitespace-nowrap ${isCurrent ? 'text-orange-300' : isMatch ? 'text-yellow-300' : 'text-gray-400 dark:text-gray-600'}`}>
                    {lineNumber}
                  </td>
                  <td className="px-4 text-gray-900 dark:text-gray-100 align-top">
                    <pre className="m-0 whitespace-pre-wrap break-words font-mono">
                      <code
                        className="hljs"
                        dangerouslySetInnerHTML={{ __html: highlightedLines[idx] ?? '' }}
                      />
                    </pre>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  /** Toolbar with path copy, content copy, and fullscreen buttons */
  const renderToolbar = () => (
    <div className="bg-gray-100 dark:bg-gray-700 px-3 py-1.5 border-b border-gray-200 dark:border-gray-600 flex items-center justify-between gap-2">
      <div className="flex items-center gap-1 min-w-0">
        <button
          onClick={handleCopyPath}
          className="flex-shrink-0 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          aria-label="Copy file path"
          title="Copy path"
        >
          {pathCopied ? (
            <Check className="w-3.5 h-3.5 text-green-600" />
          ) : (
            <ClipboardCopy className="w-3.5 h-3.5" />
          )}
        </button>
        <p className="text-xs text-gray-600 dark:text-gray-400 font-mono truncate">
          {filePath}
        </p>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {/* [Issue #47] File content search button */}
        {canCopy && (
          <button
            onClick={openSearch}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            aria-label="Search in file"
            title="Search"
          >
            <Search className="w-3.5 h-3.5" />
          </button>
        )}
        {isMarkdown && onEditMarkdown && (
          <button
            onClick={handleEditMarkdown}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            aria-label="Edit file"
            title="Edit"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
        {canCopy && (
          <button
            data-testid="copy-content-button"
            onClick={handleCopy}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            aria-label="Copy file content"
            title="Copy content"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-green-600" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        <button
          onClick={toggleFullscreen}
          className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );

  // Fullscreen mode: render as fixed overlay instead of modal
  if (isFullscreen && content && !loading && !error) {
    return (
      <div
        className="fixed inset-0 bg-white dark:bg-gray-900 flex flex-col"
        style={{ zIndex: Z_INDEX.MAXIMIZED_EDITOR }}
      >
        {renderToolbar()}
        {/* [Issue #47] File content search bar (fullscreen) */}
        {searchOpen && (
          <div className="flex items-center gap-1 px-2 py-1 bg-gray-200 dark:bg-gray-700 border-b border-gray-300 dark:border-gray-600">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { closeSearch(); }
                if (e.key === 'Enter') { if (e.shiftKey) { prevSearchMatch(); } else { nextSearchMatch(); } }
              }}
              placeholder="検索..."
              className="flex-1 min-w-0 px-2 py-0.5 text-sm bg-white dark:bg-gray-800 dark:text-gray-100 border border-gray-300 dark:border-gray-600 rounded outline-none focus:ring-1 focus:ring-cyan-500"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <span className="text-xs text-gray-500 min-w-[3rem] text-right">
              {searchMatches.length > 0 ? `${searchCurrentIdx + 1}/${searchMatches.length}` : '0/0'}
            </span>
            <button onClick={prevSearchMatch} disabled={searchMatches.length === 0} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white disabled:text-gray-300 dark:disabled:text-gray-600" aria-label="前の結果">▲</button>
            <button onClick={nextSearchMatch} disabled={searchMatches.length === 0} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white disabled:text-gray-300 dark:disabled:text-gray-600" aria-label="次の結果">▼</button>
            <button onClick={closeSearch} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-gray-400 hover:text-gray-800 dark:hover:text-white" aria-label="検索を閉じる"><X className="w-4 h-4" /></button>
          </div>
        )}
        <div className="flex-1 overflow-auto">
          {renderContent()}
        </div>
      </div>
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={filePath}
      size="xl"
    >
      <div className="max-h-[60vh] sm:max-h-[70vh] flex flex-col">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 dark:border-gray-600 border-t-cyan-600 dark:border-t-cyan-400" />
            <p className="ml-3 text-gray-600 dark:text-gray-400">Loading file...</p>
          </div>
        )}

        {error && (
          <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
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
        )}

        {content && !loading && !error && (
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg overflow-hidden flex flex-col min-h-0 flex-1">
            {/* Fixed header: toolbar + search bar */}
            <div className="flex-shrink-0">
              {renderToolbar()}
              {/* [Issue #47] File content search bar */}
              {searchOpen && (
                <div className="flex items-center gap-1 px-2 py-1 bg-gray-200 dark:bg-gray-700 border-b border-gray-300 dark:border-gray-600">
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { closeSearch(); }
                      if (e.key === 'Enter') { if (e.shiftKey) { prevSearchMatch(); } else { nextSearchMatch(); } }
                    }}
                    placeholder="検索..."
                    className="flex-1 min-w-0 px-2 py-0.5 text-sm bg-white dark:bg-gray-800 dark:text-gray-100 border border-gray-300 dark:border-gray-600 rounded outline-none focus:ring-1 focus:ring-cyan-500"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                  <span className="text-xs text-gray-500 min-w-[3rem] text-right">
                    {searchMatches.length > 0 ? `${searchCurrentIdx + 1}/${searchMatches.length}` : '0/0'}
                  </span>
                  <button onClick={prevSearchMatch} disabled={searchMatches.length === 0} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white disabled:text-gray-300 dark:disabled:text-gray-600" aria-label="前の結果">▲</button>
                  <button onClick={nextSearchMatch} disabled={searchMatches.length === 0} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white disabled:text-gray-300 dark:disabled:text-gray-600" aria-label="次の結果">▼</button>
                  <button onClick={closeSearch} className="min-w-[32px] min-h-[32px] flex items-center justify-center text-gray-400 hover:text-gray-800 dark:hover:text-white" aria-label="検索を閉じる"><X className="w-4 h-4" /></button>
                </div>
              )}
            </div>
            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto min-h-0">
              {renderContent()}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
});
