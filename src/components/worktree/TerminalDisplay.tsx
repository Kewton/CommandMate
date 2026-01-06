/**
 * TerminalDisplay Component
 *
 * Displays terminal output with ANSI color support and XSS prevention
 * Uses sanitizeTerminalOutput for security
 */

'use client';

import React, { useEffect, useMemo, memo } from 'react';
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
  className = '',
}: TerminalDisplayProps) {
  const { scrollRef, autoScroll, handleScroll, scrollToBottom } =
    useTerminalScroll({
      initialAutoScroll,
      onAutoScrollChange: onScrollChange,
    });

  // Sanitize the output for safe rendering
  const sanitizedOutput = sanitizeTerminalOutput(output || '');

  // Auto-scroll effect when output changes
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [sanitizedOutput, autoScroll, scrollRef]);

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
        // Height
        'min-h-[200px]',
        'max-h-[500px]',
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
    <div className="relative">
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

      {/* Scroll to bottom button (shown when auto-scroll is disabled) */}
      {!autoScroll && (
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
