/**
 * HtmlPreview Component
 * Issue #490: HTML file rendering in file panel
 *
 * Provides source/preview/split view modes for HTML files with
 * sandbox level control (Safe/Interactive).
 *
 * Security:
 * - iframe sandbox attribute controls script execution
 * - Safe mode: all features disabled (sandbox="")
 * - Interactive mode: allow-scripts only (no allow-same-origin)
 * - DR4-001: No DOMPurify sanitization (iframe sandbox is the security boundary)
 * - DR4-002: Interactive mode requires user confirmation dialog
 */

'use client';

import React, { useState, useCallback, useRef, useMemo } from 'react';
import type { SandboxLevel } from '@/config/html-extensions';
import { SANDBOX_ATTRIBUTES } from '@/config/html-extensions';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';

// ============================================================================
// Types
// ============================================================================

export type HtmlViewMode = 'source' | 'preview' | 'split';

export interface HtmlPreviewProps {
  worktreeId: string;
  filePath: string;
  htmlContent: string;
  onFileSaved?: (path: string) => void;
  onDirtyChange?: (isDirty: boolean) => void;
}

// ============================================================================
// Sub-components
// ============================================================================

/** Syntax-highlighted HTML source viewer */
function HtmlSourceViewer({ content }: { content: string }) {
  const highlightedHtml = useMemo(() => {
    try {
      return hljs.highlight(content, { language: 'html', ignoreIllegals: true }).value;
    } catch {
      return hljs.highlightAuto(content).value;
    }
  }, [content]);

  const lines = useMemo(() => highlightedHtml.split('\n'), [highlightedHtml]);
  const lineNumbers = useMemo(
    () => Array.from({ length: content.split('\n').length }, (_, i) => i + 1),
    [content],
  );

  return (
    <div className="overflow-auto h-full" data-testid="html-source-viewer">
      <table className="text-sm w-full border-collapse">
        <tbody>
          {lineNumbers.map((lineNumber) => {
            const idx = lineNumber - 1;
            return (
              <tr key={lineNumber} data-line={lineNumber}>
                <td className="pl-3 pr-2 text-right select-none font-mono border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 sticky left-0 align-top whitespace-nowrap text-gray-400 dark:text-gray-600">
                  {lineNumber}
                </td>
                <td className="px-4 text-gray-900 dark:text-gray-100 align-top">
                  <pre className="m-0 whitespace-pre-wrap break-words font-mono" style={{ lineHeight: '1.5rem' }}>
                    <code
                      className="hljs"
                      style={{ padding: 0, background: 'transparent' }}
                      dangerouslySetInnerHTML={{ __html: lines[idx] ?? '' }}
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
}

/** iframe-based HTML preview */
function HtmlIframePreview({
  htmlContent,
  sandboxLevel,
  filePath,
}: {
  htmlContent: string;
  sandboxLevel: SandboxLevel;
  filePath: string;
}) {
  return (
    <iframe
      key={`${filePath}-${sandboxLevel}`}
      srcDoc={htmlContent}
      sandbox={SANDBOX_ATTRIBUTES[sandboxLevel]}
      title={`HTML Preview: ${filePath}`}
      className="w-full h-full border-0 bg-white"
      data-testid="html-iframe-preview"
    />
  );
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * HtmlPreview - HTML file viewer with source/preview/split modes.
 *
 * Features:
 * - Source view: syntax-highlighted HTML code
 * - Preview view: iframe srcDoc rendering with sandbox
 * - Split view: side-by-side source and preview (PC only)
 * - Safe/Interactive sandbox level toggle
 * - Interactive mode confirmation dialog (DR4-002)
 */
export function HtmlPreview({
  filePath,
  htmlContent,
}: HtmlPreviewProps) {
  const [viewMode, setViewMode] = useState<HtmlViewMode>('preview');
  const [sandboxLevel, setSandboxLevel] = useState<SandboxLevel>('safe');
  const confirmedFilesRef = useRef<Set<string>>(new Set());

  /** Handle sandbox level change with confirmation for Interactive mode (DR4-002) */
  const handleSandboxChange = useCallback((newLevel: SandboxLevel) => {
    if (newLevel === 'interactive' && !confirmedFilesRef.current.has(filePath)) {
      const confirmed = window.confirm(
        'Interactiveモードではスクリプトが実行されます。信頼できないHTMLファイルではSafeモードを使用してください。'
      );
      if (!confirmed) {
        return;
      }
      confirmedFilesRef.current.add(filePath);
    }
    setSandboxLevel(newLevel);
  }, [filePath]);

  return (
    <div className="h-full flex flex-col" data-testid="html-preview">
      {/* Toolbar */}
      <div className="flex items-center justify-between p-1 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex-shrink-0">
        {/* View mode buttons */}
        <div className="flex gap-1">
          {(['source', 'preview', 'split'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                viewMode === mode
                  ? 'bg-cyan-100 dark:bg-cyan-900/50 text-cyan-700 dark:text-cyan-300'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>

        {/* Sandbox level buttons */}
        <div className="flex gap-1">
          {(['safe', 'interactive'] as const).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => handleSandboxChange(level)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
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

      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {viewMode === 'source' && (
          <HtmlSourceViewer content={htmlContent} />
        )}
        {viewMode === 'preview' && (
          <HtmlIframePreview
            htmlContent={htmlContent}
            sandboxLevel={sandboxLevel}
            filePath={filePath}
          />
        )}
        {viewMode === 'split' && (
          <div className="flex h-full">
            <div className="w-1/2 border-r border-gray-200 dark:border-gray-700 overflow-hidden">
              <HtmlSourceViewer content={htmlContent} />
            </div>
            <div className="w-1/2 overflow-hidden">
              <HtmlIframePreview
                htmlContent={htmlContent}
                sandboxLevel={sandboxLevel}
                filePath={filePath}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
