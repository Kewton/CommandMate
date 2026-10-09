/**
 * MermaidDiagram Component
 *
 * Renders mermaid diagram syntax as SVG using mermaid.js library.
 * Must be dynamically imported with ssr: false.
 *
 * @security Uses mermaid securityLevel='strict' to prevent XSS
 * @see SEC-SF-003 Security review requirement
 *
 * @module components/worktree/MermaidDiagram
 */

'use client';

import React, { useState, useEffect, useLayoutEffect, useRef, useId, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import mermaid from 'mermaid';
import {
  MERMAID_CONFIG,
  buildMermaidConfig,
  resolveMermaidTheme,
  type MermaidTheme,
} from '@/config/mermaid-config';
import { Spinner } from '@/components/ui/Spinner';

/** What a finished render attempt came to (Issue #3503). */
export type MermaidRenderState = 'rendered' | 'error';

/**
 * Props for MermaidDiagram component
 */
export interface MermaidDiagramProps {
  /** Mermaid diagram code */
  code: string;
  /** Optional unique ID for the diagram */
  id?: string;
  /**
   * [Issue #3503] Called after every finished render attempt — the first one,
   * and each redraw on a code or theme change.
   */
  onRenderStateChange?: (state: MermaidRenderState) => void;
}

/**
 * The theme mermaid was last initialized with, or `null` before the first
 * initialization. Read and written only inside {@link enqueueMermaidTask}.
 */
let initializedTheme: MermaidTheme | null = null;

/**
 * The single queue every `initialize` + `render` pair runs through (Issue #3503).
 *
 * mermaid's config is global: `initialize` for one theme followed by another
 * diagram's `initialize` for a different theme, before the first `render` has
 * read the config, would draw the first diagram in the wrong colours. One
 * queue, and a re-`initialize` only when the theme actually changes, means a
 * theme switch redraws every diagram — in order — with the new theme.
 *
 * Each entry holds the queue until it settles OR its owner cancels it (the
 * diagram unmounted, or its code / theme changed). A render that never settles
 * therefore cannot stall every later diagram on the page once nobody is waiting
 * for it, and a cancelled entry that has not started yet is skipped.
 */
let mermaidQueue: Promise<void> = Promise.resolve();

/** Rejection of a queued render whose owner cancelled it before it started. */
class MermaidTaskCancelled extends Error {}

interface MermaidTicket<T> {
  promise: Promise<T>;
  cancel: () => void;
}

function enqueueMermaidTask<T>(task: () => Promise<T>): MermaidTicket<T> {
  const previous = mermaidQueue;
  let cancelled = false;
  let release!: () => void;
  const own = new Promise<void>((resolve) => {
    release = resolve;
  });
  mermaidQueue = previous.then(() => own);
  const promise = previous.then(async () => {
    if (cancelled) throw new MermaidTaskCancelled();
    try {
      return await task();
    } finally {
      release();
    }
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      release();
    },
  };
}

/**
 * Initialize mermaid with validation
 *
 * [SEC-SF-003] Validates that securityLevel is 'strict' before initialization.
 * This is a fail-safe mechanism to prevent accidental security misconfiguration.
 *
 * [Issue #3503] Re-initializes when the theme differs from the last one.
 *
 * @throws Error if securityLevel is not 'strict'
 */
function initializeMermaidWithValidation(theme: MermaidTheme): void {
  // Security validation: securityLevel must be 'strict'
  if (MERMAID_CONFIG.securityLevel !== 'strict') {
    throw new Error(
      `[SECURITY] mermaid securityLevel must be 'strict', but got '${MERMAID_CONFIG.securityLevel}'. ` +
        'This is a security requirement to prevent XSS attacks.'
    );
  }

  if (initializedTheme === theme) return;
  mermaid.initialize(buildMermaidConfig(theme));
  initializedTheme = theme;
}

/**
 * Render one diagram through the queue. A failed render must not leave the
 * temporary element mermaid adds to `document.body` behind; `suppressErrorRendering`
 * makes mermaid remove it, and this removes it again in case a mermaid version
 * stops doing so.
 */
function renderMermaidSerialized(
  renderId: string,
  code: string,
  theme: MermaidTheme,
): MermaidTicket<{ svg: string }> {
  return enqueueMermaidTask(async () => {
    initializeMermaidWithValidation(theme);
    try {
      return await mermaid.render(renderId, code);
    } catch (err) {
      const leftover = document.getElementById(`d${renderId}`);
      if (leftover && leftover.parentElement === document.body) leftover.remove();
      throw err;
    }
  });
}

/** Attributes that point at an element by id. */
const ID_REFERENCE_ATTRS = ['href', 'xlink:href', 'aria-labelledby', 'aria-describedby'] as const;

/**
 * [Issue #3503] Give every element id inside a drawn SVG its diagram's prefix.
 *
 * mermaid prefixes the SVG and its markers with the render id, but not node and
 * edge ids (`flowchart-A-0`, `L_A_B_0`): two diagrams with the same source —
 * a chat answer repeated, or the same diagram in chat and History — would put
 * duplicate ids on one page. Renamed in place on the inserted DOM (no
 * re-serialization of the sanitized markup), with every `url(#…)` / `#…`
 * reference to a renamed id rewritten to match.
 */
function scopeDiagramIds(root: Element): void {
  const svg = root.querySelector('svg');
  const prefix = svg?.id;
  if (!svg || !prefix) return;
  const renamed = new Map<string, string>();
  svg.querySelectorAll('[id]').forEach((el) => {
    if (el.id.startsWith(prefix)) return;
    const next = `${prefix}-${el.id}`;
    renamed.set(el.id, next);
    el.id = next;
  });
  if (renamed.size === 0) return;
  const rewriteUrl = (value: string) =>
    value.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (match, quote: string, id: string) => {
      const next = renamed.get(id);
      return next ? `url(${quote}#${next}${quote})` : match;
    });
  svg.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.value.includes('url(')) {
        const next = rewriteUrl(attr.value);
        if (next !== attr.value) el.setAttribute(attr.name, next);
      } else if ((ID_REFERENCE_ATTRS as readonly string[]).includes(attr.name)) {
        const next = attr.value
          .split(/\s+/)
          .map((token) => {
            const hash = token.startsWith('#');
            const id = hash ? token.slice(1) : token;
            const target = renamed.get(id);
            return target ? `${hash ? '#' : ''}${target}` : token;
          })
          .join(' ');
        if (next !== attr.value) el.setAttribute(attr.name, next);
      }
    }
  });
}

function subscribeToHtmlClass(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

function readHtmlTheme(): string {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * [Issue #3503] The mermaid theme for the app's current theme.
 *
 * `resolvedTheme` from next-themes when it has one. When it does not (no
 * provider above, as in isolated renders), the `dark` class next-themes puts on
 * `<html>` (`attribute="class"`) — which its blocking script sets before first
 * paint, so it is already decided by the time this client-only component mounts.
 */
function useMermaidTheme(): MermaidTheme | null {
  const { resolvedTheme } = useTheme();
  const htmlTheme = useSyncExternalStore(subscribeToHtmlClass, readHtmlTheme, () => '');
  return resolveMermaidTheme(resolvedTheme) ?? resolveMermaidTheme(htmlTheme);
}

/**
 * MermaidDiagram Component
 *
 * Renders mermaid diagram code as an SVG.
 *
 * @example
 * ```tsx
 * <MermaidDiagram
 *   code="graph TD\nA[Start] --> B[End]"
 *   id="my-diagram"
 * />
 * ```
 */
export function MermaidDiagram({
  code,
  id: providedId,
  onRenderStateChange,
}: MermaidDiagramProps): React.JSX.Element {
  const t = useTranslations('worktree');
  const theme = useMermaidTheme();
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // [Issue #1275] `t` is a fresh closure on every render, so listing it in the
  // render effect's deps would re-run mermaid.render on every render. Read it
  // via a ref to keep the effect keyed on `code`/`diagramId` alone.
  const tRef = useRef(t);
  tRef.current = t;
  const onRenderStateChangeRef = useRef(onRenderStateChange);
  onRenderStateChangeRef.current = onRenderStateChange;

  // Generate unique ID if not provided. useId is unique per mounted diagram, so
  // two diagrams with the same source never share an id (Issue #3503); the
  // characters outside [A-Za-z0-9_-] are replaced because mermaid uses the id
  // as a CSS selector.
  const reactId = useId();
  const diagramId = providedId || `mermaid-${reactId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  // Each redraw gets its own id: mermaid deletes any element carrying the id it
  // is about to render with, which would otherwise be the SVG on screen.
  const renderCountRef = useRef(0);

  useEffect(() => {
    let isMounted = true;
    let ticket: MermaidTicket<{ svg: string }> | null = null;

    const renderDiagram = async () => {
      // Reset state. The previous SVG (if any) stays up while a redraw runs, so
      // a theme switch does not collapse the diagram to a spinner and back.
      setIsLoading(true);
      setError(null);

      // Validate input
      const trimmedCode = code?.trim() || '';
      if (!trimmedCode) {
        if (isMounted) {
          setSvg('');
          setError(tRef.current('mermaid.emptyCode'));
          setIsLoading(false);
          onRenderStateChangeRef.current?.('error');
        }
        return;
      }

      // [Issue #3503] Do not draw before the theme is known.
      if (theme === null) return;

      const count = renderCountRef.current++;
      const renderId = count === 0 ? diagramId : `${diagramId}-r${count}`;

      try {
        // Initialize mermaid (security-validated) and render, serialized
        ticket = renderMermaidSerialized(renderId, trimmedCode, theme);
        const { svg: renderedSvg } = await ticket.promise;

        if (isMounted) {
          setSvg(renderedSvg);
          setIsLoading(false);
          onRenderStateChangeRef.current?.('rendered');
        }
      } catch (err) {
        if (isMounted && !(err instanceof MermaidTaskCancelled)) {
          const message =
            err instanceof Error ? err.message : tRef.current('mermaid.renderError');
          setSvg('');
          setError(message);
          setIsLoading(false);
          onRenderStateChangeRef.current?.('error');
        }
      }
    };

    renderDiagram();

    return () => {
      isMounted = false;
      ticket?.cancel();
    };
  }, [code, diagramId, theme]);

  useLayoutEffect(() => {
    if (svg && containerRef.current) scopeDiagramIds(containerRef.current);
  }, [svg]);

  // Loading state
  if (isLoading && !svg) {
    return (
      <div
        data-testid="mermaid-loading"
        className="flex items-center justify-center p-4 text-muted-foreground"
      >
        <div className="flex items-center gap-2">
          <Spinner size="sm" variant="accent" />
          <span>{t('mermaid.rendering')}</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div
        data-testid="mermaid-error"
        className="bg-danger-subtle border border-danger-border p-4 rounded"
      >
        <p className="text-danger font-medium">{t('mermaid.errorTitle')}</p>
        <pre className="text-sm text-danger mt-2 whitespace-pre-wrap break-words bg-danger-subtle">
          {error}
        </pre>
      </div>
    );
  }

  // Success: render SVG
  return (
    <div
      ref={containerRef}
      data-testid="mermaid-container"
      data-mermaid-theme={theme ?? undefined}
      className="mermaid-container max-w-full overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
