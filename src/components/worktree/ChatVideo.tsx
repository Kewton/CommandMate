'use client';

/**
 * One video in a chat body (Issue #3121).
 *
 * `![](clip.mp4)` and `[label](clip.mp4)` that resolve to a video inside this
 * worktree are drawn as `<video controls preload="none">` streamed from the
 * files API's `?raw=1` mode, with the label kept underneath as the ordinary
 * file link (pressing it opens the file panel, as before). `preload="none"`
 * means nothing is requested until the reader presses play. A video that fails
 * to load falls back to the link alone.
 *
 * Everything else — a path outside the worktree, an external URL, no worktree
 * scope — is not a video here: the caller keeps drawing it as a link / image.
 *
 * Every element is a `span` / `video` / `a`, because react-markdown puts these
 * inside a `<p>` and a `<div>` there is invalid HTML.
 *
 * @module components/worktree/ChatVideo
 */

import React, { memo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChatFileLink } from '@/components/worktree/ChatMessageBubble';
import { useChatImageScope } from '@/lib/chat/chat-image';
import { chatVideoRawUrl, resolveChatVideoPath } from '@/lib/chat/chat-video';

/** The tallest a chat video is drawn; it is always as wide as the column. */
export const CHAT_VIDEO_MAX_HEIGHT_PX = 360;

export const CHAT_VIDEO_TESTID = 'chat-video';

/**
 * Draws `target` as an embedded video when it is one in this worktree, and
 * `fallback` otherwise.
 */
export const ChatVideo = memo(function ChatVideo({
  target,
  label,
  fallback,
  onFilePathClick,
}: {
  /** The image `src` / link `href` as written. */
  target: string | undefined;
  /** What the link under the video shows. */
  label: React.ReactNode;
  /** Drawn when `target` is not an in-worktree video. */
  fallback: React.ReactNode;
  onFilePathClick: (path: string) => void;
}) {
  const t = useTranslations('worktree');
  const { worktreeId, worktreePath } = useChatImageScope();
  const [failed, setFailed] = useState(false);
  const path = resolveChatVideoPath(target, worktreePath);

  if (!path || !worktreeId || !target) return <>{fallback}</>;

  const href = target.trim();
  const link = (
    <ChatFileLink href={href} onFilePathClick={onFilePathClick}>
      {label}
    </ChatFileLink>
  );
  if (failed) return link;

  return (
    <span className="my-1 block w-full">
      <video
        key={path}
        data-testid={CHAT_VIDEO_TESTID}
        controls
        preload="none"
        src={chatVideoRawUrl(worktreeId, path)}
        aria-label={t('conversation.videoLabel', { path })}
        onError={() => setFailed(true)}
        className="block w-full rounded-md border border-border bg-black"
        style={{ maxHeight: CHAT_VIDEO_MAX_HEIGHT_PX }}
      />
      <span className="mt-1 block break-all text-xs">{link}</span>
    </span>
  );
});
