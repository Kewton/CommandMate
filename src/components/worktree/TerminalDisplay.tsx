/**
 * TerminalDisplay Component
 *
 * Displays terminal output with ANSI color support and XSS prevention
 * Uses sanitizeTerminalOutput for security
 */

'use client';

import React, { useEffect, useRef, useState, useMemo, memo, useCallback } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { sanitizeTerminalOutput } from '@/lib/security/sanitize';
import { computeTerminalUpdate } from '@/lib/terminal/terminal-diff';
import { normalizeTerminalOutputForDisplay } from '@/lib/terminal/terminal-display-normalizer';
import { useTerminalScroll } from '@/hooks/useTerminalScroll';
import { useTerminalSearch } from '@/hooks/useTerminalSearch';
import { TerminalSearchBar } from '@/components/worktree/TerminalSearchBar';

/**
 * Props for TerminalDisplay component
 */
export interface TerminalDisplayProps {
  /** Terminal output text (may contain ANSI escape codes) */
  output: string;
  /** Whether the terminal session is currently active */
  isActive: boolean;
  /**
   * Issue #842: true while the pane is performing its initial attach (before the
   * first /current-output response). Used to render a "loading" placeholder and
   * to suppress the "session ended" placeholder during load / not-started states.
   */
  attaching?: boolean;
  /** Whether Claude is currently thinking/processing */
  isThinking?: boolean;
  /** Initial auto-scroll state (default: true) */
  autoScroll?: boolean;
  /** Callback when auto-scroll state changes */
  onScrollChange?: (enabled: boolean) => void;
  /** Disable auto-follow on new content (for TUI tools like OpenCode) */
  disableAutoFollow?: boolean;
  /**
   * Issue #1172: opt-in display-only compression of layout blank rows for
   * Claude/Codex 1000-row panes. When true, the rendered/searched/scrolled text
   * is derived from `normalizeTerminalOutputForDisplay(output)`; the raw `output`
   * (and every consumer of it) is untouched. Default false — no other CLI's
   * display changes.
   */
  compactTuiLayoutPadding?: boolean;
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
  attaching = false,
  isThinking = false,
  autoScroll: initialAutoScroll = true,
  onScrollChange,
  disableAutoFollow = false,
  compactTuiLayoutPadding = false,
  className = '',
}: TerminalDisplayProps) {
  const { scrollRef, autoScroll, handleScroll, scrollToBottom, scrollToTop } =
    useTerminalScroll({
      initialAutoScroll,
      onAutoScrollChange: onScrollChange,
    });

  // Issue #1172: `rawOutput` stays authoritative for lifecycle (attaching /
  // never-started / ended). `displayOutput` is the opt-in compacted text that
  // drives rendering, search, diffing and auto-scroll. When compaction is off
  // (default) they are identical, so non-Claude/Codex panes render byte-for-byte
  // as before. Because JS strings compare by value, a raw-only frame change that
  // yields an identical `displayOutput` is `Object.is`-equal here, so downstream
  // memos/effects do not re-render, re-search or re-scroll.
  const rawOutput = output ?? '';
  const displayOutput = useMemo(
    () =>
      compactTuiLayoutPadding
        ? normalizeTerminalOutputForDisplay(rawOutput)
        : rawOutput,
    [compactTuiLayoutPadding, rawOutput]
  );

  // [Issue #47] Terminal search - scrollRef is reused as containerRef
  const {
    isOpen: isSearchOpen,
    query: searchQuery,
    matchCount,
    currentIndex: searchCurrentIndex,
    isAtMaxMatches,
    openSearch,
    closeSearch,
    setQuery: setSearchQuery,
    nextMatch,
    prevMatch,
  } = useTerminalSearch({ output: displayOutput, containerRef: scrollRef });

  // [Issue #47] Ctrl+F / Cmd+F handler to open search (suppresses browser find)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        openSearch();
      }
    },
    [openSearch]
  );

  // [Issue #47] Listen for custom event from terminal header search button
  useEffect(() => {
    const handler = () => openSearch();
    window.addEventListener('terminal-search-open', handler);
    return () => window.removeEventListener('terminal-search-open', handler);
  }, [openSearch]);

  // Issue #1120: selection-preserving rendering. Instead of replacing the entire
  // innerHTML on every update (which clears any active text selection), we diff
  // the previous vs. next raw output and, on a clean append, push a NEW keyed
  // chunk. React leaves the already-rendered chunk DOM (and any selection inside
  // it) untouched and only mounts the appended node. Divergence falls back to a
  // full replace (single fresh chunk).
  const MAX_RENDERED_CHUNKS = 400;
  const [renderedChunks, setRenderedChunks] = useState<Array<{ key: number; html: string }>>(() =>
    displayOutput ? [{ key: 0, html: sanitizeTerminalOutput(displayOutput) }] : []
  );
  const prevOutputRef = useRef(displayOutput);
  const chunkKeyRef = useRef(0);

  useEffect(() => {
    const update = computeTerminalUpdate(prevOutputRef.current, displayOutput);
    prevOutputRef.current = displayOutput;
    if (update.mode === 'noop') return;

    if (update.mode === 'append') {
      setRenderedChunks((prev) => {
        chunkKeyRef.current += 1;
        // Coalesce back to a single chunk if the DOM node count grows unbounded.
        if (prev.length >= MAX_RENDERED_CHUNKS) {
          return [{ key: chunkKeyRef.current, html: sanitizeTerminalOutput(displayOutput) }];
        }
        return [...prev, { key: chunkKeyRef.current, html: sanitizeTerminalOutput(update.appended) }];
      });
      return;
    }

    // replace
    chunkKeyRef.current += 1;
    setRenderedChunks(
      displayOutput ? [{ key: chunkKeyRef.current, html: sanitizeTerminalOutput(displayOutput) }] : []
    );
  }, [displayOutput]);

  // Issue #842: distinguish "loading (attaching)" / "not-started" / "ended" so an
  // empty terminal does not ambiguously read as a dead session. We only show the
  // "session ended" placeholder once a session that was actually active becomes
  // inactive with no output — never during initial attach or for a never-started
  // pane (which would otherwise read as a spurious "ended" state).
  const [hasBeenActive, setHasBeenActive] = useState(false);
  useEffect(() => {
    if (attaching) {
      // A fresh attach (mount or worktree/CLI switch) resets the lifecycle.
      setHasBeenActive(false);
    } else if (isActive) {
      setHasBeenActive(true);
    }
  }, [attaching, isActive]);

  const isEmptyOutput = !output;
  const showLoadingPlaceholder = isEmptyOutput && attaching;
  const showEndedPlaceholder =
    isEmptyOutput && !attaching && !isActive && hasBeenActive;

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
    if (needsScrollToTopRef.current && disableAutoFollow && displayOutput) {
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
    // Issue #1172: keyed on displayOutput (not raw output) so a raw-only frame
    // change that compacts to an identical display does not re-trigger scroll.
  }, [renderedChunks, displayOutput, autoScroll, disableAutoFollow, scrollRef]);

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
        // Active state — Issue #1079: the flashy full-perimeter accent border is
        // gone (focus is now expressed subtly on the pane card). The `active`
        // marker class is kept for behavior/tests.
        isActive ? 'active' : '',
        // Custom classes
        className,
      ]
        .filter(Boolean)
        .join(' '),
    [isActive, className]
  );

  // Issue #1079: the scroll FAB stays subtle while idle and reveals to full
  // opacity on scroll activity (then fades back) and on hover/focus, so it never
  // competes with the terminal output but is always reachable.
  const [scrollActive, setScrollActive] = useState(false);
  const scrollActivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealScrollButton = useCallback(() => {
    setScrollActive(true);
    if (scrollActivityTimerRef.current) clearTimeout(scrollActivityTimerRef.current);
    scrollActivityTimerRef.current = setTimeout(() => setScrollActive(false), 1500);
  }, []);
  useEffect(
    () => () => {
      if (scrollActivityTimerRef.current) clearTimeout(scrollActivityTimerRef.current);
    },
    []
  );
  const handleScrollWithReveal = useCallback(() => {
    handleScroll();
    revealScrollButton();
  }, [handleScroll, revealScrollButton]);

  const scrollFabClass = [
    'absolute bottom-4 right-4 flex items-center justify-center h-9 w-9 rounded-full',
    'bg-surface/80 backdrop-blur border border-border text-muted-foreground shadow-lg',
    'transition-opacity hover:text-surface-foreground hover:opacity-100 focus-visible:opacity-100',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    // Idle stays muted (auto-fade intent) but discoverable; reveals on scroll/hover.
    scrollActive ? 'opacity-100' : 'opacity-60',
  ].join(' ');

  return (
    <div className="relative h-full flex flex-col">
      {/* [Issue #47] Terminal search bar overlay */}
      {isSearchOpen && (
        <div className="absolute top-2 right-2 z-10">
          <TerminalSearchBar
            query={searchQuery}
            onQueryChange={setSearchQuery}
            matchCount={matchCount}
            currentIndex={searchCurrentIndex}
            onNext={nextMatch}
            onPrev={prevMatch}
            onClose={closeSearch}
            isAtMaxMatches={isAtMaxMatches}
          />
        </div>
      )}

      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-label="Terminal output"
        className={containerClasses}
        onScroll={handleScrollWithReveal}
        onKeyDown={handleKeyDown}
        tabIndex={0}
      >
        {/* Terminal output with sanitized HTML. Issue #1120: rendered as keyed
            append-only chunks so text selection survives streaming updates. */}
        <div className="whitespace-pre-wrap break-words">
          {renderedChunks.map((chunk) => (
            <span key={chunk.key} dangerouslySetInnerHTML={{ __html: chunk.html }} />
          ))}
        </div>

        {/* Issue #842: empty-state placeholders clarify loading vs. ended. */}
        {showLoadingPlaceholder && (
          <div
            data-testid="terminal-loading-placeholder"
            className="flex h-full items-center justify-center px-4 text-center text-sm text-gray-500 select-none"
          >
            読込中...
          </div>
        )}
        {showEndedPlaceholder && (
          <div
            data-testid="terminal-ended-placeholder"
            className="flex h-full items-center justify-center px-4 text-center text-sm text-gray-500 select-none"
          >
            セッションは終了しました（メッセージ送信で再開できます）
          </div>
        )}

        {/* Thinking indicator */}
        {isActive && isThinking && <ThinkingIndicator />}
      </div>

      {/* Issue #1079: icon-only circular scroll FAB. Shows an up arrow at the
          bottom (jump to top) or a down arrow when scrolled up (jump to bottom). */}
      {autoScroll ? (
        <button
          type="button"
          onClick={scrollToTop}
          className={scrollFabClass}
          aria-label="Scroll to top"
        >
          <ArrowUp size={16} aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          onClick={scrollToBottom}
          className={scrollFabClass}
          aria-label="Scroll to bottom"
        >
          <ArrowDown size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
});

export default TerminalDisplay;
