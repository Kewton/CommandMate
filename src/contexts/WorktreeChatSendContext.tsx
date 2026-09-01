'use client';

/**
 * WorktreeChatSendContext (Issue #2213)
 *
 * One screen-scoped seam that lets the worktree detail screen's docked composer
 * hand a send to whichever chat surface is currently on screen.
 *
 * ## Why this exists
 *
 * `usePendingMessages` (#1121) needs the send function and the transcript array
 * to have a common owner: it inserts the optimistic bubble into the same array
 * the server echo will arrive in, and reconciles the two. On PC that owner is
 * `TerminalSplitPaneContent`, which holds both. On a phone it does not exist —
 * the transcript lives inside the terminal tab
 * (`MobileTerminalTab` → `MobileChatSurface`) while the composer is docked
 * *below* the tab content in `WorktreeDetailRefactored`, so the two are siblings
 * whose nearest common ancestor is the screen component itself.
 *
 * Lifting the transcript up to that ancestor is the one thing that must not
 * happen: `MobileChatSurface` mounts `useSplitMessages` ONLY while chat is the
 * visible surface, precisely so a terminal-mode tab does not run a history poll
 * it never renders. So the ownership stays where the messages are and the *send*
 * travels the other way — the surface registers its `sendOptimistic`, and the
 * composer picks it up.
 *
 * ## What this is not
 *
 * - **Not a second send path.** The registered function is `usePendingMessages`'
 *   `sendOptimistic`, which still calls `worktreeApi.sendMessage` →
 *   `POST /api/worktrees/:id/send`. Nothing here talks to the network.
 * - **Not a global send bus.** The provider wraps one worktree detail screen.
 *   Without a provider every hook here degrades to "no registration", which is
 *   exactly the pre-#2213 behavior (the composer awaits the API itself), so PC —
 *   which wires `onOptimisticSend` directly and never renders this provider — is
 *   untouched.
 * - **Not a store.** The registration is a single slot. Only one chat surface is
 *   mounted per screen at a time (the phone shows one tab, one instance).
 *
 * ## Two contexts, on purpose
 *
 * The actions ({@link WorktreeChatSendActions}) are stable for the life of the
 * provider, so the chat surface — which only ever *writes* — subscribes to them
 * and is never re-rendered by a registration change. The registration itself
 * lives in a separate context that only the composer reads.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { OptimisticSendOptions } from '@/hooks/usePendingMessages';
import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * The agent this surface's transcript is showing.
 *
 * Compared against the composer's own target before the registration is used, so
 * a registration left over from the previous instance for one render cannot put
 * a bubble in a transcript that is no longer the one being sent to. `instanceId`
 * defaults to `cliToolId` on both sides (the primary instance is named by the
 * tool id — the same rule `useSplitMessages` and `/send` apply).
 */
export interface ChatSendTarget {
  cliToolId: CLIToolType;
  instanceId?: string;
}

/** `usePendingMessages`' `sendOptimistic`, exactly. */
export type ChatOptimisticSendFn = (
  content: string,
  options: OptimisticSendOptions,
) => void;

export interface ChatSendRegistration {
  target: ChatSendTarget;
  send: ChatOptimisticSendFn;
}

/** The write half — stable for the life of the provider. */
export interface WorktreeChatSendActions {
  /** Claim (or, with `null`, release) the screen's single registration slot. */
  register: (registration: ChatSendRegistration | null) => void;
  /**
   * Put text back into the composer. Used when a failed optimistic send is
   * discarded, so the message is returned to the user for editing rather than
   * dropped — the same recovery PC gets from `onHistoryInsertToMessage`.
   */
  insertToComposer: (content: string) => void;
}

const NOOP_ACTIONS: WorktreeChatSendActions = {
  register: () => {},
  insertToComposer: () => {},
};

const ActionsContext = createContext<WorktreeChatSendActions>(NOOP_ACTIONS);
const RegistrationContext = createContext<ChatSendRegistration | null>(null);

/** Resolve a target to the instance id `/send` and `useSplitMessages` use. */
function resolveInstanceId(target: ChatSendTarget): string {
  return target.instanceId ?? target.cliToolId;
}

export interface WorktreeChatSendProviderProps {
  /** Screen-level "insert this text into the composer" (draft restore). */
  onInsertToComposer?: (content: string) => void;
  children: ReactNode;
}

/**
 * Owns the screen's registration slot.
 *
 * `children` is a prop, so a registration change re-renders this component but
 * not the subtree it was handed — only the two contexts' consumers.
 */
export function WorktreeChatSendProvider({
  onInsertToComposer,
  children,
}: WorktreeChatSendProviderProps) {
  const [registration, setRegistration] = useState<ChatSendRegistration | null>(null);

  // Mirrored so `insertToComposer` stays referentially stable even when the
  // screen hands down a fresh callback.
  const insertRef = useRef(onInsertToComposer);
  insertRef.current = onInsertToComposer;

  const insertToComposer = useCallback((content: string) => {
    insertRef.current?.(content);
  }, []);

  const actions = useMemo<WorktreeChatSendActions>(
    () => ({ register: setRegistration, insertToComposer }),
    [insertToComposer],
  );

  return (
    <ActionsContext.Provider value={actions}>
      <RegistrationContext.Provider value={registration}>
        {children}
      </RegistrationContext.Provider>
    </ActionsContext.Provider>
  );
}

/**
 * Publish this surface's optimistic send for the screen's composer to use.
 *
 * Registers on mount and releases on unmount, so switching the phone's output
 * surface back to the terminal (which unmounts the chat surface, and with it
 * `useSplitMessages`) also puts the composer back on its await-then-clear path.
 * Cleanup runs before the re-registration when the target changes, so the slot
 * is never left holding a stale entry.
 */
export function useRegisterChatOptimisticSend({
  cliToolId,
  instanceId,
  send,
}: {
  cliToolId: CLIToolType;
  instanceId?: string;
  send: ChatOptimisticSendFn;
}): void {
  const { register } = useContext(ActionsContext);
  useEffect(() => {
    register({ target: { cliToolId, instanceId }, send });
    return () => register(null);
  }, [register, cliToolId, instanceId, send]);
}

/**
 * The optimistic send for `target`, or `undefined` when no chat surface is
 * showing that agent's transcript.
 *
 * `undefined` is the meaningful value: `MessageInput` treats a missing
 * `onOptimisticSend` as "await the API and then clear", which is what the phone
 * did before #2213 and what it still does in terminal mode.
 */
export function useChatOptimisticSend(
  target: ChatSendTarget,
): ChatOptimisticSendFn | undefined {
  const registration = useContext(RegistrationContext);
  if (registration === null) return undefined;
  if (registration.target.cliToolId !== target.cliToolId) return undefined;
  if (resolveInstanceId(registration.target) !== resolveInstanceId(target)) return undefined;
  return registration.send;
}

/** The screen's "insert into the composer" callback (draft restore on discard). */
export function useChatComposerInsert(): (content: string) => void {
  return useContext(ActionsContext).insertToComposer;
}
