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

import React, { memo, useState, useEffect, useCallback, useMemo } from 'react';
import { Modal } from '@/components/ui';
import { FileContent } from '@/types/models';
import { ImageViewer } from './ImageViewer';
import { VideoViewer } from './VideoViewer';
import { copyToClipboard } from '@/lib/clipboard-utils';
import { Copy, Check, Maximize2, Minimize2, ClipboardCopy, Pencil } from 'lucide-react';
import { Z_INDEX } from '@/config/z-index';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';

/** MARP frontmatter detection pattern */
const MARP_FRONTMATTER_REGEX = /^---\s*\nmarp:\s*true/;

/** Maximum MARP content length (1MB) */
const MAX_MARP_CONTENT_LENGTH = 1_000_000;

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
      return;
    }

    const fetchFile = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/worktrees/${worktreeId}/files/${filePath}`
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

  /** Render the file content body */
  const renderContent = () => {
    if (!content) return null;

    if (content.isImage) {
      return <ImageViewer src={content.content} alt={content.path} mimeType={content.mimeType} />;
    }
    if (content.isVideo) {
      return <VideoViewer src={content.content} mimeType={content.mimeType} />;
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
    const lineCount = content.content.split('\n').length;
    return (
      <div className="overflow-auto">
        <div className="flex text-sm">
          <div className="flex-shrink-0 py-4 pl-3 pr-2 text-right select-none text-gray-400 dark:text-gray-600 font-mono border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 sticky left-0">
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i + 1} className="leading-[1.5rem]">{i + 1}</div>
            ))}
          </div>
          <pre className="flex-1 p-4 overflow-x-auto text-gray-900 dark:text-gray-100 m-0">
            <code
              className={`language-${content.extension} hljs`}
              style={{ lineHeight: '1.5rem' }}
              dangerouslySetInnerHTML={{ __html: (() => { try { return hljs.highlight(content.content, { language: content.extension, ignoreIllegals: true }).value; } catch { return hljs.highlightAuto(content.content).value; } })() }}
            />
          </pre>
        </div>
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
      <div className="max-h-[60vh] sm:max-h-[70vh] overflow-y-auto">
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
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg overflow-hidden">
            {renderToolbar()}
            {renderContent()}
          </div>
        )}
      </div>
    </Modal>
  );
});
