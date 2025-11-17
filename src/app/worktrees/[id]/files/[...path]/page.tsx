/**
 * File Viewer Page
 * Full screen file content display with syntax highlighting
 */

'use client';

import React, { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card } from '@/components/ui';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

interface FileContent {
  path: string;
  content: string;
  extension: string;
  worktreePath: string;
}

export default function FileViewerPage() {
  const router = useRouter();
  const params = useParams();
  const worktreeId = params.id as string;
  const filePath = (params.path as string[]).join('/');

  const [content, setContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check if file is markdown
  const isMarkdown = content?.extension === 'md' || content?.extension === 'markdown';

  useEffect(() => {
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
      } catch (err: any) {
        setError(err.message || 'Failed to load file');
      } finally {
        setLoading(false);
      }
    };

    fetchFile();
  }, [worktreeId, filePath]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header with back button */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => router.back()}
            className="flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
            aria-label="戻る"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
            <span className="hidden sm:inline">戻る</span>
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold text-gray-900 truncate">
              {filePath}
            </h1>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        {loading && (
          <Card padding="lg">
            <div className="flex items-center justify-center py-12">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 border-t-blue-600" />
              <p className="ml-3 text-gray-600">Loading file...</p>
            </div>
          </Card>
        )}

        {error && (
          <Card padding="lg">
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center gap-2">
                <svg
                  className="w-5 h-5 text-red-600 flex-shrink-0"
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
          </Card>
        )}

        {content && !loading && !error && (
          <Card padding="none">
            <div className="bg-gray-100 px-4 py-3 border-b border-gray-200">
              <p className="text-xs text-gray-600 font-mono break-all">
                {content.worktreePath}/{content.path}
              </p>
            </div>
            <div className="p-4 bg-white">
              {isMarkdown ? (
                // Markdown rendering
                <div className="prose prose-sm sm:prose-base max-w-none break-words">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                  >
                    {content.content}
                  </ReactMarkdown>
                </div>
              ) : (
                // Code rendering with line wrapping
                <pre className="text-sm whitespace-pre-wrap break-all">
                  <code className={`language-${content.extension}`}>
                    {content.content}
                  </code>
                </pre>
              )}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
