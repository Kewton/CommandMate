/**
 * TerminalDisplay Component
 *
 * Displays terminal output with ANSI color support and XSS prevention
 * Uses sanitizeTerminalOutput for security
 */

'use client';

import React, { useEffect, useRef, useMemo, memo } from 'react';
import { sanitizeTerminalOutput } from '@/lib/sanitize';
import { useTerminalScroll } from '@/hooks/useTerminalScroll';

/**
 * Props for TerminalDisplay component
 */
export interface TerminalDisplayProps {
  /** Terminal output text (may contain ANSI escape codes) */
  output: string;
  /** Whether the terminal session is currently active */
  isActive: boolean;
  /** Whether Claude is currently thinking/processing */
  isThinking?: boolean;
  /** Initial auto-scroll state (default: true) */
  autoScroll?: boolean;
  /** Callback when auto-scroll state changes */
  onScrollChange?: (enabled: boolean) => void;
  /** Disable auto-follow on new content (for TUI tools like OpenCode) */
  disableAutoFollow?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Thinking indicator component
 */
function ThinkingIndicator() {
  return (
    <div
      data-testid="thinking-indicator"
      className="flex items-center gap-2 py-2 px-1 text-gray-400"
    >
      <span className="flex gap-1">
        <span className="animate-pulse delay-0">.</span>
        <span className="animate-pulse delay-150">.</span>
        <span className="animate-pulse delay-300">.</span>
      </span>
      <span className="text-sm">Thinking</span>
    </div>
  );
}

/**
 * Terminal display component with ANSI color support
 *
 * @example
 * ```tsx
 * <TerminalDisplay
 *   output={terminalOutput}
 *   isActive={true}
 *   isThinking={true}
 *   onScrollChange={(enabled) => console.log('Auto-scroll:', enabled)}
 * />
 * ```
 */
export const TerminalDisplay = memo(function TerminalDisplay({
  output,
  isActive,
  isThinking = false,
  autoScroll: initialAutoScroll = true,
  onScrollChange,
  disableAutoFollow = false,
  className = '',
}: TerminalDisplayProps) {
  const { scrollRef, autoScroll, handleScroll, scrollToBottom, scrollToTop } =
    useTerminalScroll({
      initialAutoScroll,
      onAutoScrollChange: onScrollChange,
    });

  // Sanitize the output for safe rendering
  const sanitizedOutput = sanitizeTerminalOutput(output || '');

  // Issue #379: Track when we need to scroll to top on next content arrival.
  // When switching to a disableAutoFollow tab (OpenCode), the content is cleared then
  // reloaded asynchronously. We set this flag so that once the content arrives,
  // we scroll to top exactly once (allowing the user to scroll freely after).
  const needsScrollToTopRef = useRef(false);

  useEffect(() => {
    if (disableAutoFollow) {
      needsScrollToTopRef.current = true;
    }
  }, [disableAutoFollow]);

  // Auto-scroll effect when output changes
  // Issue #131: Use 'instant' to prevent scroll animation during worktree switching
  // Issue #379: Skip for TUI tools (OpenCode) where auto-following hides top menus
  useEffect(() => {
    if (!scrollRef.current) return;

    // Issue #379: Scroll to top once when content first arrives in disableAutoFollow mode
    if (needsScrollToTopRef.current && disableAutoFollow && sanitizedOutput) {
      scrollRef.current.scrollTo({ top: 0, behavior: 'instant' });
      needsScrollToTopRef.current = false;
      return;
    }

    if (!disableAutoFollow && autoScroll) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'instant',
      });
    }
  }, [sanitizedOutput, autoScroll, disableAutoFollow, scrollRef]);

  // Memoized CSS classes for performance
  const containerClasses = useMemo(
    () =>
      [
        // Base terminal styling
        'terminal',
        'font-mono',
        'text-sm',
        'p-4',
        'rounded-lg',
        'overflow-y-auto',
        'overflow-x-hidden',
        // Dark theme
        'bg-gray-900',
        'text-gray-300',
        // Border
        'border',
        'border-gray-700',
        // Height - flex container will control actual height
        'h-full',
        // Active state
        isActive ? 'active' : '',
        isActive ? 'border-blue-500' : '',
        // Custom classes
        className,
      ]
        .filter(Boolean)
        .join(' '),
    [isActive, className]
  );

  return (
    <div className="relative h-full flex flex-col">
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label="Terminal output"
        className={containerClasses}
        onScroll={handleScroll}
      >
        {/* Terminal output with sanitized HTML */}
        <div
          className="whitespace-pre-wrap break-words"
          dangerouslySetInnerHTML={{ __html: sanitizedOutput }}
        />

        {/* Thinking indicator */}
        {isActive && isThinking && <ThinkingIndicator />}
      </div>

      {/* Scroll button: shows "Scroll to top" at bottom, or "Scroll to bottom" when scrolled up */}
      {autoScroll ? (
        <button
          onClick={scrollToTop}
          className="absolute bottom-4 right-4 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded-md text-sm shadow-lg transition-colors"
          aria-label="Scroll to top"
        >
          Scroll to top
        </button>
      ) : (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded-md text-sm shadow-lg transition-colors"
          aria-label="Scroll to bottom"
        >
          Scroll to bottom
        </button>
      )}
    </div>
  );
});

export default TerminalDisplay;
