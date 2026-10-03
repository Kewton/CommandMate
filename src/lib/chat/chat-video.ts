/**
 * Which chat-body references are drawn as an embedded video (Issue #3121).
 *
 * `![](clip.mp4)` and `[label](clip.mp4)` pointing at a video inside this
 * worktree become `<video>` whose `src` is the files API's `?raw=1` stream —
 * never the base64 JSON the file viewer uses, which is ~133MB of string for a
 * 100MB file. Anything outside the worktree, and any external URL, stays a
 * link. Like `chat-image`, this is no security decision: the files API's own
 * path / size / magic-byte checks run on `?raw=1` as well.
 *
 * @module lib/chat/chat-video
 */

import { isVideoExtension } from '@/config/video-extensions';
import { classifyChatLink, normalizeChatFilePath } from '@/lib/chat/chat-file-path';
import { chatImageApiUrl } from '@/lib/chat/chat-image';

/** The extension of the last path segment, or `''`. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

/**
 * The worktree-relative path of a video a chat body refers to, or `null`.
 *
 * @param target - an image `src` or a link `href`, as the renderer received it
 * @param worktreePath - `Worktree.path`; without it an absolute path is never
 *   recognized as inside the worktree
 */
export function resolveChatVideoPath(
  target: string | undefined | null,
  worktreePath?: string | null,
): string | null {
  if (typeof target !== 'string' || !target.trim()) return null;
  if (classifyChatLink(target) !== 'file') return null;
  const path = normalizeChatFilePath(target, worktreePath);
  // An absolute result is a path OUTSIDE this worktree (see normalizeChatFilePath).
  if (path === null || path.startsWith('/')) return null;
  return isVideoExtension(extensionOf(path)) ? path : null;
}

/** The files API URL a worktree-relative video is streamed from. */
export function chatVideoRawUrl(worktreeId: string, path: string): string {
  return `${chatImageApiUrl(worktreeId, path)}?raw=1`;
}
