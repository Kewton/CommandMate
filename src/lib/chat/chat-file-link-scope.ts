'use client';

/**
 * The worktree detail screen's file-link scope (Issue #2345).
 *
 * ## What it carries, and why a context carries it
 *
 * Two facts the chat surface and History both need and neither can derive:
 *
 *  - `worktreePath` — `Worktree.path`, the absolute root this worktree lives at.
 *    Without it, an absolute path in a reply cannot be recognized as being
 *    INSIDE the worktree, and #2345's whole defect is that such a path is
 *    requested as `files//Users/…` and 404s (see {@link normalizeChatFilePath}).
 *  - `openFile` — the screen's own "open this in the file panel". On a phone the
 *    transcript lives inside `MobileTerminalTab` while the panel is
 *    `WorktreeDetailRefactored`'s `mobileFileViewerPath`; the tab had
 *    `onFilePathClick: () => {}` hard-coded, so tapping a path did nothing.
 *
 * The nearest common ancestor of every consumer is the screen component, and the
 * components in between (`TerminalSplitPaneContent` on PC, `MobileContent` on
 * the phone) build their child props as one frozen object each — the same
 * ownership problem `WorktreeChatSendContext` solves for the composer's send,
 * solved the same way rather than by widening four prop lists on the way down.
 *
 * ## Not a store, and not the only way in
 *
 * One screen, one value. Every consumer takes an explicit prop FIRST and reads
 * this only as the fallback, so a caller that knows the path (the phone's
 * `MobileTerminalTab` → `ChatSurface` → `ChatTranscript` chain) still states it
 * outright, and a test can mount `ChatTranscript` with a `worktreePath` prop and
 * no provider at all. With neither, the value is `{}` and behaviour is exactly
 * what it was before this Issue.
 *
 * Exported as `Context.Provider` rather than as a wrapper component so this
 * module needs no JSX and stays a plain `.ts` beside the rest of `lib/chat` —
 * the same shape `ChatMessageBubble` uses for `ChatToolActivityProvider`.
 *
 * @module lib/chat/chat-file-link-scope
 */

import { createContext, useContext } from 'react';

export interface ChatFileLinkScope {
  /** `Worktree.path` — the absolute root of the worktree being shown. */
  worktreePath?: string;
  /**
   * Open a worktree-relative path in the screen's file panel.
   *
   * Undefined means "this screen has no panel to open" — consumers must treat
   * that as "do nothing", not as a reason to navigate.
   */
  openFile?: (path: string) => void;
}

/** No provider: no path, no panel. Frozen so the default identity is stable. */
const EMPTY_SCOPE: ChatFileLinkScope = Object.freeze({});

const ChatFileLinkContext = createContext<ChatFileLinkScope>(EMPTY_SCOPE);

/** Publishes the screen's scope. Memoize the value — consumers compare by identity. */
export const ChatFileLinkProvider = ChatFileLinkContext.Provider;

/** The screen's scope, or `{}` when this subtree has no provider above it. */
export function useChatFileLinkScope(): ChatFileLinkScope {
  return useContext(ChatFileLinkContext);
}
