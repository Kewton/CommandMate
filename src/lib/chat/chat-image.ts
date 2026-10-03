'use client';

/**
 * Where an image in a chat body comes from, and whether it may be loaded
 * (Issue #3120).
 *
 * ## The defect this exists for
 *
 * `![図](docs/a.png)` in a reply rendered as `<img src="docs/a.png">`, which the
 * browser resolved against the SCREEN's URL (`/worktrees/<id>/…`); an absolute
 * `/Users/…/a.png` — the shape codex writes — was requested from
 * `localhost:3000/Users/…`; and an `https://` image is blocked by the CSP
 * (`img-src 'self' data: blob:`). None of the three ever displayed.
 *
 * The fix routes every in-worktree image through the files API (the same one
 * `MarkdownPreview` uses), and draws everything else as its alt text plus a link
 * without loading it. The CSP is deliberately NOT loosened: an external image is
 * never fetched.
 *
 * Like `chat-file-path`, this is no security decision — the files API's own path
 * / magic-byte / SVG checks are. This only decides what the renderer ASKS for.
 *
 * @module lib/chat/chat-image
 */

import { createContext, useContext } from 'react';
import { isImageExtension } from '@/config/image-extensions';
import { classifyChatLink, normalizeChatFilePath } from '@/lib/chat/chat-file-path';
import { encodePathForUrl } from '@/lib/url-path-encoder';

// ============================================================================
// Classification
// ============================================================================

/**
 * What one image source in a chat body turns into.
 *
 * - `worktree` — a worktree-relative path with an image extension: load it
 *   through the files API.
 * - `external` — an `http(s)://` (or other external) URL: link to it, never load.
 * - `file` — a path the file panel may still be asked about (outside this
 *   worktree, or not an image): link to it, never load.
 * - `none` — nothing usable (empty, `javascript:`, an unknown scheme): alt text.
 */
export type ChatImageSource =
  | { kind: 'worktree'; path: string }
  | { kind: 'external'; href: string }
  | { kind: 'file'; href: string }
  | { kind: 'none' };

/** The extension of the last path segment, or `''`. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

/**
 * Classify an image source from a chat body.
 *
 * @param src - the image destination as the renderer received it
 * @param worktreePath - `Worktree.path`; without it an absolute path cannot be
 *   recognized as inside the worktree and is never loaded
 */
export function resolveChatImageSource(
  src: string | undefined | null,
  worktreePath?: string | null,
): ChatImageSource {
  if (typeof src !== 'string' || !src.trim()) return { kind: 'none' };
  const target = classifyChatLink(src);
  if (target === 'external') return { kind: 'external', href: src.trim() };
  if (target !== 'file') return { kind: 'none' };

  const path = normalizeChatFilePath(src, worktreePath);
  if (path === null) return { kind: 'none' };
  // An absolute result is a path OUTSIDE this worktree (see
  // `normalizeChatFilePath`): the files API only serves relative paths.
  if (!path.startsWith('/') && isImageExtension(extensionOf(path))) {
    return { kind: 'worktree', path };
  }
  return { kind: 'file', href: src.trim() };
}

/** The files API URL a worktree-relative image is fetched from. */
export function chatImageApiUrl(worktreeId: string, path: string): string {
  return `/api/worktrees/${worktreeId}/files/${encodePathForUrl(path)}`;
}

// ============================================================================
// User attachments
// ============================================================================

/** Where the composer's attachments are uploaded to (Issue #474). */
export const CHAT_ATTACHMENT_DIR = '.commandmate/attachments/';

/** One piece of a user message: text as typed, or an attached image. */
export type ChatUserBodyPart =
  | { type: 'text'; content: string }
  | { type: 'image'; src: string; alt: string; path: string };

/** `![alt](destination)` — the shape `sendMessageWithImage` appends. */
const IMAGE_MARKDOWN_REGEX = /!\[([^\]\n]*)\]\(([^()\s]+)\)/g;

/**
 * Split a user message into text and attachment images.
 *
 * Only an `![…](…)` whose destination resolves into {@link CHAT_ATTACHMENT_DIR}
 * becomes an image. Every other `![…](…)` stays text: a user message is not
 * Markdown, and what the user typed by hand is not reinterpreted.
 */
export function splitChatUserBody(
  content: string,
  worktreePath?: string | null,
): ChatUserBodyPart[] {
  const parts: ChatUserBodyPart[] = [];
  let last = 0;
  for (const match of content.matchAll(IMAGE_MARKDOWN_REGEX)) {
    const [whole, alt, src] = match;
    const source = resolveChatImageSource(src, worktreePath);
    if (source.kind !== 'worktree' || !source.path.startsWith(CHAT_ATTACHMENT_DIR)) continue;
    const index = match.index ?? 0;
    if (index > last) parts.push({ type: 'text', content: content.slice(last, index) });
    parts.push({ type: 'image', src, alt, path: source.path });
    last = index + whole.length;
  }
  if (last < content.length) parts.push({ type: 'text', content: content.slice(last) });
  return parts;
}

// ============================================================================
// Scope
// ============================================================================

/**
 * What a chat image needs and the renderer cannot derive: which worktree's
 * files API to ask, and that worktree's root. Published by `ChatTranscript`.
 * No provider means no `worktreeId`, and then no image is ever fetched.
 */
export interface ChatImageScope {
  worktreeId?: string;
  worktreePath?: string;
}

const EMPTY_SCOPE: ChatImageScope = Object.freeze({});

const ChatImageScopeContext = createContext<ChatImageScope>(EMPTY_SCOPE);

/** Publishes the scope. Memoize the value — consumers compare by identity. */
export const ChatImageScopeProvider = ChatImageScopeContext.Provider;

/** The scope, or `{}` with no provider above. */
export function useChatImageScope(): ChatImageScope {
  return useContext(ChatImageScopeContext);
}
