/**
 * LogViewer Component
 * Displays log files for a worktree with search functionality
 */

'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Card, CardHeader, CardTitle, CardContent, Button, Badge } from '@/components/ui';
import { worktreeApi, handleApiError } from '@/lib/api-client';

export interface LogViewerProps {
  worktreeId: string;
}

/**
 * Log file viewer component with search
 *
 * @example
 * ```tsx
 * <LogViewer worktreeId="main" />
 * ```
 */
export function LogViewer({ worktreeId }: LogViewerProps) {
  const [logFiles, setLogFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState<number>(0);

  /**
   * Fetch log files list
   */
  useEffect(() => {
    const fetchLogFiles = async () => {
      try {
        setLoading(true);
        setError(null);
        const files = await worktreeApi.getLogs(worktreeId);
        setLogFiles(files);
      } catch (err) {
        setError(handleApiError(err));
      } finally {
        setLoading(false);
      }
    };

    fetchLogFiles();
  }, [worktreeId]);

  /**
   * Load log file content
   */
  const loadLogFile = async (filename: string) => {
    try {
      setLoading(true);
      setError(null);
      const data = await worktreeApi.getLogFile(worktreeId, filename);
      setFileContent(data.content);
      setSelectedFile(filename);
      setSearchQuery('');
      setCurrentMatchIndex(0);
    } catch (err) {
      setError(handleApiError(err));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Find all matches in content
   */
  const matches = useMemo(() => {
    if (!searchQuery || !fileContent) return [];

    const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const allMatches: { index: number; length: number }[] = [];
    let match;

    while ((match = regex.exec(fileContent)) !== null) {
      allMatches.push({
        index: match.index,
        length: match[0].length,
      });
    }

    return allMatches;
  }, [searchQuery, fileContent]);

  /**
   * Reset match index when search query changes
   */
  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [searchQuery]);

  /**
   * Navigate to next match
   */
  const goToNextMatch = () => {
    if (matches.length > 0) {
      setCurrentMatchIndex((prev) => (prev + 1) % matches.length);
    }
  };

  /**
   * Navigate to previous match
   */
  const goToPrevMatch = () => {
    if (matches.length > 0) {
      setCurrentMatchIndex((prev) => (prev - 1 + matches.length) % matches.length);
    }
  };

  /**
   * Highlight matches in content
   */
  const highlightedContent = useMemo(() => {
    if (!fileContent || !searchQuery || matches.length === 0) {
      return fileContent;
    }

    let result = '';
    let lastIndex = 0;

    matches.forEach((match, idx) => {
      // Add text before match
      result += fileContent.substring(lastIndex, match.index);

      // Add highlighted match
      const matchText = fileContent.substring(match.index, match.index + match.length);
      const isCurrent = idx === currentMatchIndex;
      result += `<mark class="${isCurrent ? 'bg-yellow-400 text-black' : 'bg-yellow-200 text-black'}" data-match-index="${idx}">${matchText}</mark>`;

      lastIndex = match.index + match.length;
    });

    // Add remaining text
    result += fileContent.substring(lastIndex);

    return result;
  }, [fileContent, searchQuery, matches, currentMatchIndex]);

  /**
   * Handle keyboard shortcuts for search navigation
   */
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        goToPrevMatch();
      } else {
        goToNextMatch();
      }
    }
  };

  /**
   * Scroll to current match when it changes
   */
  useEffect(() => {
    if (matches.length > 0 && currentMatchIndex >= 0) {
      // Wait for DOM to update
      setTimeout(() => {
        const currentMark = document.querySelector(`mark[data-match-index="${currentMatchIndex}"]`);
        if (currentMark) {
          currentMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 100);
    }
  }, [currentMatchIndex, matches.length]);

  return (
    <div className="space-y-4">
      {/* Log Files List */}
      <Card padding="md">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Log Files</CardTitle>
            <Badge variant="gray">{logFiles.length}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {loading && logFiles.length === 0 && (
            <div className="text-center py-4">
              <div className="inline-block animate-spin rounded-full h-6 w-6 border-4 border-gray-300 border-t-blue-600" />
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
              {error}
            </div>
          )}

          {!loading && logFiles.length === 0 && !error && (
            <p className="text-sm text-gray-600 text-center py-4">No log files found</p>
          )}

          {logFiles.length > 0 && (
            <div className="space-y-2">
              {logFiles.map((file) => (
                <button
                  key={file}
                  onClick={() => loadLogFile(file)}
                  className={`w-full text-left px-3 py-2 rounded text-sm font-mono transition-colors ${
                    selectedFile === file
                      ? 'bg-blue-50 text-blue-700 border border-blue-200'
                      : 'hover:bg-gray-50 border border-transparent'
                  }`}
                >
                  {file}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Log File Content */}
      {selectedFile && (
        <Card padding="md">
          <CardHeader>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <CardTitle className="font-mono text-base">{selectedFile}</CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectedFile(null);
                    setFileContent(null);
                    setSearchQuery('');
                    setCurrentMatchIndex(0);
                  }}
                >
                  Close
                </Button>
              </div>

              {/* Search Controls */}
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder="Search in log file..."
                    className="input w-full pr-20"
                  />
                  {matches.length > 0 && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500">
                      {currentMatchIndex + 1} / {matches.length}
                    </div>
                  )}
                </div>

                {/* Navigation Buttons */}
                {matches.length > 0 && (
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={goToPrevMatch}
                      disabled={matches.length === 0}
                      title="Previous match (Shift+Enter)"
                    >
                      ↑
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={goToNextMatch}
                      disabled={matches.length === 0}
                      title="Next match (Enter)"
                    >
                      ↓
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loading && (
              <div className="text-center py-8">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-gray-300 border-t-blue-600" />
              </div>
            )}

            {!loading && fileContent && (
              <div className="bg-gray-900 text-gray-100 rounded p-4 overflow-x-auto max-h-[500px] scrollbar-thin">
                {searchQuery && matches.length > 0 ? (
                  <pre
                    className="text-xs font-mono whitespace-pre-wrap"
                    dangerouslySetInnerHTML={{ __html: highlightedContent || '' }}
                  />
                ) : (
                  <pre className="text-xs font-mono whitespace-pre-wrap">{fileContent}</pre>
                )}
              </div>
            )}

            {!loading && searchQuery && matches.length === 0 && fileContent && (
              <div className="text-center py-4 text-sm text-gray-500">
                No matches found for "{searchQuery}"
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
