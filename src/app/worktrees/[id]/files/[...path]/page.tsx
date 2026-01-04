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
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load file');
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
            <div className="p-6 sm:p-8 bg-white">
              {isMarkdown ? (
                // Markdown rendering with GitHub-like styling
                <div className="prose prose-slate max-w-none prose-headings:font-semibold prose-h1:text-3xl prose-h1:border-b prose-h1:pb-2 prose-h2:text-2xl prose-h2:border-b prose-h2:pb-2 prose-h3:text-xl prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline prose-pre:bg-gray-100 prose-pre:border prose-pre:border-gray-200 prose-code:text-sm prose-code:bg-gray-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-img:rounded-lg prose-img:shadow-md">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                      // Custom components for better rendering
                      code: ({ inline, className, children, ...props }: { inline?: boolean; className?: string; children?: React.ReactNode }) => {
                        if (inline) {
                          return (
                            <code className="bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
                              {children}
                            </code>
                          );
                        }
                        return (
                          <code className={className} {...props}>
                            {children}
                          </code>
                        );
                      },
                      pre: ({ children }: { children?: React.ReactNode }) => (
                        <pre className="bg-gray-50 border border-gray-200 rounded-md p-4 overflow-x-auto">
                          {children}
                        </pre>
                      ),
                      table: ({ children }: { children?: React.ReactNode }) => (
                        <div className="overflow-x-auto">
                          <table className="border-collapse border border-gray-300">
                            {children}
                          </table>
                        </div>
                      ),
                      th: ({ children }: { children?: React.ReactNode }) => (
                        <th className="border border-gray-300 bg-gray-100 px-4 py-2 text-left font-semibold">
                          {children}
                        </th>
                      ),
                      td: ({ children }: { children?: React.ReactNode }) => (
                        <td className="border border-gray-300 px-4 py-2">
                          {children}
                        </td>
                      ),
                      blockquote: ({ children }: { children?: React.ReactNode }) => (
                        <blockquote className="border-l-4 border-gray-300 pl-4 italic text-gray-700">
                          {children}
                        </blockquote>
                      ),
                    }}
                  >
                    {content.content}
                  </ReactMarkdown>
                </div>
              ) : (
                // Code rendering with line wrapping
                <pre className="bg-gray-50 border border-gray-200 rounded-md p-4 overflow-x-auto text-sm">
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
