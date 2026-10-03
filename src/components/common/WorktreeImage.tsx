/**
 * WorktreeImage Component
 * Issue #3120: Extracted from MarkdownPreview.tsx so the chat surface can share it
 *
 * Fetches an image from the worktree file API and displays it as a data URI.
 * The file API returns JSON with a Base64 data URI in the `content` field (the
 * path, magic-byte and SVG checks all happen server-side).
 *
 * The defaults are MarkdownPreview's pre-#3120 behaviour, unchanged: fetch on
 * mount, a gray "loading" text until the data URI arrives, and no separate
 * failure state. The optional props are what the chat surface needs on top:
 *
 * - `lazy` — fetch only once the placeholder scrolls into view
 *   (`IntersectionObserver`), so a transcript full of images does not request
 *   all of them at once. Without `IntersectionObserver` it loads immediately.
 * - `loadingFallback` / `errorFallback` — what to draw instead of the default
 *   text. `errorFallback` omitted keeps the pre-#3120 "still loading" text.
 * - `className` / `style` / `wrap` — how the loaded `<img>` is drawn.
 *
 * @module components/common/WorktreeImage
 */

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

export interface WorktreeImageProps {
  /** `/api/worktrees/<id>/files/<encoded path>` */
  apiUrl: string;
  alt: string;
  width?: string;
  height?: string;
  /** Fetch only once the placeholder is in the viewport. */
  lazy?: boolean;
  /** Drawn until the data URI arrives. Defaults to the gray loading text. */
  loadingFallback?: React.ReactNode;
  /** Drawn when the fetch or the image fails. Defaults to `loadingFallback`. */
  errorFallback?: React.ReactNode;
  /** Classes for the `<img>`. */
  className?: string;
  /** Style for the `<img>`. Defaults to `maxWidth: width || '100%'`. */
  style?: React.CSSProperties;
  /** Wraps the loaded `<img>` (e.g. in a button). Not applied to the fallbacks. */
  wrap?: (img: React.ReactElement) => React.ReactNode;
}

type LoadState = 'idle' | 'loaded' | 'error';

export function WorktreeImage({
  apiUrl,
  alt,
  width,
  height,
  lazy = false,
  loadingFallback,
  errorFallback,
  className,
  style,
  wrap,
}: WorktreeImageProps) {
  const t = useTranslations('worktree');
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>('idle');
  const [inView, setInView] = useState(!lazy);
  const placeholderRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (inView) return;
    const element = placeholderRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setInView(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [inView]);

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    setDataUri(null);
    setState('idle');
    fetch(apiUrl)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (typeof data?.content === 'string' && data.content) {
          setDataUri(data.content);
          setState('loaded');
        } else {
          setState('error');
        }
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => { cancelled = true; };
  }, [apiUrl, inView]);

  const loading = loadingFallback ?? (
    <span style={{ color: '#999' }}>{t('markdownPreview.loadingImage')}</span>
  );

  if (state === 'error') return <>{errorFallback ?? loading}</>;
  if (!dataUri) {
    return lazy ? <span ref={placeholderRef}>{loading}</span> : loading;
  }
  const img = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={dataUri}
      alt={alt}
      width={width}
      height={height}
      className={className}
      style={style ?? { maxWidth: width || '100%' }}
      onError={errorFallback !== undefined ? () => setState('error') : undefined}
    />
  );
  return wrap ? <>{wrap(img)}</> : img;
}

export default WorktreeImage;
