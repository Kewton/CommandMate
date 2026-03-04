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
import { Copy, Check } from 'lucide-react';

export interface FileViewerProps {
  isOpen: boolean;
  onClose: () => void;
  worktreeId: string;
  filePath: string;
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
export const FileViewer = memo(function FileViewer({ isOpen, onClose, worktreeId, filePath }: FileViewerProps) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
            <div className="bg-gray-100 dark:bg-gray-700 px-4 py-2 border-b border-gray-200 dark:border-gray-600 flex items-center justify-between">
              <p className="text-xs text-gray-600 dark:text-gray-400 font-mono truncate">
                {content.worktreePath}/{content.path}
              </p>
              {/* [Issue #162] Copy button for text files */}
              {canCopy && (
                <button
                  data-testid="copy-content-button"
                  onClick={handleCopy}
                  className="flex-shrink-0 ml-2 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                  aria-label="Copy file content"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-green-600" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              )}
            </div>
            {/* Image file: render with ImageViewer */}
            {content.isImage ? (
              <ImageViewer
                src={content.content}
                alt={content.path}
                mimeType={content.mimeType}
              />
            ) : content.isVideo ? (
              /* Video file: render with VideoViewer (Issue #302) */
              <VideoViewer
                src={content.content}
                mimeType={content.mimeType}
              />
            ) : (
              /* Text file: render with syntax highlighting */
              <div className="p-4">
                <pre className="text-sm overflow-x-auto text-gray-900 dark:text-gray-100">
                  <code className={`language-${content.extension}`}>
                    {content.content}
                  </code>
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
});
