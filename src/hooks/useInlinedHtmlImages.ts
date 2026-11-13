'use client';

/**
 * useInlinedHtmlImages — inlines relative `<img src>` of an HTML preview as
 * data URIs (Issue #2861).
 *
 * `srcDoc` documents have the base URL `about:srcdoc`, so relative image paths
 * never load. This hook fetches them through the worktree file API (the same
 * way `WorktreeImage` in MarkdownPreview does) and returns HTML whose relative
 * image sources are replaced by data URIs, keeping the iframe sandbox as-is.
 */

import { useEffect, useMemo, useState } from 'react';
import { collectRelativeImageSources, replaceImageSources } from '@/lib/html-preview/relative-images';
import { encodePathForUrl } from '@/lib/url-path-encoder';
import { useHandoffPageOwner } from '@/hooks/useHandoffPageOwner';
import { fetchForHandoffPage, type HandoffPageOwner } from '@/lib/handoff/page-owner';

/** Maximum number of images inlined per HTML document. */
export const MAX_INLINED_HTML_IMAGES = 50;
/** Maximum total length (characters) of the inlined data URIs per HTML document. */
export const MAX_INLINED_HTML_IMAGE_CHARS = 20_000_000;

async function fetchImageDataUri(owner: HandoffPageOwner, worktreeId: string, resolvedPath: string): Promise<string | null> {
  try {
    // Issue #4345 1c 再指示 1: the image read's 401 reaches the gateway before it is folded into null.
    const res = await fetchForHandoffPage(owner, `/api/worktrees/${worktreeId}/files/${encodePathForUrl(resolvedPath)}`);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object') return null;
    const { isImage, content } = data as { isImage?: unknown; content?: unknown };
    if (isImage !== true || typeof content !== 'string' || !content.startsWith('data:')) return null;
    return content;
  } catch {
    return null;
  }
}

interface InlinedResult {
  worktreeId: string;
  filePath: string;
  htmlContent: string;
  html: string;
}

/**
 * htmlContent の相対パスの画像をファイル API で取得し、データ URI に置き換えた HTML を返す。
 * 取得が終わるまで（と、相対パスの画像が無いとき）は htmlContent をそのまま返す。
 */
export function useInlinedHtmlImages(
  worktreeId: string,
  filePath: string,
  htmlContent: string,
): string {
  const [result, setResult] = useState<InlinedResult | null>(null);
  // Issue #4345 1c 再指示 1: the worktree page's registration holder (none outside a worktree page).
  const handoffOwner = useHandoffPageOwner();

  const sources = useMemo(
    () => collectRelativeImageSources(htmlContent, filePath).slice(0, MAX_INLINED_HTML_IMAGES),
    [htmlContent, filePath],
  );

  useEffect(() => {
    if (sources.length === 0) return;
    let cancelled = false;
    Promise.all(sources.map(({ resolvedPath }) => fetchImageDataUri(handoffOwner, worktreeId, resolvedPath)))
      .then((dataUris) => {
        if (cancelled) return;
        const replacements = new Map<string, string>();
        let totalChars = 0;
        dataUris.forEach((dataUri, i) => {
          if (dataUri === null) return;
          if (totalChars + dataUri.length > MAX_INLINED_HTML_IMAGE_CHARS) return;
          totalChars += dataUri.length;
          replacements.set(sources[i].src, dataUri);
        });
        setResult({
          worktreeId,
          filePath,
          htmlContent,
          html: replaceImageSources(htmlContent, replacements),
        });
      })
      .catch(() => { /* silently ignore */ });
    return () => { cancelled = true; };
  }, [worktreeId, filePath, htmlContent, sources, handoffOwner]);

  if (
    result
    && result.worktreeId === worktreeId
    && result.filePath === filePath
    && result.htmlContent === htmlContent
  ) {
    return result.html;
  }
  return htmlContent;
}
