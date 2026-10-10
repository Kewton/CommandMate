'use client';

/**
 * One image in a chat body (Issue #3120).
 *
 * An in-worktree image is loaded through the files API by the shared
 * {@link WorktreeImage}, lazily (only once it scrolls into view), inside a frame
 * that keeps its height while loading. It is drawn shrunk to the column's width
 * and at most {@link CHAT_IMAGE_MAX_HEIGHT_PX} tall, and pressing it opens the
 * file panel through the surface's own `onFilePathClick`.
 *
 * Everything else — a path outside the worktree, an external URL, an unknown
 * scheme — and an in-worktree image that failed to load are drawn as the alt
 * text plus a link, and nothing is fetched. External images are never loaded:
 * the CSP (`img-src 'self' data: blob:`) is not loosened for the chat.
 *
 * Every element is a `span` / `a` / `button`, because react-markdown puts an
 * image inside a `<p>` and a `<div>` there is invalid HTML.
 *
 * @module components/worktree/ChatImage
 */

import React, { memo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ImageIcon } from 'lucide-react';
import { WorktreeImage } from '@/components/common/WorktreeImage';
import { ChatFileLink } from '@/components/worktree/ChatMessageBubble';
import {
  chatImageApiUrl,
  resolveChatImageSource,
  useChatImageScope,
} from '@/lib/chat/chat-image';

/** The tallest a chat image is drawn; wider-than-tall images shrink to the column. */
export const CHAT_IMAGE_MAX_HEIGHT_PX = 320;

export const CHAT_IMAGE_TESTID = 'chat-image';
export const CHAT_IMAGE_LOADING_TESTID = 'chat-image-loading';
export const CHAT_IMAGE_FALLBACK_TESTID = 'chat-image-fallback';

/** Alt text and a link (or bare text), in place of an image that is not loaded. */
function ChatImageFallback({
  src,
  alt,
  kind,
  onFilePathClick,
  searchRaw,
}: {
  src: string;
  alt: string;
  kind: 'external' | 'file' | 'none';
  onFilePathClick: (path: string) => void;
  searchRaw?: Record<string, string>;
}) {
  const t = useTranslations('worktree');
  const label = alt || t('conversation.imageUnavailable');
  let link: React.ReactNode = null;
  if (kind === 'external') {
    link = (
      <a href={src} target="_blank" rel="noopener noreferrer" className="break-all underline">
        {src}
      </a>
    );
  } else if (kind === 'file') {
    link = (
      <ChatFileLink href={src} onFilePathClick={onFilePathClick}>
        {src}
      </ChatFileLink>
    );
  } else if (src) {
    link = <span className="break-all font-mono text-xs">{src}</span>;
  }
  return (
    <span
      {...searchRaw}
      data-testid={CHAT_IMAGE_FALLBACK_TESTID}
      className="inline-flex max-w-full flex-wrap items-center gap-1 align-middle text-muted-foreground"
    >
      <ImageIcon size={14} aria-hidden="true" className="shrink-0" />
      <span>{label}</span>
      {link}
    </span>
  );
}

export const ChatImage = memo(function ChatImage({
  src,
  alt,
  onFilePathClick,
  searchRaw,
}: {
  src: string | undefined;
  alt: string | undefined;
  onFilePathClick: (path: string) => void;
  /**
   * [Issue #3523] The `<img>`'s search mark (`searchRawProps`), put on what is
   * drawn instead. An image has no text of its own in the message, so search
   * leaves the alt text / link / loading text drawn here out, and the paragraph
   * around it still adds up.
   */
  searchRaw?: Record<string, string>;
}) {
  const t = useTranslations('worktree');
  const { worktreeId, worktreePath } = useChatImageScope();
  const source = resolveChatImageSource(src, worktreePath);
  const altText = alt ?? '';
  const rawSrc = src?.trim() ?? '';

  // The surface's handler normalizes and probes the path itself, so it is handed
  // the destination exactly as written — the same contract as `ChatFileLink`.
  const handleOpen = useCallback(() => onFilePathClick(rawSrc), [onFilePathClick, rawSrc]);

  if (source.kind !== 'worktree' || !worktreeId) {
    const kind = source.kind === 'worktree' ? 'file' : source.kind;
    return (
      <ChatImageFallback src={rawSrc} alt={altText} kind={kind} onFilePathClick={onFilePathClick} searchRaw={searchRaw} />
    );
  }

  return (
    <WorktreeImage
      key={source.path}
      apiUrl={chatImageApiUrl(worktreeId, source.path)}
      alt={altText}
      lazy
      loadingFallback={
        <span
          {...searchRaw}
          data-testid={CHAT_IMAGE_LOADING_TESTID}
          className="flex h-40 w-full max-w-sm items-center justify-center rounded-md border border-border bg-muted text-xs text-muted-foreground"
        >
          {t('conversation.imageLoading')}
        </span>
      }
      errorFallback={
        <ChatImageFallback src={rawSrc} alt={altText} kind="file" onFilePathClick={onFilePathClick} searchRaw={searchRaw} />
      }
      className="block h-auto max-w-full rounded-md border border-border object-contain"
      style={{ maxHeight: CHAT_IMAGE_MAX_HEIGHT_PX }}
      wrap={(img) => (
        <button
          type="button"
          data-testid={CHAT_IMAGE_TESTID}
          onClick={handleOpen}
          className="block max-w-full cursor-pointer"
          aria-label={t('conversation.openImage', { path: source.path })}
        >
          {img}
        </button>
      )}
    />
  );
});
