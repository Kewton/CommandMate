/**
 * FileViewer Component
 * Displays file contents in a modal with syntax highlighting
 */

'use client';

import React, { useState, useEffect } from 'react';
import { Modal } from '@/components/ui';

export interface FileViewerProps {
  isOpen: boolean;
  onClose: () => void;
  worktreeId: string;
  filePath: string;
}

interface FileContent {
  path: string;
  content: string;
  extension: string;
  worktreePath: string;
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
export function FileViewer({ isOpen, onClose, worktreeId, filePath }: FileViewerProps) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !filePath) {
      setContent(null);
      setError(null);
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
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 border-t-blue-600" />
            <p className="ml-3 text-gray-600">Loading file...</p>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-center gap-2">
              <svg
                className="w-5 h-5 text-red-600"
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
              <p className="text-sm text-red-800">{error}</p>
            </div>
          </div>
        )}

        {content && !loading && !error && (
          <div className="bg-gray-50 rounded-lg overflow-hidden">
            <div className="bg-gray-100 px-4 py-2 border-b border-gray-200">
              <p className="text-xs text-gray-600 font-mono">
                {content.worktreePath}/{content.path}
              </p>
            </div>
            <div className="p-4">
              <pre className="text-sm overflow-x-auto">
                <code className={`language-${content.extension}`}>
                  {content.content}
                </code>
              </pre>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
