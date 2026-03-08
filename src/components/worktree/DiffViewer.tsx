/**
 * DiffViewer Component
 * Issue #447: Displays git diff content in the right pane file panel area.
 *
 * Renders unified diff with color-coded lines (green for additions,
 * red for deletions, blue for hunk headers).
 */

'use client';

import React, { memo } from 'react';

// ============================================================================
// Types
// ============================================================================

export interface DiffViewerProps {
  /** The diff content to display */
  diff: string;
  /** File path being diffed */
  filePath: string;
  /** Callback to close the diff view */
  onClose: () => void;
}

// ============================================================================
// Sub-components
// ============================================================================

const DiffLine = memo(function DiffLine({ line }: { line: string }) {
  let className = 'whitespace-pre font-mono text-xs leading-5';

  if (line.startsWith('+') && !line.startsWith('+++')) {
    className += ' text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20';
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    className += ' text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20';
  } else if (line.startsWith('@@')) {
    className += ' text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/10';
  } else if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
    className += ' text-gray-500 dark:text-gray-400';
  } else {
    className += ' text-gray-700 dark:text-gray-300';
  }

  return <div className={className}>{line}</div>;
});

// ============================================================================
// Main Component
// ============================================================================

export const DiffViewer = memo(function DiffViewer({
  diff,
  filePath,
  onClose,
}: DiffViewerProps) {
  return (
    <div className="h-full flex flex-col bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-cyan-600 dark:text-cyan-400 shrink-0">
            DIFF
          </span>
          <span className="text-xs font-mono text-gray-600 dark:text-gray-300 truncate">
            {filePath}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded shrink-0"
          aria-label="Close diff view"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Diff content */}
      <div className="flex-1 overflow-auto p-2">
        <pre className="text-xs">
          <code>
            {diff.split('\n').map((line, index) => (
              <DiffLine key={index} line={line} />
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
});

export default DiffViewer;
