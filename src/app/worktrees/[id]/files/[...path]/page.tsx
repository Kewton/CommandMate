/**
 * File Viewer Page
 * Full screen file content display with syntax highlighting
 */

'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { List, BookOpen } from 'lucide-react';
import { Card, Spinner } from '@/components/ui';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeSlug from 'rehype-slug';
import { FileContent } from '@/types/models';
import { ImageViewer } from '@/components/worktree/ImageViewer';
import { VideoViewer } from '@/components/worktree/VideoViewer';
import { MarkdownToc } from '@/components/worktree/MarkdownToc';
import { CodeBlockWithCopy } from '@/components/common/CodeBlockWithCopy';
import { extractToc, TOC_VISIBLE_STORAGE_KEY } from '@/lib/markdown-toc';

/**
 * Sticky page-header height (px). Rendered headings get this much
 * `scroll-margin-top` and the scroll-spy uses it as a `rootMargin` offset so
 * jumped-to headings clear the header (Issue #1007).
 */
const HEADER_OFFSET_PX = 57;

export default function FileViewerPage() {
  const router = useRouter();
  const params = useParams();
  const tCommon = useTranslations('common');
  const tWorktree = useTranslations('worktree');
  const worktreeId = params.id as string;
  const filePath = (params.path as string[]).join('/');

  const [content, setContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // TOC visibility. Start from the hydration-safe default (visible), then read
  // the persisted value after mount so the server and first client render match
  // (Issue #1007). The 0–1 heading auto-hide below takes precedence.
  const [tocVisible, setTocVisible] = useState(true);
  const [tocHydrated, setTocHydrated] = useState(false);

  // Check if file is markdown
  const isMarkdown = content?.extension === 'md' || content?.extension === 'markdown';

  // Headings for the TOC (only for markdown). ≥2 headings are required for the
  // sidebar/toggle to appear.
  const tocEntries = useMemo(
    () => (isMarkdown && content ? extractToc(content.content) : []),
    [isMarkdown, content]
  );
  const hasToc = tocEntries.length >= 2;
  const showToc = isMarkdown && hasToc && tocVisible;

  // Restore persisted TOC visibility after mount (hydration-safe).
  useEffect(() => {
    const stored = localStorage.getItem(TOC_VISIBLE_STORAGE_KEY);
    if (stored === 'true') {
      setTocVisible(true);
    } else if (stored === 'false') {
      setTocVisible(false);
    }
    setTocHydrated(true);
  }, []);

  // Persist TOC visibility once hydrated (avoid clobbering before restore).
  useEffect(() => {
    if (tocHydrated) {
      localStorage.setItem(TOC_VISIBLE_STORAGE_KEY, String(tocVisible));
    }
  }, [tocVisible, tocHydrated]);

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
            aria-label={tCommon('back')}
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
            <span className="hidden sm:inline">{tCommon('back')}</span>
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold text-gray-900 truncate">
              {filePath}
            </h1>
          </div>
          {/* TOC toggle — desktop only, and only when there is a TOC to show
              (no no-op control on mobile / short docs). Issue #1007 */}
          {isMarkdown && hasToc && (
            <button
              onClick={() => setTocVisible((visible) => !visible)}
              aria-pressed={tocVisible}
              aria-label={tocVisible ? tWorktree('toc.hide') : tWorktree('toc.show')}
              title={tocVisible ? tWorktree('toc.hide') : tWorktree('toc.show')}
              className="hidden lg:flex items-center gap-1.5 flex-shrink-0 rounded-md border border-gray-200 px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
            >
              {tocVisible ? (
                <List className="w-4 h-4" />
              ) : (
                <BookOpen className="w-4 h-4" />
              )}
              <span className="hidden xl:inline">{tWorktree('toc.title')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        {loading && (
          <Card padding="lg">
            <div className="flex items-center justify-center py-12">
              <Spinner size="xl" variant="accent" />
              <p className="ml-3 text-gray-600">Loading file...</p>
            </div>
          </Card>
        )}

        {error && (
          <Card padding="lg">
            <div className="bg-danger-subtle border border-danger-border rounded-lg p-4">
              <div className="flex items-center gap-2">
                <svg
                  className="w-5 h-5 text-danger-foreground flex-shrink-0"
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
              {content.isVideo ? (
                // Video rendering (Issue #302)
                <VideoViewer
                  src={content.content}
                  mimeType={content.mimeType}
                />
              ) : content.isImage ? (
                // Image rendering
                <ImageViewer
                  src={content.content}
                  alt={content.path}
                  mimeType={content.mimeType}
                />
              ) : isMarkdown ? (
                // Markdown rendering with GitHub-like styling. Layout changes
                // (flex row + side TOC) are scoped to this branch only so the
                // image/video/code viewers are unaffected (Issue #1007).
                <div className="lg:flex lg:gap-6 lg:items-start">
                <div className="min-w-0 lg:flex-1 prose prose-slate max-w-none prose-headings:font-semibold prose-headings:scroll-mt-[57px] prose-h1:text-3xl prose-h1:border-b prose-h1:pb-2 prose-h2:text-2xl prose-h2:border-b prose-h2:pb-2 prose-h3:text-xl prose-a:text-accent-600 prose-a:no-underline hover:prose-a:underline prose-code:text-sm prose-code:bg-gray-100 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-img:rounded-lg prose-img:shadow-md">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeSlug, rehypeHighlight]}
                    components={{
                      // Custom components for better rendering.
                      // Issue #983: react-markdown v10 dropped the `inline`
                      // prop. Inline code carries no `language-*` class; fenced
                      // block code does (and gets a copy button via the `pre`
                      // renderer below). Detect inline via the class instead.
                      code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode }) => {
                        const isInline = !className || !className.includes('language-');
                        if (isInline) {
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
                      // Issue #981: wrap code blocks with a copy button. The
                      // wrapper sits outside the scrollable <pre> so the button
                      // stays pinned to the top-right while code scrolls.
                      pre: ({ children }: { children?: React.ReactNode }) => (
                        <CodeBlockWithCopy>
                          <pre className="overflow-x-auto">
                            {children}
                          </pre>
                        </CodeBlockWithCopy>
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
                {/* Side TOC — desktop only, hidden below lg and when the
                    document has 0–1 headings (auto-hide takes precedence over
                    the persisted visible state). Issue #1007 */}
                {showToc && (
                  <aside className="hidden lg:block lg:w-64 lg:flex-shrink-0">
                    <div className="lg:sticky" style={{ top: `${HEADER_OFFSET_PX + 8}px` }}>
                      <MarkdownToc
                        entries={tocEntries}
                        title={tWorktree('toc.title')}
                        headerOffset={HEADER_OFFSET_PX}
                      />
                    </div>
                  </aside>
                )}
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
