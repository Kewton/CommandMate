/**
 * MessageInput Component
 * Input form for sending messages to Claude
 */

'use client';

import React, { memo, useState, useCallback, FormEvent, useRef, useEffect, useLayoutEffect } from 'react';
import { useTranslations } from 'next-intl';
import { handleApiError, isBriefBoundaryChanged, type SendBriefChoice } from '@/lib/api-client';
import { readSendRoleRefusal, sendRoleRefusalMessageKey } from '@/components/worktree/role-refusal-notice';
import {
  SEND_TARGET_CHANGED_KEYS,
  describeSendTarget,
  readSendTargetChanged,
  sendTargetChangedReasonKey,
  type SendTargetChangedRefusal,
} from '@/components/worktree/send-refusal-notice';
import { fetchStartPreview, isCommandBody, START_PREVIEW_TIMEOUT_MS } from '@/lib/handoff/screen-client';
import {
  beginHandoffPageOperation,
  isHandoffPageOperationRefused,
  sendMessageForHandoffPage,
  uploadImageFileForHandoffPage,
} from '@/lib/handoff/page-owner';
import { useHandoffPageOwner } from '@/hooks/useHandoffPageOwner';
import type { StartPreviewResponse } from '@/lib/handoff/preview';
import { SessionStartBriefDialog, type StartBriefChoice } from '@/components/mem/SessionStartBriefDialog';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { ChatMessage } from '@/types/models';
import { Button, Spinner } from '@/components/ui';
import { SlashCommandSelector } from './SlashCommandSelector';
import { InterruptButton } from './InterruptButton';
import { OpencodeSessionControls } from './OpencodeSessionControls';
import { PaneResizer } from './PaneResizer';
import { ComposerSendButton } from './message-input/ComposerSendButton';
import { ComposerMetaRow } from './message-input/ComposerMetaRow';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useImageAttachment } from '@/hooks/useImageAttachment';
import { isSendOutcomeUnknown } from '@/hooks/usePendingMessages';
import { useComposerHeight } from '@/hooks/useComposerHeight';
import {
  COMPOSER_AUTO_MAX_HEIGHT_PX,
  COMPOSER_MIN_HEIGHT_PX,
} from '@/config/composer-height';
import type { SlashCommand } from '@/types/slash-commands';
import { getSlashCommandTrigger } from '@/lib/slash-command-format';
import type { ShowToast } from '@/types/markdown-editor';
import { AntigravityUsageNotice } from '@/components/worktree/antigravity-usage-notice';
import { useAntigravityUsageNotice } from '@/hooks/useAntigravityUsageNotice';
import { useToast } from '@/components/common/Toast';
import {
  DRAFT_STORAGE_KEY_PREFIX,
  getInstanceDraftKey,
  getSplitDraftKey,
  subscribeDraftAppend,
  decideRetarget,
  getRetargetTagKey,
  mergeRetargetTags,
  newRetargetTag,
  readRetargetStore,
  readRetargetTags,
  readRetargetUnstorable,
  releaseRetargetTags,
  retargetYesCovers,
  subscribeRetargetedText,
  writeRetarget,
  type DraftScope,
  type RetargetOp,
  type RetargetTag,
  type RetargetTarget,
  type RetargetWriteResult,
} from '@/lib/drafts/message-draft';

export interface MessageInputProps {
  worktreeId: string;
  /**
   * Fired after a send resolves.
   *
   * Issue #2213: the second argument is the row `/send` created, forwarded from
   * `worktreeApi.sendMessage` so a caller without an optimistic history can adopt
   * it instead of waiting for the echo. It is `undefined` on the
   * {@link onOptimisticSend} path, where the API call is fired in the background
   * and the row is reconciled into the transcript by `usePendingMessages`. Every
   * pre-#2213 caller takes one parameter and is unaffected.
   */
  onMessageSent?: (cliToolId: CLIToolType, sentMessage?: ChatMessage) => void;
  cliToolId?: CLIToolType;
  /**
   * Issue #869: agent instance id to send to. Defaults to the primary instance
   * (`=== cliToolId`) when omitted, preserving pre-#869 single-session behavior.
   */
  instanceId?: string;
  isSessionRunning?: boolean;
  /**
   * Issue #3179: the agent is still launching. The stop (interrupt) button stays
   * disabled and the permission-mode control is not drawn: there is no turn to
   * interrupt and no mode footer to cycle yet, and a red stop button on a
   * launch read as "something is running that you should stop". Sending stays
   * as {@link isSessionRunning} has it.
   */
  isSessionStarting?: boolean;
  /** Issue #485: Text to insert into message input from history or memo */
  pendingInsertText?: string | null;
  /** Issue #485: Callback to signal that pendingInsertText has been consumed */
  onInsertConsumed?: () => void;
  /**
   * Issue #728: split index used to scope the draft localStorage key.
   * Defaults to 0 for backward compatibility (mobile / single-terminal usage).
   */
  splitIndex?: number;
  /**
   * Issue #4419: which draft this composer keeps. `'split'` (default) is the worktree screen's
   * per-(worktree, split) draft (#728). `'instance'` is the `/sessions` tile's: one draft per
   * (worktree, instance), so switching the instance shows that instance's draft and text typed
   * for one instance never shows in another's composer.
   */
  draftScope?: DraftScope;
  /**
   * Issue #728: invoked when the textarea gains focus.
   * TerminalSplitContainer wires this to setFocusedSplitIndex so HistoryPane /
   * MemoPane insertions land in the most recently focused split.
   */
  onFocus?: () => void;
  /**
   * Issue #806: whether the target session is currently busy (processing
   * another task). When true, a successful send is queued behind the running
   * task on the CLI side rather than executed immediately, so we surface a
   * "queued (session busy)" toast to avoid the send looking like a no-op.
   * Defaults to false (idle) for backward compatibility — idle sends behave
   * exactly as before (no extra toast).
   */
  isProcessing?: boolean;
  /**
   * Issue #806: toast surface used to show the "queued (session busy)" hint.
   * Optional — when omitted (or when the session is idle) no toast is shown.
   */
  showToast?: ShowToast;
  /**
   * Issue #1080: content rendered in the composer's bottom meta row (left side),
   * typically the per-instance Auto-Yes toggle. Sits alongside the keyboard-hint
   * pills so Auto-Yes no longer occupies its own full-width row.
   */
  autoYesSlot?: React.ReactNode;
  /**
   * Issue #1121: optimistic-send hook. When provided, the composer delegates the
   * actual send to this callback (which inserts a pending bubble into the history
   * and fires the API in the background) instead of awaiting the send API itself.
   * The composer clears immediately (optimistic); send failures surface on the
   * pending bubble, not the composer's error banner. Omitted by callers without
   * an optimistic-UI history (mobile / assistant chat), which keep the legacy
   * await-then-clear behavior.
   */
  onOptimisticSend?: (
    content: string,
    options: { cliToolId: CLIToolType; instanceId?: string; imagePath?: string },
  ) => void;
  /**
   * Issue #2592: the agent's permission-mode control, rendered in the existing
   * action row beside `InterruptButton` / `OpencodeSessionControls`.
   *
   * A slot rather than a prop bundle, for the reason {@link autoYesSlot} is one:
   * the control needs this pane's frame-derived mode and its four dialog flags,
   * and every one of those already lives in the caller (`useTerminalPanePolling`).
   * Plumbing six more props through the composer to hand them straight back to a
   * child would put the composer in the business of knowing what a permission
   * mode is.
   *
   * **No row of its own, on either layout.** It joins the row that exists,
   * because vertical space in the pane is already spoken for (#2106 / #2131) and
   * every pixel a control takes comes out of `TerminalDisplay`. Callers without
   * one (the sessions screen) pass nothing and nothing is drawn.
   */
  agentModeSlot?: React.ReactNode;
  /**
   * Issue #2797: the direct-input toggle (#2766), drawn in the toolbar's END
   * group, immediately before the interrupt button.
   *
   * Not the meta row, and not the toolbar's start group, because both give way
   * in a narrow pane: the meta row's Auto-Yes half and the start group scroll
   * sideways, and whatever sits after the first item is what scrolls out of
   * sight. The end group never shrinks and never scrolls — it is the one place
   * in the composer that is on screen at every width, which is what the last
   * way into a pane needs. Beside the interrupt button, too, because both act
   * on the pane rather than send a message. Callers without one pass nothing
   * and nothing is drawn.
   */
  directInputSlot?: React.ReactNode;
  /**
   * Issue #2598: where this composer's textarea height is stored
   * (`split:<n>` / `session-tile`, see `src/config/composer-height.ts`).
   *
   * Given, and on a PC, the composer draws a handle on its top edge: drag it up
   * (or press ↑ on it) for a taller textarea, double-click it to return to
   * auto-grow. Omitted — the phone's docked composer — nothing changes: no
   * handle, nothing read, the auto-grow the composer has always had.
   */
  heightScope?: string;
  /**
   * Issue #2598: the tallest the textarea may be DRAWN, in px — the caller's
   * answer to "how much can the body above give up" (`useComposerMaxHeight`).
   * It bounds the drawing only; a stored height above it is kept and comes back
   * when the bound rises. `null` / omitted: not measured yet, no bound.
   */
  maxHeight?: number | null;
  /**
   * Issue #3999: the target instance's CURRENT frame is Command Code's plan
   * review — the caller's `isPlanReviewUp()` over the same pane state its
   * plan-review controls are drawn from (never another instance's poll).
   *
   * While it is set nothing is sent: the server would refuse the message
   * (`not-sent / plan-review`), and on the optimistic path the draft would
   * already be gone with only a failed pending row to show for it. So the send
   * stops at {@link submitMessage}'s door — the button and a PC's Enter both
   * go through it — keeping the draft and creating no pending row, and the
   * composer says why and links to the controls. Cleared, the same draft
   * sends as usual.
   */
  planReviewActive?: boolean;
  /**
   * Issue #4606: the awaited road's answer from the send fence (409 `SEND_TARGET_CHANGED` `not_sent`
   * naming its original target) — the `/sessions` tile holds that target until its roster is read
   * again. Callers without one (the worktree screen: its To follows at once) pass nothing.
   */
  onSendTargetChanged?: (refusal: SendTargetChangedRefusal) => void;
  /**
   * Issue #4606: while set, nothing is sent from this composer (Enter, [send], the brief's choice) and
   * the sentence is shown above it; the draft stays. The tile sets it while its To is a target the
   * fence just said changed, until its roster is read again.
   */
  sendBlockedReason?: string | null;
  /**
   * Issue #4606 r4 (INV-P2): whether the tile holds this To now — read by the composer's one gate at the
   * moment a POST leaves (from the tile's own record, never a render's copy: a hold that came after the
   * last render stops the send too). Callers without a hold (the worktree screen) pass nothing.
   */
  isSendHeld?: (to: { instanceId: string; cliToolId: string }) => boolean;
  /**
   * Issue #4606 r4 (P1-6): the previous draft's waiting save, written at a switch (instance scope) —
   * its key and whether it went in. The tile moves a draft only once its latest text is stored.
   */
  onPreviousDraftSaved?: (key: string, written: boolean) => void;
}

/**
 * Message input component
 *
 * @example
 * ```tsx
 * <MessageInput worktreeId="main" onMessageSent={handleRefresh} cliToolId="claude" />
 * ```
 */
/**
 * Issue #4227 G-PR3 (G-3): how stale the cached start preview may be before a focus reads it
 * again in the background. G-PR6: the cache is never what decides a send — every plain send
 * reads the preview afresh first (bounded by `START_PREVIEW_TIMEOUT_MS`), so this throttle
 * applies to the focus read only.
 */
const START_PREVIEW_REFRESH_MS = 10_000;

/** Issue #4607: the question before a send when the draft's stored tags cannot be read (`{current}`). */
const RETARGET_CONFIRM_UNREADABLE_KEY = 'conversation.sendTargetChanged.retargetConfirmUnreadable';
/** Issue #4604: the toast when not even the "unknown" of a draft's tags could be stored. */
const RETARGET_UNSTORED_KEY = 'conversation.sendTargetChanged.retargetUnstored';
/**
 * Issue #4604 accept r1 (F2): the toast when the tags could not be written as a list and only the short
 * "unknown" went in — every composer, this tab's and another's, asks before sending it.
 */
const RETARGET_PARTIALLY_STORED_KEY = 'conversation.sendTargetChanged.retargetPartiallyStored';
/** Issue #4604: the toast when the previous draft's waiting save could not be written at a switch. */
const PREVIOUS_DRAFT_NOT_SAVED_KEY = 'composer.previousDraftNotSaved';
/** Issue #4604: the notice when the draft could not be read (the composer is left empty). */
const DRAFT_UNREADABLE_KEY = 'composer.draftUnreadable';

/**
 * Issue #4604: a send's check passed — the generations of "unknown" its question saw (the yes covers
 * only those; null when it was not asked). `null` itself: the check asked (nothing is sent).
 */
type RetargetPass = { seen: string[] | null } | null;

/**
 * Issue #4604: a one-send yes to a draft whose tags are not known — its To and what its question saw.
 * r3 (P1-1): the ids of the marks too — a text handed back after the question, into the same
 * generation, is not covered (the list's `confirmation` holds its ids the same way).
 */
interface RetargetUnknownYes {
  target: string;
  seen: string[];
  ids: string[];
}

/** The preview read, cut at `ms` (a read that does not settle in time is a read that failed). */
function withinPreviewLimit<T>(read: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    read.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

type ShownStartPreview = Extract<StartPreviewResponse, { show: true }>;

/**
 * Issue #806: shown when a message is successfully sent to a session that is
 * already busy with another task. The send itself succeeds (200) and the CLI
 * queues the message, so this clarifies it will not be processed until the
 * current task finishes.
 */
const QUEUED_BUSY_TOAST_MESSAGE =
  'Queued (session busy) — your message will run after the current task finishes.';

/**
 * Issue #3999: bring the plan-review controls of this instance into view and
 * give them focus. Found by the marker `PlanReviewControls` publishes
 * (`data-plan-review-target`); the first one that is laid out wins, because a
 * hidden tab may keep a second mount in the DOM.
 */
function revealPlanReviewControls(target: string): void {
  if (typeof document === 'undefined') return;
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('[data-plan-review-target]'),
  ).filter((el) => el.dataset.planReviewTarget === target);
  const el = candidates.find((candidate) => candidate.getClientRects().length > 0) ?? candidates[0];
  if (!el) return;
  el.scrollIntoView?.({ block: 'nearest' });
  el.focus({ preventScroll: true });
}

/** `useLayoutEffect` warns on the server; see `useIsMobile` for the same pattern. */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Issue #2598: the handle's `aria-valuenow` — where the drawn height sits
 * between the floor and the caller's bound, as the percentage `PaneResizer`
 * reports. Auto-grow and an unmeasured bound report the floor's 0.
 */
function composerHeightPercent(height: number | null, maxHeight: number | null | undefined): number {
  if (height === null || maxHeight === null || maxHeight === undefined) return 0;
  const span = maxHeight - COMPOSER_MIN_HEIGHT_PX;
  if (span <= 0) return 100;
  return Math.round(Math.min(100, Math.max(0, ((height - COMPOSER_MIN_HEIGHT_PX) / span) * 100)));
}

/**
 * Issue #728: Best-effort migration of the legacy draft key.
 * If `commandmate:draft-message:${worktreeId}` exists and the new
 * `${...}:0` key is empty, copy the value over and delete the legacy entry.
 * Safe to call repeatedly (no-op when legacy key absent).
 */
function migrateLegacyDraftKey(worktreeId: string): void {
  try {
    const legacyKey = `${DRAFT_STORAGE_KEY_PREFIX}${worktreeId}`;
    const legacyValue = window.localStorage.getItem(legacyKey);
    if (legacyValue === null) return;
    const newKey = getSplitDraftKey(worktreeId, 0);
    if (window.localStorage.getItem(newKey) === null) {
      window.localStorage.setItem(newKey, legacyValue);
    }
    window.localStorage.removeItem(legacyKey);
  } catch {
    /* localStorage unavailable; migration is best-effort */
  }
}

/** Issue #4419: text added to a draft — the whole draft when it is empty, else after a blank line. */
function appendDraftText(draft: string, text: string): string {
  return draft.trim() === '' ? text : `${draft}\n\n${text}`;
}

/** Issue #4604: whether every tag `held` is in the store of `key` already (as a list or in its "unknown"). */
function heldTagsAreStored(key: string, held: readonly RetargetTag[]): boolean {
  const stored = readRetargetStore(key);
  if (stored.kind !== 'list' && stored.kind !== 'unknown') return false;
  const ids = new Set(stored.tags.map((tag) => tag.id));
  return held.every((tag) => ids.has(tag.id));
}

/**
 * Write a draft (an empty one removes the key). Best effort — `localStorage` may be unavailable.
 * Issue #4604: returns whether it was written (a switch says so when the previous draft was not).
 */
function writeDraft(key: string, message: string): boolean {
  try {
    if (message) {
      window.localStorage.setItem(key, message);
    } else {
      window.localStorage.removeItem(key);
    }
    return true;
  } catch {
    /* localStorage unavailable */
    return false;
  }
}

/**
 * Issue #4503 (review P2-5): an awaited send of this draft whose outcome is unknown — its text and the
 * target it went to. Kept beside the draft (the same storage, the draft's key with a suffix), so it
 * lives as long as the draft does: a remount, a switch of the target or the tile's instance, a reload
 * that brings the draft back, bring the question back with it.
 */
interface SendUnknownMark {
  text: string;
  target: string;
}

function sendUnknownMarkKey(draftKey: string): string {
  return `${draftKey}:send-unknown`;
}

function readSendUnknownMark(draftKey: string): SendUnknownMark | null {
  try {
    const raw = window.localStorage.getItem(sendUnknownMarkKey(draftKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SendUnknownMark> | null;
    return parsed && typeof parsed.text === 'string' && typeof parsed.target === 'string'
      ? { text: parsed.text, target: parsed.target }
      : null;
  } catch {
    return null;
  }
}

function writeSendUnknownMark(draftKey: string, mark: SendUnknownMark | null): void {
  try {
    if (mark) {
      window.localStorage.setItem(sendUnknownMarkKey(draftKey), JSON.stringify(mark));
    } else {
      window.localStorage.removeItem(sendUnknownMarkKey(draftKey));
    }
  } catch { /* localStorage unavailable */ }
}

export const MessageInput = memo(function MessageInput({ worktreeId, onMessageSent, cliToolId, instanceId, isSessionRunning = false, isSessionStarting = false, pendingInsertText, onInsertConsumed, splitIndex = 0, draftScope = 'split', onFocus, isProcessing = false, showToast, autoYesSlot, agentModeSlot, directInputSlot, onOptimisticSend, heightScope, maxHeight, planReviewActive = false, onSendTargetChanged, sendBlockedReason = null, isSendHeld, onPreviousDraftSaved }: MessageInputProps) {
  const t = useTranslations('worktree');
  const tc = useTranslations('common');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [showCommandSelector, setShowCommandSelector] = useState(false);
  const [isFreeInputMode, setIsFreeInputMode] = useState(false);
  // Issue #3999: a send was stopped by the plan review; the notice says so
  // louder (`role="alert"`) until the review is over.
  const [planReviewStopped, setPlanReviewStopped] = useState(false);
  useEffect(() => {
    if (!planReviewActive) setPlanReviewStopped(false);
  }, [planReviewActive]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const compositionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const justFinishedComposingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Issue #4419: the save the debounce has not written yet, written when the draft's key changes
  // (the tile switched instance) so the last keystrokes stay with the instance they were typed for.
  const pendingDraftSaveRef = useRef<{ key: string; message: string } | null>(null);
  const draftKey =
    draftScope === 'instance'
      ? getInstanceDraftKey(worktreeId, instanceId || cliToolId || 'claude')
      : getSplitDraftKey(worktreeId, splitIndex);
  // Issue #4419: the draft on screen now — an awaited send checks it after the wait, so a send's
  // success never clears the draft of an instance the tile switched to meanwhile.
  const draftKeyRef = useRef(draftKey);
  // Issue #4604 (設計書 §3.4.1, W-1): the text and the key of the draft it is — one state, so a render
  // never pairs one draft's text with another's key (between the commit of a key change and the
  // restore, the text is still the previous draft's: it is not this render's, it is not shown, it is
  // not sent). `message` is this render's draft text.
  const [draft, setDraft] = useState<{ key: string; text: string }>(() => ({ key: draftKey, text: '' }));
  const message = draft.key === draftKey ? draft.text : '';
  /** Set this render's draft text (a function gets the text now, '' while the draft is another's). */
  const setMessage = useCallback(
    (next: string | ((prev: string) => string)) =>
      setDraft((prev) => {
        const base = prev.key === draftKey ? prev.text : '';
        return { key: draftKey, text: typeof next === 'function' ? next(base) : next };
      }),
    [draftKey],
  );
  // Issue #4604: the key the restore read last (a re-run of it for the same key adds nothing typed).
  const restoredKeyRef = useRef<string | null>(null);
  const [draftUnreadableKey, setDraftUnreadableKey] = useState<string | null>(null);
  // Issue #4604: the composer's toasts about its store — the caller's surface, else the app's.
  const { showToast: appToast } = useToast();
  const notify = showToast ?? appToast;
  // Issue #4604 accept r1 (F2): `shortUnknown` — only the short "unknown" went in (its own sentence).
  const notifyRetargetWrite = useCallback((result: RetargetWriteResult, shortUnknown = false) => {
    if (result === 'unstored') notify(t(RETARGET_UNSTORED_KEY), 'warning');
    else if (shortUnknown) notify(t(RETARGET_PARTIALLY_STORED_KEY), 'warning');
  }, [notify, t]);
  // Issue #4604 accept r1 (F2): for the handed-back text's listener (its subscription stays on `draftKey`).
  const notifyRetargetWriteRef = useRef(notifyRetargetWrite);
  notifyRetargetWriteRef.current = notifyRetargetWrite;
  /** Issue #4604 accept r1 (F2): a write through the one road, told as {@link notifyRetargetWrite} says. */
  const writeRetargetTold = useCallback((key: string, op: RetargetOp) => {
    let shortUnknown = false;
    const onShortUnknown = () => {
      shortUnknown = true;
    };
    const result = writeRetarget(key, op, { onShortUnknown });
    notifyRetargetWrite(result, shortUnknown);
  }, [notifyRetargetWrite]);

  // Hooks for slash command functionality
  // Issue #4: Pass cliToolId to filter commands by CLI tool
  const isMobile = useIsMobile();
  const { groups, isCatalogStale } = useSlashCommands(worktreeId, cliToolId);

  // Issue #4438 再指示 1 (I6'): an antigravity instance added elsewhere (CLI, another device)
  // is launched by the first send from here, never passing the add form. The same notice and
  // the same per-browser record as the add form, while the session is not running — and it
  // stays up once that send launches it, until closed. Guidance only: the send is not stopped.
  const usageNotice = useAntigravityUsageNotice();
  const [usageNoticeArmed, setUsageNoticeArmed] = useState(false);
  const usageNoticeBeforeLaunch = cliToolId === 'antigravity' && !isSessionRunning;
  if (usageNoticeBeforeLaunch && !usageNoticeArmed) setUsageNoticeArmed(true);
  const showUsageNotice =
    usageNotice.shouldShow(cliToolId ?? '') && (usageNoticeBeforeLaunch || usageNoticeArmed);

  // Issue #2598: the stored textarea height and its handle — PC only. On a
  // phone nothing is read or applied, so a height chosen on a desktop never
  // reaches the phone's docked composer.
  const resizable = !isMobile && !!heightScope;
  const {
    height: heightFloor,
    resizeBy: resizeHeightBy,
    reset: resetHeight,
  } = useComposerHeight({ worktreeId, scope: heightScope, maxHeight, enabled: resizable });
  const cssBound = typeof maxHeight === 'number' && Number.isFinite(maxHeight) ? maxHeight : Infinity;
  const handleHeightResize = useCallback(
    (delta: number) => {
      const drawn = textareaRef.current?.getBoundingClientRect().height ?? COMPOSER_MIN_HEIGHT_PX;
      // PaneResizer reports downward movement as positive. The handle is on the
      // composer's TOP edge and the composer is docked at the bottom, so pulling
      // it up — a negative delta — is what makes the textarea taller.
      resizeHeightBy(-delta, drawn);
    },
    [resizeHeightBy],
  );

  // Issue #1166: the composer no longer lifts itself with a translateY hack.
  // The mobile shell (WorktreeDetailRefactored) now sizes its container to
  // visualViewport.height and places this composer in normal flow at the bottom,
  // so it docks above the software keyboard without any transform. This keeps
  // the composer a plain in-flow element on every surface (mobile / PC / chat).

  // Issue #4345 1c: the worktree page's registration holder (none outside a worktree page: the
  // sessions view's composer reports nothing and calls the API exactly as before).
  const handoffOwner = useHandoffPageOwner();

  // Issue #474: Image attachment hook
  const uploadFn = useCallback(
    (wId: string, file: File) => {
      // Issue #4345 1c: the upload's 401 reaches the gateway before it becomes an Error (再指示 2: an
      // operation of the page — not sent once a 401 was taken).
      return uploadImageFileForHandoffPage(handoffOwner, wId, file);
    },
    [handoffOwner]
  );
  const {
    attachedImage,
    fileInputRef,
    isUploading,
    error: imageError,
    acceptAttribute,
    openFileDialog,
    handleFileSelect,
    removeAttachment,
    resetAfterSend,
  } = useImageAttachment(worktreeId, uploadFn);

  // Issue #4227 G-PR3 (G-3, design §3): the start preview of this composer's instance.
  // G-PR6 (design §3.2): a plain send reads it afresh and waits (at most
  // START_PREVIEW_TIMEOUT_MS) before anything is sent; the background read (focus, after a send)
  // only warms the cache and never decides a send.
  //
  // One generation rule for every read (background, before a send, after a 409): each read takes
  // a number; its result is adopted into the cache only when it is newer than the adopted one, the
  // composer is still mounted and still on the same worktree/instance. A send attempt has its own
  // number: a target change, an unmount or a newer attempt makes the older one's answer void.
  const briefInstance = instanceId || cliToolId || 'claude';
  const previewKey = `${worktreeId}\u0000${briefInstance}`;
  const startPreviewRef = useRef<{ key: string; at: number; value: StartPreviewResponse | null } | null>(null);
  const previewSeqRef = useRef(0);
  const previewAdoptedSeqRef = useRef(0);
  const previewKeyRef = useRef(previewKey);
  // Issue #4607 r3 (INV-V2c''): the To a send goes to — the instance and the tool. `previewKey` has no
  // tool when there is an instance (the roster read again can change the same instance's tool); a yes
  // to sending a handed-back text is for this key only.
  // Issue #4607 r4 (INV-V2c'''): the checks compare this render's key — the same render the POST's
  // options are built from — never a copy a passive effect writes later (a press between the commit
  // of a To change and its passive effects saw the old To there and sent to the new one).
  const sendTargetKey = `${worktreeId}\u0000${instanceId || cliToolId || 'claude'}\u0000${cliToolId || 'claude'}`;
  const mountedRef = useRef(true);
  const sendAttemptRef = useRef(0);
  const briefCheckingRef = useRef(false);
  const messageRef = useRef('');
  const [briefChecking, setBriefChecking] = useState(false);
  const [briefCheckFailed, setBriefCheckFailed] = useState(false);
  const [briefAsk, setBriefAsk] = useState<{ preview: ShownStartPreview; notice: string | null } | null>(null);
  const [briefSending, setBriefSending] = useState(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sendAttemptRef.current += 1;
    };
  }, []);
  // Issue #4503: an awaited send (the plain one without an optimistic history, or the brief choice)
  // whose outcome is unknown. The draft stays (if it really did not arrive, the text is not lost); the
  // next send of that same text to that same target asks first. Editing it makes it another send.
  // The mark is stored with the draft (`SendUnknownMark`); `unknownMark` is the one of the draft on
  // screen. `resendConfirmed`: the person said to send it again (this mount only — a reload asks again).
  const [unknownMark, setUnknownMark] = useState<SendUnknownMark | null>(null);
  const [confirmingResend, setConfirmingResend] = useState(false);
  const [resendConfirmed, setResendConfirmed] = useState(false);
  const resendConfirmedRef = useRef(false);
  const setResendConfirmedBoth = useCallback((value: boolean) => {
    resendConfirmedRef.current = value;
    setResendConfirmed(value);
  }, []);
  // Issue #4535 (段 2 §3.2, S2-Q5 (b)): this composer holds a text the send fence handed back, and its
  // To is not the target it was going to — the question before it is sent here (`retargetAsk`), and
  // the person's yes for this To and these tags (`retargetConfirmedRef`, this mount only).
  // Issue #4607: `original` null — the draft's stored tags could not be read (no target to name);
  // `confirmation` null — the yes is for one send only (`retargetUnreadableYesRef`).
  // Issue #4607 r3: `target` — the To asked about (`sendTargetKey`); the one-send yes holds that To.
  // Issue #4604 (案 A'): `seen` — the generations of "unknown" the question saw; its yes covers those.
  const [retargetAsk, setRetargetAsk] = useState<{
    original: RetargetTarget | null;
    current: RetargetTarget;
    confirmation: string | null;
    target: string;
    seen: string[];
    ids: string[];
  } | null>(null);
  const retargetConfirmedRef = useRef<string | null>(null);
  const retargetUnreadableYesRef = useRef<RetargetUnknownYes | null>(null);
  // Issue #4535 r7 (INV-V2a〜V2c, 設計書 §3.4.1): the tags of the texts the fence handed back into this
  // composer's draft (`key`). Held here — the state is what decides — and next to the draft
  // (`<draftKey>:retarget`), so they move with it (a reload, the tile's instance switch). Only this
  // composer's own send lets them go; another composer, another tab, time or count never does.
  const retargetTagsRef = useRef<{ key: string; tags: RetargetTag[] }>({ key: '', tags: [] });
  // Issue #4604 r3 (P1-2, the extension of `retargetTagsRef` the PM allowed): the "unknown" generation
  // this composer restored its draft's text under — held as its tags are, so another tab's send that let
  // it go from the store does not let this composer send the text unasked (written back on `storage`).
  const retargetUnknownRef = useRef<{ key: string; generation: string } | null>(null);
  const heldUnknownOf = useCallback((key: string): string | null => {
    const held = retargetUnknownRef.current;
    return held !== null && held.key === key ? held.generation : null;
  }, []);
  // Issue #4535 r5 (review H1・P3-6): why the fence answered `unknown` on the awaited road — shown
  // with the unknown notice of that draft.
  const [unknownReason, setUnknownReason] = useState<{ key: string; text: string; reason: string } | null>(null);
  useEffect(() => {
    previewKeyRef.current = previewKey;
    return () => {
      // Issue #4503: the mark stays with the draft; a question or a confirmation was for this target.
      setConfirmingResend(false);
      setResendConfirmedBoth(false);
      // The target changes (or the composer goes): a send waiting on the old target's preview is void.
      sendAttemptRef.current += 1;
      briefCheckingRef.current = false;
      setBriefChecking(false);
      setBriefCheckFailed(false);
      // Issue #4419: the question is the old target's (its boundary id): never answered with the
      // next target's draft — the `/sessions` tile switches instances under the same composer.
      setBriefAsk(null);
    };
  }, [previewKey, setResendConfirmedBoth]);
  useEffect(() => {
    return () => {
      // Issue #4535: the yes to sending a handed-back text here was for this To — Issue #4607 r3: the
      // instance and the tool (the same instance's tool changes without `previewKey`; the brief's
      // clean-up above stays on `previewKey`). r4: a tidy-up only — each answer holds its To, and the
      // checks compare it with the render's `sendTargetKey`.
      setRetargetAsk(null);
      retargetConfirmedRef.current = null;
      retargetUnreadableYesRef.current = null;
    };
  }, [sendTargetKey]);
  useEffect(() => {
    messageRef.current = message;
  }, [message]);
  // G-PR6 (codex P2-1・P2-5): what a send waiting on its preview checks again after the wait —
  // the attached image (removed, replaced, added) and a plan review that began meanwhile.
  const attachedImagePathRef = useRef<string | null>(null);
  const planReviewActiveRef = useRef(false);
  useEffect(() => {
    attachedImagePathRef.current = attachedImage?.path ?? null;
  }, [attachedImage]);
  /**
   * Issue #4503: whether this send of `text` must wait for the person's confirmation — the same text,
   * to the same target, as the draft's send whose outcome is unknown. Asks (the confirmation row) and
   * returns true. Read from the store, so a draft brought back by a remount or a reload is held too.
   * Another text is another send: the mark goes. Another target keeps it (it is that target's).
   * The attached image is not compared: the text alone may already be in the session.
   */
  const holdsUnconfirmedResend = useCallback((text: string): boolean => {
    const key = draftKeyRef.current;
    const mark = readSendUnknownMark(key);
    if (!mark) return false;
    if (mark.text !== text) {
      writeSendUnknownMark(key, null);
      setUnknownMark(null);
      setResendConfirmedBoth(false);
      return false;
    }
    if (mark.target !== previewKeyRef.current || resendConfirmedRef.current) return false;
    setConfirmingResend(true);
    return true;
  }, [setResendConfirmedBoth]);
  /**
   * Issue #4535 r7: this composer's tags for the draft `key` (none while they are another draft's).
   * Issue #4604 (W-1): `key` is the key of the text being sent (`draft.key`), never a passive copy.
   */
  const currentRetargetTags = useCallback((key: string): RetargetTag[] => {
    const held = retargetTagsRef.current;
    return held.key === key ? held.tags : [];
  }, []);
  /**
   * Issue #4535 r7 (INV-V2c): whether this send must wait for the person's yes — this composer holds a
   * tag whose original target (instance and tool) is not its To. Asks (naming both) and returns true.
   * The draft's text is not looked at: any shape of it, any part deleted, asks the same. A yes holds
   * for this To and these tags; a new tag asks again.
   * Issue #4607 (INV-V2c'): the tags are this composer's ∪ the ones stored next to the draft (another
   * composer of the same draft, another tab), read at each send. A store that cannot be read asks
   * every time: its yes holds for that one send only (`unreadableYes`, taken by the send's entry).
   */
  // Issue #4604 (設計書 §3.4.1): the draft `key` is the key of the text sent (`draft.key`); its store is
  // read in its five shapes and this page's unstorable mark is looked at too ("unknown" asks every
  // time). Returns what the passing check saw (`RetargetPass`), or null when it asked. The one-send
  // yes holds only while every "unknown" generation and every mark's id now is one its question saw
  // (案 A', r3 P1-1: `retargetYesCovers`).
  const holdsRetargetedSend = useCallback((unreadableYes: RetargetUnknownYes | null, key: string): RetargetPass => {
    const current = { instanceId: instanceId || cliToolId || 'claude', cliToolId: cliToolId || 'claude' };
    const decision = decideRetarget(readRetargetStore(key), currentRetargetTags(key), readRetargetUnstorable(key), current, heldUnknownOf(key));
    if (!decision.ask) return { seen: null };
    if (decision.unknown) {
      if (unreadableYes && retargetYesCovers(unreadableYes, decision)) return { seen: decision.seen };
      setRetargetAsk({ original: decision.original, current, confirmation: null, target: sendTargetKey, seen: decision.seen, ids: decision.ids });
      return null;
    }
    const confirmation = `${sendTargetKey}\u0000${decision.ids.join('\u0000')}`;
    if (retargetConfirmedRef.current === confirmation) return { seen: [] };
    setRetargetAsk({ original: decision.original, current, confirmation, target: sendTargetKey, seen: [], ids: decision.ids });
    return null;
  }, [instanceId, cliToolId, currentRetargetTags, heldUnknownOf, sendTargetKey]);
  /**
   * Issue #4604＋#4606 r3c (INV-P): the composer's one gate, at the moment its POST leaves or is handed
   * to the optimistic layer — every road through it (Enter, [send], the form, the band's [yes], #4503's
   * [resend], the brief's choice, after the preview's wait). Nothing is sent while the tile holds the To;
   * the marks of the draft `key` are checked again now (one born while the preview was read asks). Its
   * answer: what the passing check saw and the ids this send lets go, or null — not sent (the draft
   * stays; a question may be up).
   * r4 (INV-P2): the hold is read when the gate is called, from the tile (`isSendHeld`) — the To is this
   * closure's, the one the POST's options are built from.
   */
  const checkGate = useCallback((key: string, unreadableYes: RetargetUnknownYes | null): { seen: string[] | null; ids: string[] } | null => {
    if (isSendHeld?.({ instanceId: instanceId || cliToolId || 'claude', cliToolId: cliToolId || 'claude' })) return null;
    const pass = holdsRetargetedSend(unreadableYes, key);
    if (pass === null) return null;
    return { seen: pass.seen, ids: currentRetargetTags(key).map((tag) => tag.id) };
  }, [isSendHeld, instanceId, cliToolId, holdsRetargetedSend, currentRetargetTags]);
  /** r3c: the composer's one `POST /send` — only through {@link checkGate}; `sent: false` when it did not go. */
  const postThroughGate = useCallback(async (
    key: string,
    unreadableYes: RetargetUnknownYes | null,
    text: string,
    options: Parameters<typeof sendMessageForHandoffPage>[3],
    operation: Parameters<typeof sendMessageForHandoffPage>[4],
  ): Promise<{ sent: false } | { sent: true; created: Awaited<ReturnType<typeof sendMessageForHandoffPage>>; gate: { seen: string[] | null; ids: string[] } }> => {
    const gate = checkGate(key, unreadableYes);
    if (gate === null) return { sent: false };
    const created = await sendMessageForHandoffPage(handoffOwner, worktreeId, text, options, operation);
    return { sent: true, created, gate };
  }, [checkGate, handoffOwner, worktreeId]);
  /**
   * Issue #4535 r7 (INV-V2b): this composer sent the draft `key` — the tags it held when it sent
   * (`ids`) go, from the store and, while it still shows that draft, from its state. Nothing else
   * lets a tag go.
   */
  // Issue #4604 (N-7・N-11): with the generations its question saw (`seen`); called with no ids too.
  const releaseSentTags = useCallback((key: string, ids: readonly string[], seen: readonly string[] | null) => {
    if (ids.length === 0 && (seen === null || seen.length === 0)) return;
    releaseRetargetTags(key, ids, seen);
    // r3 (P1-2): the held "unknown" goes with the generations this send's question saw.
    const heldUnknown = retargetUnknownRef.current;
    if (heldUnknown !== null && heldUnknown.key === key && seen !== null && seen.includes(heldUnknown.generation)) {
      retargetUnknownRef.current = null;
    }
    const held = retargetTagsRef.current;
    if (held.key === key) {
      const gone = new Set(ids);
      retargetTagsRef.current = { key, tags: held.tags.filter((tag) => !gone.has(tag.id)) };
    }
  }, []);
  /** Issue #4535 r7: a tag for this composer's draft `key` — kept in its state (if shown) and stored. */
  const keepRetargetTag = useCallback((key: string, tag: RetargetTag) => {
    const held = retargetTagsRef.current;
    if (held.key === key) retargetTagsRef.current = { key, tags: mergeRetargetTags(held.tags, [tag]) };
    // Issue #4604 (a P2-2・V2-A): through the one road — what cannot be kept as a list is kept "unknown".
    writeRetargetTold(key, { kind: 'add', tags: [tag] });
  }, [writeRetargetTold]);
  /**
   * Issue #4535 r5 (review H1, 段 2 §3.2), r7 (INV-V2a): the awaited road's answer from the send fence.
   * The text stays in the draft (it never left it); for `not_sent` with its original target named
   * (not `worktree-gone`) this composer takes a tag for it, as the optimistic road's handed-back text
   * comes with one, so a changed To asks before sending it. The state holds it for this screen even
   * when `localStorage` cannot. For anything else (`unknown`), the reason goes with the unknown notice.
   */
  const noteFenceRefusal = useCallback((err: unknown, key: string, text: string) => {
    const refusal = readSendTargetChanged(err);
    if (refusal === null) return;
    // Issue #4606: the tile holds the original target until its roster is read again.
    if (refusal.sendOutcome === 'not_sent' && refusal.target !== null) onSendTargetChanged?.(refusal);
    if (refusal.sendOutcome !== 'not_sent') {
      setUnknownReason({ key, text, reason: t(sendTargetChangedReasonKey(refusal.reason)) });
      return;
    }
    const original = refusal.target;
    if (original === null || refusal.reason === 'worktree-gone') return;
    keepRetargetTag(key, newRetargetTag({ instanceId: original.instanceId, cliToolId: original.cliToolId }));
  }, [t, keepRetargetTag, onSendTargetChanged]);
  const markSendUnknown = useCallback((key: string, text: string, target: string) => {
    const mark = { text, target };
    writeSendUnknownMark(key, mark);
    setUnknownReason(null);
    if (draftKeyRef.current === key) setUnknownMark(mark);
    setError(null);
    setConfirmingResend(false);
    setResendConfirmedBoth(false);
  }, [setResendConfirmedBoth]);
  useEffect(() => {
    planReviewActiveRef.current = !!planReviewActive;
  }, [planReviewActive]);
  /**
   * Read the preview of this composer's target now. `current` is false when the target changed or
   * the composer went away while it was read; the cache takes the value only under the rule above.
   */
  const readStartPreview = useCallback(async (): Promise<{ value: StartPreviewResponse | null; current: boolean }> => {
    const key = previewKey;
    const seq = ++previewSeqRef.current;
    // Issue #4345 1c: owned by the page's registration held now (1b made the gateway's side; this is
    // its caller's): the 401 reaches the gateway before the preview is `null`.
    const owner = handoffOwner.current;
    const value = await withinPreviewLimit(
      owner ? fetchStartPreview(worktreeId, briefInstance, owner) : fetchStartPreview(worktreeId, briefInstance),
      START_PREVIEW_TIMEOUT_MS,
    );
    const current = mountedRef.current && previewKeyRef.current === key;
    if (current && seq > previewAdoptedSeqRef.current) {
      previewAdoptedSeqRef.current = seq;
      startPreviewRef.current = { key, at: Date.now(), value };
    }
    return { value, current };
  }, [worktreeId, briefInstance, previewKey, handoffOwner]);
  const refreshStartPreview = useCallback(
    (force: boolean) => {
      const cached = startPreviewRef.current;
      if (!force && cached && cached.key === previewKey && Date.now() - cached.at < START_PREVIEW_REFRESH_MS) return;
      // Stamp the start (the focus throttle); the value stays until a newer read is adopted.
      startPreviewRef.current = { key: previewKey, at: Date.now(), value: cached?.key === previewKey ? cached.value : null };
      void readStartPreview().catch(() => undefined);
    },
    [previewKey, readStartPreview],
  );
  const handleComposerFocus = useCallback(() => {
    refreshStartPreview(false);
    onFocus?.();
  }, [refreshStartPreview, onFocus]);
  /** After a send: the boundary may be used up (or a new one opened) — warm the cache again on an attended branch only. */
  const afterSendStartPreview = useCallback(() => {
    const cached = startPreviewRef.current?.value;
    const attended = !!cached && (cached.show || cached.attended === true);
    if (attended) refreshStartPreview(true);
    else if (startPreviewRef.current) startPreviewRef.current = { ...startPreviewRef.current, value: null };
  }, [refreshStartPreview]);

  // Restore draft message from localStorage on mount or when the draft's key changes
  // ((worktreeId, splitIndex), or for the tile (worktreeId, instance) — Issue #4419).
  // Issue #728: also runs the legacy-key migration for splitIndex=0 (split scope only).
  useEffect(() => {
    draftKeyRef.current = draftKey;
    const pendingSave = pendingDraftSaveRef.current;
    pendingDraftSaveRef.current = null;
    // Issue #4535 r7: the draft's tags come with it. The ones held for the draft shown before stay
    // stored with that draft (written back, should another tab have taken them from the store).
    // Issue #4604 (INV-S1): the marks first, then the text — through the one road (an unreadable
    // store, or one that cannot take them, is left "unknown").
    const heldTags = retargetTagsRef.current;
    if (heldTags.key !== draftKey && heldTags.key !== '' && heldTags.tags.length > 0) {
      writeRetargetTold(heldTags.key, { kind: 'writeBack', tags: heldTags.tags });
    }
    // Issue #4419: the tile switched instance with a save still waiting — write it under the key it
    // was typed for. Instance scope only: the worktree screen's split scope drops it as before, and
    // an unmount writes nothing on either. Issue #4604: a write that fails says so (the text is gone).
    if (draftScope === 'instance' && pendingSave && pendingSave.key !== draftKey) {
      const written = writeDraft(pendingSave.key, pendingSave.message);
      if (!written) notify(t(PREVIOUS_DRAFT_NOT_SAVED_KEY), 'warning');
      // r4 (P1-6): the tile hears it before its own effect moves that draft (a child's effects run first).
      onPreviousDraftSaved?.(pendingSave.key, written);
    }
    let saved: string | null = null;
    let unreadable = false;
    try {
      if (draftScope === 'split' && splitIndex === 0) {
        migrateLegacyDraftKey(worktreeId);
      }
      saved = window.localStorage.getItem(draftKey);
    } catch {
      /* localStorage unavailable */
      unreadable = true;
    }
    // Issue #4604 (4 回目・5 回目, N-6): the text is this key's — what is stored (nothing when it cannot
    // be read: the previous draft's text is never left under this key), and after it what was typed
    // for this key between the commit of the switch and this effect.
    const switched = restoredKeyRef.current !== draftKey;
    restoredKeyRef.current = draftKey;
    setDraft((prev) => {
      const typed = switched && prev.key === draftKey ? prev.text : '';
      const base = saved ?? '';
      return { key: draftKey, text: typed ? appendDraftText(base, typed) : base };
    });
    setDraftUnreadableKey(unreadable ? draftKey : null);
    retargetTagsRef.current = {
      key: draftKey,
      tags: heldTags.key === draftKey ? mergeRetargetTags(heldTags.tags, readRetargetTags(draftKey)) : readRetargetTags(draftKey),
    };
    // r3 (P1-2): the text restored under an "unknown" — this composer holds its generation.
    const storedMarks = readRetargetStore(draftKey);
    const heldUnknown = retargetUnknownRef.current;
    retargetUnknownRef.current =
      storedMarks.kind === 'unknown'
        ? { key: draftKey, generation: storedMarks.generation }
        : heldUnknown !== null && heldUnknown.key === draftKey
          ? heldUnknown
          : null;
    // Issue #4503: the draft's mark comes back with it (a question or a confirmation does not).
    setUnknownMark(readSendUnknownMark(draftKey));
    setConfirmingResend(false);
    setResendConfirmedBoth(false);
    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    };
  // `notify` / `writeRetargetTold` are read at the switch only (a new toast surface is not a switch).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, draftScope, worktreeId, splitIndex, setResendConfirmedBoth]);

  // Issue #4419: text the `/sessions` tile put back into this key's stored draft (a 409 for an
  // instance its own composer is not showing) reaches this composer too when it shows that key —
  // otherwise its state, unaware of it, would overwrite it with the next keystroke's save.
  // The waiting save for this key takes the text at once, too: the state update is only scheduled,
  // and a switch committed together with it writes the waiting save back under this key (the
  // restore effect) — which, still holding the text before the append, would erase it.
  useEffect(
    () =>
      subscribeDraftAppend(draftKey, (text) => {
        const pendingSave = pendingDraftSaveRef.current;
        if (pendingSave && pendingSave.key === draftKey) {
          pendingDraftSaveRef.current = { key: draftKey, message: appendDraftText(pendingSave.message, text) };
        }
        // Issue #4604: into this key's text only (a text of another key is not touched).
        setDraft((prev) => (prev.key === draftKey ? { key: draftKey, text: appendDraftText(prev.text, text) } : prev));
      }),
    [draftKey],
  );

  // Issue #4535 r7 (INV-V2a): a text the send fence handed back into this draft, with its tag — both
  // taken together (the tag into this composer's state, the text the way an insert is). The store
  // already has both (`returnRetargetedText`).
  useEffect(
    () =>
      subscribeRetargetedText(draftKey, ({ text, tag }, info) => {
        // Issue #4604 accept r1 (F2): its tag went in only as the short "unknown" — said once.
        if (info.takeShortUnknown()) notifyRetargetWriteRef.current('unknown-stored', true);
        const held = retargetTagsRef.current;
        if (held.key === draftKey) retargetTagsRef.current = { key: draftKey, tags: mergeRetargetTags(held.tags, [tag]) };
        const pendingSave = pendingDraftSaveRef.current;
        if (pendingSave && pendingSave.key === draftKey) {
          pendingDraftSaveRef.current = { key: draftKey, message: appendDraftText(pendingSave.message, text) };
        }
        // Issue #4604: into this key's text only (a text of another key is not touched).
        setDraft((prev) => (prev.key === draftKey ? { key: draftKey, text: appendDraftText(prev.text, text) } : prev));
      }),
    [draftKey],
  );

  // Issue #4535 r7 (INV-V2b): another tab took this draft's tags from the store (it sent the same
  // draft) — this composer still holds them, so they are written back. Only the ones missing, so two
  // tabs never write back and forth.
  useEffect(() => {
    const tagKey = getRetargetTagKey(draftKey);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== tagKey && event.key !== null) return;
      const held = retargetTagsRef.current;
      // r3 (P1-2): this composer holds the text's "unknown" and the store no longer says "unknown" (the
      // key went, or a list replaced it): written back as an "unknown" — through the one road, as a move
      // of an "unknown" into this key is (設計 §3.2's moveIn row: a new generation over what is there).
      // A store still saying "unknown" (any generation) is left alone: it asks already, and two tabs never
      // write back and forth.
      const heldUnknown = retargetUnknownRef.current;
      if (heldUnknown !== null && heldUnknown.key === draftKey) {
        const stored = readRetargetStore(draftKey);
        if (stored.kind === 'absent' || stored.kind === 'list') {
          writeRetargetTold(draftKey, {
            kind: 'moveIn',
            from: { kind: 'unknown', generation: heldUnknown.generation, tags: held.key === draftKey ? held.tags : [] },
            fromUnstorable: null,
          });
          const after = readRetargetStore(draftKey);
          if (after.kind === 'unknown') retargetUnknownRef.current = { key: draftKey, generation: after.generation };
          return;
        }
      }
      if (held.key !== draftKey || held.tags.length === 0) return;
      // Issue #4604 (N-2・N-10): through the one road — junk or a store that throws is left "unknown".
      if (heldTagsAreStored(draftKey, held.tags)) return;
      writeRetargetTold(draftKey, { kind: 'writeBack', tags: held.tags });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [draftKey, writeRetargetTold]);

  // Debounced save of draft message to localStorage (per-split key, Issue #728; per-instance key
  // for the tile, Issue #4419)
  // Issue #4604 (N-6): the save is the draft's own pair — its key and its text — never this render's
  // key with another draft's text.
  useEffect(() => {
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    pendingDraftSaveRef.current = { key: draft.key, message: draft.text };
    draftSaveTimerRef.current = setTimeout(() => {
      // Issue #4419: the ref, not this render's `message` — an append may have updated it since.
      const pendingSave = pendingDraftSaveRef.current;
      pendingDraftSaveRef.current = null;
      // Issue #4535 r7 (INV-V2b): the tags this composer holds are stored with the draft (written back
      // should another tab have taken them). Issue #4604 (INV-S1): the marks first, then the text.
      const held = retargetTagsRef.current;
      if (pendingSave && held.key === pendingSave.key && held.tags.length > 0 && !heldTagsAreStored(held.key, held.tags)) {
        writeRetargetTold(held.key, { kind: 'writeBack', tags: held.tags });
      }
      if (pendingSave) writeDraft(pendingSave.key, pendingSave.message);
    }, 500);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  /** The draft was sent: forget it (and any save still waiting, so it is not written back). */
  // Issue #4604 (INV-S1): returns whether the stored text went (its marks go only after it).
  const clearStoredDraft = useCallback((): boolean => {
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = null;
    pendingDraftSaveRef.current = null;
    const removed = writeDraft(draftKey, '');
    // Issue #4503: the draft went — so does its mark (nothing is left to send again).
    writeSendUnknownMark(draftKey, null);
    setUnknownMark(null);
    setResendConfirmedBoth(false);
    return removed;
  }, [draftKey, setResendConfirmedBoth]);

  /**
   * Issue #4419: an awaited send was taken. When the composer still shows the draft it sent, clear
   * it as before; when it switched meanwhile (the tile's instance, its roster), only the sent
   * draft's stored copy (and the sent image, if still attached) goes — the draft on screen, its
   * state and its waiting save are another instance's. Returns whether the sent draft is still the one on screen.
   */
  // Issue #4604 (INV-S1): `removed` — whether the sent draft's stored text went (its marks go after it).
  const clearSentDraft = useCallback((sentKey: string, sentImagePath: string | null): { onScreen: boolean; removed: boolean } => {
    if (draftKeyRef.current !== sentKey) {
      const removed = writeDraft(sentKey, '');
      writeSendUnknownMark(sentKey, null);
      // The attachment is not per instance: the image that went with the send is still attached
      // and would go again with the next Send — take it off (the text on screen stays).
      if (sentImagePath !== null && attachedImagePathRef.current === sentImagePath) resetAfterSend();
      return { onScreen: false, removed };
    }
    setDraft((prev) => (prev.key === sentKey ? { key: sentKey, text: '' } : prev));
    setIsFreeInputMode(false);
    resetAfterSend();
    return { onScreen: true, removed: clearStoredDraft() };
  }, [resetAfterSend, clearStoredDraft]);

  /**
   * Auto-resize textarea based on content.
   *
   * Issue #2681: a stored height acts as a floor (minimum height), not a fixed
   * height. The textarea always auto-grows with content up to
   * COMPOSER_AUTO_MAX_HEIGHT_PX (and bounded by maxHeight). When empty or shorter
   * than the floor, it shrinks down to the floor. A layout effect, so the floor
   * height is applied before the first paint instead of flashing the one-line composer first.
   */
  useIsomorphicLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const bound = typeof maxHeight === 'number' && Number.isFinite(maxHeight) ? maxHeight : Infinity;
    const floor = Math.min(heightFloor ?? COMPOSER_MIN_HEIGHT_PX, bound);
    if (!message) {
      textarea.style.height = `${floor}px`;
      return;
    }
    textarea.style.height = 'auto';
    const content = Math.min(textarea.scrollHeight, COMPOSER_AUTO_MAX_HEIGHT_PX);
    textarea.style.height = `${Math.min(Math.max(floor, content), bound)}px`;
  }, [message, heightFloor, maxHeight]);

  /**
   * Issue #485: Insert pending text into message input
   */
  useEffect(() => {
    if (!pendingInsertText) return;
    setMessage((prev) => {
      if (prev.trim() === '') return pendingInsertText;
      return prev + '\n\n' + pendingInsertText;
    });
    onInsertConsumed?.();
  }, [pendingInsertText, onInsertConsumed, setMessage]);

  /**
   * Issue #4385: the sentence of a failed (awaited) send. A 409 the server refused because of the
   * role (`roleRefusal`, nothing typed) says why and what to do, in the screen's language — the
   * same meaning as the CLI's `send` exit 32; the draft stays, as for every failed send here.
   */
  const describeSendError = useCallback((err: unknown): string => {
    const roleRefusal = readSendRoleRefusal(err);
    if (roleRefusal !== null) return t(sendRoleRefusalMessageKey(roleRefusal));
    // Issue #4535 (段 2 §3.2): the send fence stopped it — why, and the target it was going to.
    const targetChanged = readSendTargetChanged(err);
    if (targetChanged !== null && targetChanged.sendOutcome === 'not_sent') {
      return t(SEND_TARGET_CHANGED_KEYS.notSent, {
        reason: t(sendTargetChangedReasonKey(targetChanged.reason)),
        target: targetChanged.target?.instanceId ?? '?',
      });
    }
    return handleApiError(err);
  }, [t]);

  /**
   * Handle message submission
   */
  const submitMessage = useCallback(async () => {
    // Issue #4607 r2: a yes to a store that cannot be read is taken by this send's entry — whatever
    // stops it before the POST, it is not left for a later send (kept only for its brief choice).
    // Issue #4607 r3: and it holds only while the To is the one it answered.
    const yesTarget = retargetUnreadableYesRef.current;
    retargetUnreadableYesRef.current = null;
    const unreadableYes = yesTarget !== null && yesTarget.target === sendTargetKey ? yesTarget : null;
    if (isComposing || (!message.trim() && !attachedImage) || sending) {
      return;
    }
    // Issue #4604 (W-1, INV-K1): the text and its key are one state; while it is another draft's
    // (between the commit of a key change and the restore), nothing is sent from this render.
    if (draft.key !== draftKey) return;
    // Issue #4606: the To is a target the fence just said changed — nothing is sent until the roster
    // is read again (the sentence is shown; the draft stays).
    if (sendBlockedReason) return;
    // Issue #4227 G-PR6: a send already waiting on its preview takes no second press (Enter or button).
    if (briefCheckingRef.current) return;
    // Issue #3999: the door both the button and a PC's Enter come through.
    // Before the optimistic hand-off, so no pending row is made and the draft
    // (state and localStorage) is left exactly as typed.
    if (planReviewActive) {
      setPlanReviewStopped(true);
      return;
    }
    // Issue #4503: the same draft as a send whose outcome is unknown — ask before anything is sent
    // (Enter and the button both come through here; the brief choice is reached only from here).
    if (holdsUnconfirmedResend(message.trim())) return;
    // Issue #4535: a text the send fence handed back, and the To is not its target — ask first.
    if (holdsRetargetedSend(unreadableYes, draft.key) === null) return;
    // Issue #4345 1c 再指示 1: a send of a worktree page starts only while the page's registration
    // (fixed now) may start — not once a 401 was taken (the registry's expiry). Nothing is sent and
    // the draft stays; checked again after the preview's await below. Outside a page: as before.
    const operation = beginHandoffPageOperation(handoffOwner);
    if (!operation.mayStart()) return;

    const trimmed = message.trim();
    const effectiveCliTool: CLIToolType = cliToolId || 'claude';
    const options: { cliToolId: CLIToolType; instanceId?: string; imagePath?: string } = { cliToolId: effectiveCliTool };
    // Issue #869: route to the specific instance when it differs from the primary.
    if (instanceId && instanceId !== effectiveCliTool) {
      options.instanceId = instanceId;
    }
    if (attachedImage) {
      options.imagePath = attachedImage.path;
    }

    // Issue #4227 G-PR3 (G-3, design §3.2・§3.2.1): an attended branch with a pending boundary
    // asks before the first send — BEFORE the draft is cleared or handed to the optimistic
    // layer. A command carries no brief (D1 §4.1) and is never asked about.
    // G-PR6: the preview is read afresh for this send and waited for (mode on and derived alike;
    // the server alone says whether to ask). The cached one never decides it. A read that fails
    // or runs over the limit sends nothing: the draft stays, with the reason and "try again".
    if (!isCommandBody(trimmed)) {
      const attempt = ++sendAttemptRef.current;
      briefCheckingRef.current = true;
      setBriefChecking(true);
      setBriefCheckFailed(false);
      setError(null);
      let read: { value: StartPreviewResponse | null; current: boolean };
      try {
        read = await readStartPreview();
      } finally {
        if (attempt === sendAttemptRef.current) {
          briefCheckingRef.current = false;
          setBriefChecking(false);
        }
      }
      // Superseded (the target changed, the composer went, a newer attempt) — or the draft (its
      // text or its image) was changed while the preview was read: nothing is sent, the draft is
      // as it is now.
      if (
        !read.current ||
        attempt !== sendAttemptRef.current ||
        messageRef.current.trim() !== trimmed ||
        attachedImagePathRef.current !== (attachedImage?.path ?? null) ||
        // Issue #4345 1c 再指示 1: another entry's 401 taken while the preview was read (its own 200
        // recovers nothing): nothing is sent, the draft stays.
        !operation.mayStart()
      ) {
        return;
      }
      // A plan review that began while the preview was read stops the send, as one up before it
      // does (Issue #3999): the draft stays.
      if (planReviewActiveRef.current) {
        setPlanReviewStopped(true);
        return;
      }
      if (!read.value) {
        setBriefCheckFailed(true);
        return;
      }
      if (read.value.show) {
        retargetUnreadableYesRef.current = unreadableYes;
        setBriefAsk({ preview: read.value, notice: null });
        return;
      }
    }

    // Issue #1121: optimistic path. Hand the send to the history layer (which
    // shows a pending bubble and fires the API in the background) and clear the
    // composer immediately rather than blocking on the API. Send failures surface
    // on the pending bubble, so the composer never sets its own error/sending
    // state here.
    if (onOptimisticSend) {
      // Issue #4604＋#4606 r3c: the gate, as the send is handed over (the hold and the marks now).
      // Issue #4535 r7 (INV-V2b): the tags this send takes away once it is sent (a tag that comes later
      // stays). Issue #4604 (N-7): and the "unknown" generations its question saw.
      const gate = checkGate(draft.key, unreadableYes);
      if (gate === null) return;
      setError(null);
      onOptimisticSend(trimmed, options);
      setMessage('');
      setIsFreeInputMode(false);
      resetAfterSend();
      // Issue #4604 (INV-S1): the text goes first; its marks only once it went.
      if (clearStoredDraft()) releaseSentTags(draftKey, gate.ids, gate.seen);
      if (isProcessing) {
        showToast?.(QUEUED_BUSY_TOAST_MESSAGE, 'warning');
      }
      onMessageSent?.(effectiveCliTool);
      afterSendStartPreview();
      return;
    }

    try {
      setSending(true);
      setError(null);
      // Issue #4345 1c: the send's 401 reaches the gateway before it becomes an ApiError. 再指示 2 (K1):
      // with the press's token — the gate reads the registration the press fixed.
      const sentKey = draftKey;
      const sentImagePath = attachedImage?.path ?? null;
      // Issue #4604＋#4606 r3c: through the one gate (not sent: the draft stays, nothing else happens).
      const posted = await postThroughGate(draft.key, unreadableYes, trimmed, options, operation);
      if (!posted.sent) return;
      const { created } = posted;
      // Issue #4604 (INV-S1): the text goes first; its marks only once it went.
      if (clearSentDraft(sentKey, sentImagePath).removed) releaseSentTags(sentKey, posted.gate.ids, posted.gate.seen);
      // Issue #806: when the session is busy, the CLI queues this message behind
      // the running task. Surface a toast so the (successful) send doesn't look
      // like a no-op. Idle sessions are unchanged (no toast).
      if (isProcessing) {
        showToast?.(QUEUED_BUSY_TOAST_MESSAGE, 'warning');
      }
      // Issue #2213: hand the created row on. `/send` returns it and this is the
      // path with nothing else to reconcile against — the optimistic path above
      // has `usePendingMessages` for that and passes nothing.
      onMessageSent?.(effectiveCliTool, created);
      afterSendStartPreview();
    } catch (err) {
      // Issue #4345 1c 再指示 2 (K1): not sent (the page's gate refused it) — nothing happened: no
      // error, the draft stays.
      if (isHandoffPageOperationRefused(err)) return;
      // Issue #4503: nobody knows whether it arrived — the draft stays, the composer says so, and
      // its next send asks first (never an error that invites a plain Enter).
      if (isSendOutcomeUnknown(err)) {
        markSendUnknown(draftKey, trimmed, previewKey);
        noteFenceRefusal(err, draftKey, trimmed);
        return;
      }
      noteFenceRefusal(err, draftKey, trimmed);
      setError(describeSendError(err));
    } finally {
      setSending(false);
    }
  }, [isComposing, message, draft.key, attachedImage, sending, cliToolId, instanceId, onMessageSent, resetAfterSend, clearStoredDraft, clearSentDraft, draftKey, isProcessing, showToast, onOptimisticSend, planReviewActive, readStartPreview, afterSendStartPreview, handoffOwner, describeSendError, holdsUnconfirmedResend, holdsRetargetedSend, checkGate, postThroughGate, markSendUnknown, noteFenceRefusal, releaseSentTags, previewKey, sendTargetKey, setMessage, sendBlockedReason]);

  /**
   * Issue #4227 G-PR3 (G-3, design §3.2・§3.2.1): send the draft with the person's choice for the
   * boundary the preview showed. Awaited (not the optimistic layer): the draft — text and image —
   * is cleared only once the server took it, so a 409 `boundary_changed` (nothing typed) asks
   * again with a fresh preview and the draft as it was. Never sent again on its own.
   */
  const sendWithBriefChoice = useCallback(async (choice: StartBriefChoice) => {
    // Issue #4607 r2: see the plain send (the yes carried to this choice is taken here, held or not).
    // r3: for the To it answered only (the To may have changed while the brief was up).
    const yesTarget = retargetUnreadableYesRef.current;
    retargetUnreadableYesRef.current = null;
    const unreadableYes = yesTarget !== null && yesTarget.target === sendTargetKey ? yesTarget : null;
    const asked = briefAsk;
    if (!asked || briefSending) return;
    // Issue #4345 1c 再指示 1: see the plain send (nothing is sent, the draft and the question stay).
    const operation = beginHandoffPageOperation(handoffOwner);
    if (!operation.mayStart()) return;
    // Issue #4604 (W-1): see the plain send (another draft's text is not this render's).
    if (draft.key !== draftKey) return;
    // Issue #4606: see the plain send (the question stays; nothing is sent).
    if (sendBlockedReason) return;
    const trimmed = message.trim();
    if (!trimmed && !attachedImage) {
      setBriefAsk(null);
      return;
    }
    // Issue #4503: see the plain send (the question first; nothing is sent).
    if (holdsUnconfirmedResend(trimmed)) {
      setBriefAsk(null);
      return;
    }
    if (holdsRetargetedSend(unreadableYes, draft.key) === null) {
      setBriefAsk(null);
      return;
    }
    const effectiveCliTool: CLIToolType = cliToolId || 'claude';
    const choiceOptions: SendBriefChoice =
      choice === 'decline'
        ? { brief: 'decline', briefBoundary: asked.preview.boundary.id }
        : { briefDetail: choice, briefBoundary: asked.preview.boundary.id };
    const options: { cliToolId: CLIToolType; instanceId?: string; imagePath?: string } & SendBriefChoice = {
      cliToolId: effectiveCliTool,
      ...(instanceId && instanceId !== effectiveCliTool ? { instanceId } : {}),
      ...(attachedImage ? { imagePath: attachedImage.path } : {}),
      ...choiceOptions,
    };
    setBriefSending(true);
    setSending(true);
    setError(null);
    try {
      // Issue #4345 1c: see the plain send.
      const sentKey = draftKey;
      const sentImagePath = attachedImage?.path ?? null;
      // Issue #4604＋#4606 r3c: through the one gate (see the plain send; the question stays).
      const posted = await postThroughGate(draft.key, unreadableYes, trimmed, options, operation);
      if (!posted.sent) return;
      const { created } = posted;
      // Issue #4419: a switch meanwhile already closed the question (the previewKey change).
      // Issue #4604 (INV-S1): the text goes first; its marks only once it went.
      const cleared = clearSentDraft(sentKey, sentImagePath);
      if (cleared.removed) releaseSentTags(sentKey, posted.gate.ids, posted.gate.seen);
      if (cleared.onScreen) setBriefAsk(null);
      if (created?.brief?.state === 'consumed') showToast?.(tc('mem.startBrief.consumed'), 'info');
      else if (isProcessing) showToast?.(QUEUED_BUSY_TOAST_MESSAGE, 'warning');
      onMessageSent?.(effectiveCliTool, created);
      refreshStartPreview(true);
    } catch (err) {
      // Issue #4345 1c 再指示 2 (K1): not sent — nothing happened: the question and the draft stay.
      if (isHandoffPageOperationRefused(err)) return;
      if (isBriefBoundaryChanged(err)) {
        const reason = typeof err.data.reason === 'string' ? err.data.reason : '';
        const notice = `${tc('mem.startBrief.askAgain', { reason })}${reason === 'claimed' ? ` ${tc('mem.startBrief.claimed')}` : ''}`;
        // G-PR6: through the same generation rule as every read — an older background read that
        // lands later cannot put the old boundary back; a target change voids this answer.
        const { value: fresh, current } = await readStartPreview();
        if (!current) return;
        if (fresh === null) {
          // The read failed (or the boundary moved again under it, 409 → null): the same as a failed
          // read before a send — nothing is sent, the draft stays, "try again" reads anew.
          setBriefAsk(null);
          setBriefCheckFailed(true);
        } else if (fresh.show) {
          setBriefAsk({ preview: fresh, notice });
        } else {
          // Nothing to ask any more (used up, or the branch changed): the draft stays for a plain send.
          setBriefAsk(null);
          setError(notice);
        }
      } else if (isSendOutcomeUnknown(err)) {
        // Issue #4503: the boundary's choice is made — the dialog closes as for any failure; the
        // draft stays and its next send (Enter, the button, the choice) asks first.
        setBriefAsk(null);
        markSendUnknown(draftKey, trimmed, previewKey);
        noteFenceRefusal(err, draftKey, trimmed);
      } else {
        setBriefAsk(null);
        noteFenceRefusal(err, draftKey, trimmed);
        setError(describeSendError(err));
      }
    } finally {
      setBriefSending(false);
      setSending(false);
    }
  }, [sendBlockedReason, briefAsk, briefSending, message, draft.key, attachedImage, cliToolId, instanceId, clearSentDraft, draftKey, showToast, tc, isProcessing, onMessageSent, refreshStartPreview, readStartPreview, handoffOwner, describeSendError, holdsUnconfirmedResend, holdsRetargetedSend, postThroughGate, markSendUnknown, noteFenceRefusal, releaseSentTags, previewKey, sendTargetKey]);

  /** Issue #4503: the person confirmed sending the same draft again — a new send. */
  const confirmResend = useCallback(() => {
    setConfirmingResend(false);
    setResendConfirmedBoth(true);
    void submitMessage();
  }, [submitMessage, setResendConfirmedBoth]);
  const cancelResend = useCallback(() => {
    setConfirmingResend(false);
  }, []);
  /** Issue #4535: the person said yes — send the handed-back text to this To (a new send). */
  // Issue #4607: the yes to a store that cannot be read holds for this one send only.
  // Issue #4607 r3 (INV-V2c''): the yes is to the To the question named — if the To is another now,
  // nothing is sent and the question is asked again for this To.
  const confirmRetarget = useCallback(() => {
    const asked = retargetAsk;
    setRetargetAsk(null);
    if (asked && asked.target !== sendTargetKey) {
      holdsRetargetedSend(null, draft.key);
      return;
    }
    if (asked?.confirmation) retargetConfirmedRef.current = asked.confirmation;
    else if (asked) retargetUnreadableYesRef.current = { target: asked.target, seen: asked.seen, ids: asked.ids };
    void submitMessage();
  }, [submitMessage, retargetAsk, holdsRetargetedSend, sendTargetKey, draft.key]);
  /** Issue #4535: no — nothing is sent, the draft stays. */
  const cancelRetarget = useCallback(() => {
    setRetargetAsk(null);
  }, []);
  // Issue #4503: the notice belongs to the draft on screen, while it still is that send's text and
  // target (an edit hides it; the mark goes at the next send), until the person confirmed.
  const sendUnknownShown =
    unknownMark !== null && !resendConfirmed && unknownMark.target === previewKey && message.trim() === unknownMark.text;

  const closeBriefAsk = useCallback(() => {
    if (briefSending) return;
    // Nothing is sent; the draft (text and image) stays in the composer.
    // Issue #4607: nor is a yes to a store that cannot be read kept for a later send.
    retargetUnreadableYesRef.current = null;
    setBriefAsk(null);
  }, [briefSending]);

  const handleSubmit = useCallback(async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await submitMessage();
  }, [submitMessage]);

  /**
   * Handle composition start (IME starts)
   */
  const handleCompositionStart = useCallback(() => {
    setIsComposing(true);
    justFinishedComposingRef.current = false;

    // Clear any existing timeout
    if (compositionTimeoutRef.current) {
      clearTimeout(compositionTimeoutRef.current);
    }
  }, []);

  /**
   * Handle composition end (IME finishes)
   */
  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false);
    justFinishedComposingRef.current = true;

    // Clear the flag after a longer delay to catch the Enter key event
    // that might follow immediately after composition end
    if (compositionTimeoutRef.current) {
      clearTimeout(compositionTimeoutRef.current);
    }
    compositionTimeoutRef.current = setTimeout(() => {
      justFinishedComposingRef.current = false;
    }, 300);
  }, []);

  /**
   * Handle slash command selection
   */
  const handleCommandSelect = useCallback((command: SlashCommand) => {
    // Issue #1504: antigravity sessions insert `.agents/skills` entries as /NAME,
    // not codex's $NAME. cliToolId disambiguates codex-skill sources per session.
    setMessage(`${getSlashCommandTrigger(command, cliToolId)} `);
    setShowCommandSelector(false);
    textareaRef.current?.focus();
  }, [cliToolId, setMessage]);

  /**
   * Handle slash command selector cancel
   */
  const handleCommandCancel = useCallback(() => {
    setShowCommandSelector(false);
    setIsFreeInputMode(false);
    textareaRef.current?.focus();
  }, []);

  /**
   * Handle free input mode (Issue #56, #288)
   * Closes selector and carries over filter text as the custom command prefix
   *
   * Empty dependency array rationale (R1-001):
   * - setState functions (setShowCommandSelector, setIsFreeInputMode, setMessage)
   *   are stable across renders (React guarantee).
   * - textareaRef is a React ref (stable reference, never reassigned).
   * - filterText is received as a callback argument, not captured from closure.
   */
  const handleFreeInput = useCallback((filterText: string) => {
    setShowCommandSelector(false);
    setIsFreeInputMode(true);
    setMessage(filterText ? `/${filterText}` : '/');
    // Focus textarea with a small delay to ensure selector is closed
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 50);
  }, [setMessage]);

  /**
   * Handle message input change
   */
  const handleMessageChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setMessage(newValue);

    // Free input mode reset: when message is fully cleared
    if (newValue === '') {
      setIsFreeInputMode(false);
      setShowCommandSelector(false);
      return;
    }

    // Skip selector display logic during free input mode
    // NOTE: setShowCommandSelector(false) is not needed here.
    // handleFreeInput() already executed setShowCommandSelector(false),
    // and there is no path through handleMessageChange that sets showCommandSelector to true
    // when isFreeInputMode is true (this early return prevents it).
    // Mobile command button bypass path is guarded separately (Stage 2 SF-001).
    // (Stage 1 SF-002: Considered defensive setShowCommandSelector(false) here,
    //  but path analysis shows no reachable case, so omitted per KISS principle)
    if (isFreeInputMode) {
      return;
    }

    // Show command selector when a trigger character is typed at the start.
    // Issue #799: Codex skills are surfaced via the `$NAME` trigger (introduced
    // in #790), so on the Codex tab the selector also opens on a leading '$'.
    // Other CLI tools (Claude/Copilot/Gemini) treat '$' as a normal character
    // to avoid false triggers.
    const isSlashTrigger =
      newValue === '/' || (newValue.startsWith('/') && !newValue.includes(' '));
    const isDollarTrigger =
      cliToolId === 'codex' &&
      (newValue === '$' || (newValue.startsWith('$') && !newValue.includes(' ')));
    if (isSlashTrigger || isDollarTrigger) {
      setShowCommandSelector(true);
    } else {
      setShowCommandSelector(false);
    }
  }, [isFreeInputMode, cliToolId, setMessage]);

  /**
   * Handle keyboard shortcuts
   */
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Check for IME composition using keyCode
    // keyCode 229 indicates IME composition in progress
    const { keyCode } = e.nativeEvent;
    if (keyCode === 229) {
      return;
    }

    // Close command selector on Escape
    if (e.key === 'Escape' && showCommandSelector) {
      e.preventDefault();
      handleCommandCancel();
      return;
    }

    // If we just finished composing, ignore the next Enter key
    if (justFinishedComposingRef.current && e.key === 'Enter') {
      justFinishedComposingRef.current = false;
      return;
    }

    // Submit on Enter (but not when Shift is pressed or composing with IME)
    // Shift+Enter allows line breaks
    // Don't submit when command selector is open (unless in free input mode - Issue #288)
    if (e.key === 'Enter' && !isComposing && (!showCommandSelector || isFreeInputMode)) {
      if (isMobile) {
        // Mobile: Enter inserts newline (default behavior)
        return;
      }
      // Desktop: Enter submits, Shift+Enter inserts newline
      if (!e.shiftKey) {
        e.preventDefault();
        void submitMessage();
      }
    }
  }, [showCommandSelector, isFreeInputMode, isComposing, isMobile, submitMessage, handleCommandCancel]);

  // Issue #2598: each toolbar control is one element for both layouts; only the
  // wrappers around them differ (see the toolbar below).
  const toolbarControls = (
    <>
      <Button
        variant="ghost"
        type="button"
        onClick={openFileDialog}
        disabled={isUploading || sending}
        className="flex-shrink-0 p-2 text-muted-foreground hover:text-accent-600 hover:bg-accent-50 dark:hover:text-accent-400 dark:hover:bg-accent-900/30 rounded-full transition-colors disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
        aria-label={t('composer.attachImage')}
        data-testid="attach-image-button"
      >
        {isUploading ? (
          <Spinner size="md" />
        ) : (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        )}
      </Button>
      {/* Issue #2038: opencode-only session operations (new / list / fork).
          Renders nothing for every other tool — see OpencodeSessionControls. */}
      <OpencodeSessionControls
        worktreeId={worktreeId}
        cliToolId={cliToolId || 'claude'}
        instanceId={instanceId}
        disabled={!isSessionRunning}
        // Issue #2109: the composer's existing toast surface, so a 409
        // from a session or share control says why instead of only
        // reaching the console. Undefined at mounts that pass no
        // showToast; the control falls back to an inline message there.
        showToast={showToast}
      />
      {/* Issue #2592: the permission-mode button, in this row rather than a
          new one. Renders nothing for a tool with no mode cycle and for a
          caller that passes no slot. */}
      {isSessionStarting ? null : agentModeSlot}
    </>
  );

  const interruptButton = (
    <InterruptButton
      worktreeId={worktreeId}
      cliToolId={cliToolId || 'claude'}
      instanceId={instanceId}
      disabled={!isSessionRunning || isSessionStarting}
    />
  );

  return (
    <div
      ref={containerRef}
      className="space-y-2 relative"
      data-testid="message-input-container"
    >
      {/* Error display (send error or image error) */}
      {(error || imageError) && (
        <div className="p-2 bg-danger-subtle border border-danger-border rounded text-sm text-danger-foreground">
          {error || imageError}
        </div>
      )}

      {/* Issue #4503: an awaited send whose outcome is unknown — check before sending again. */}
      {sendUnknownShown && (
        <div
          data-testid="message-input-send-unknown"
          role="status"
          className="rounded border border-warning-border bg-warning-subtle px-2 py-1 text-xs leading-5 text-foreground"
        >
          <span className="font-medium">{t('conversation.sendUnknown.status')}</span>{' '}
          {t('conversation.sendUnknown.guidance')}
          {/* Issue #4535 r5: the send fence said why (its `unknown`). */}
          {unknownReason !== null && unknownReason.key === draftKey && unknownReason.text === unknownMark?.text && (
            <span data-testid="message-input-send-unknown-reason" className="block">
              {unknownReason.reason}
            </span>
          )}
          {confirmingResend && (
            <div data-testid="message-input-resend-confirm" role="alert" className="mt-1 flex flex-wrap items-center gap-2">
              <span>{t('conversation.sendUnknown.resendConfirm')}</span>
              <button
                type="button"
                data-testid="message-input-resend-confirm-yes"
                onClick={confirmResend}
                className="inline rounded-sm font-medium text-warning-foreground underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
              >
                {t('conversation.sendUnknown.resendConfirmYes')}
              </button>
              <button
                type="button"
                data-testid="message-input-resend-confirm-no"
                onClick={cancelResend}
                className="inline rounded-sm text-muted-foreground underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
              >
                {t('conversation.sendUnknown.resendConfirmNo')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Issue #4606: the To is a target the fence just said changed — the roster is read again first. */}
      {sendBlockedReason && (
        <p data-testid="message-input-send-blocked" role="status" className="mb-1 text-xs text-muted-foreground">
          {sendBlockedReason}
        </p>
      )}

      {/* Issue #4604: the draft could not be read — the composer is left empty (no other draft's text). */}
      {draftUnreadableKey === draftKey && (
        <p data-testid="message-input-draft-unreadable" className="mb-1 text-xs text-muted-foreground">
          {t(DRAFT_UNREADABLE_KEY)}
        </p>
      )}

      {/* Issue #4535: a text the send fence handed back, and this To is not its target — ask first. */}
      {retargetAsk && (
        <div
          data-testid="message-input-retarget-confirm"
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded border border-warning-border bg-warning-subtle px-2 py-1 text-xs leading-5 text-foreground"
        >
          <span>
            {retargetAsk.original
              ? t(SEND_TARGET_CHANGED_KEYS.retargetConfirm, {
                  original: describeSendTarget(retargetAsk.original),
                  current: describeSendTarget(retargetAsk.current),
                })
              : t(RETARGET_CONFIRM_UNREADABLE_KEY, { current: describeSendTarget(retargetAsk.current) })}
          </span>
          <button
            type="button"
            data-testid="message-input-retarget-confirm-yes"
            onClick={confirmRetarget}
            className="inline rounded-sm font-medium text-warning-foreground underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
          >
            {t(SEND_TARGET_CHANGED_KEYS.retargetConfirmYes)}
          </button>
          <button
            type="button"
            data-testid="message-input-retarget-confirm-no"
            onClick={cancelRetarget}
            className="inline rounded-sm text-muted-foreground underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
          >
            {t(SEND_TARGET_CHANGED_KEYS.retargetConfirmNo)}
          </button>
        </div>
      )}

      {/* Issue #4438 再指示 1: the Antigravity usage notice before the first launch.
          Issue #4456: compact, so a narrow pane keeps the input box in view. */}
      {showUsageNotice && <AntigravityUsageNotice onDismiss={usageNotice.dismiss} compact />}

      {/* Issue #4227 G-PR6: the preview for this send could not be read — nothing was sent. */}
      {briefCheckFailed && (
        <div
          data-testid="session-start-brief-check-failed"
          role="alert"
          className="rounded border border-warning-border bg-warning-subtle px-2 py-1 text-xs leading-5 text-foreground"
        >
          {tc('mem.startBrief.checkFailed')}{' '}
          <button
            type="button"
            data-testid="session-start-brief-check-retry"
            onClick={() => void submitMessage()}
            className="inline rounded-sm font-medium text-warning-foreground underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
          >
            {tc('mem.startBrief.retry')}
          </button>
        </div>
      )}

      {/* Issue #3999: why nothing is sent while the plan review is up, and
          the way to the controls that do answer it. */}
      {planReviewActive && (
        <div
          data-testid="composer-plan-review-notice"
          role={planReviewStopped ? 'alert' : 'status'}
          // One short line where it fits: every pixel here comes out of the
          // surface above, which is where the controls themselves are drawn.
          className="rounded border border-warning-border bg-warning-subtle px-2 py-1 text-xs leading-5 text-foreground"
        >
          {t('planReview.composerNotice')}{' '}
          <button
            type="button"
            data-testid="composer-plan-review-goto"
            onClick={() => revealPlanReviewControls(`${worktreeId}:${instanceId ?? cliToolId ?? 'claude'}`)}
            className="inline rounded-sm font-medium text-warning-foreground underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
          >
            {t('planReview.composerGoto')}
          </button>
        </div>
      )}

      {/* Issue #474: Image attachment preview */}
      {attachedImage && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-accent-50 dark:bg-accent-900/20 border border-accent-200 dark:border-accent-800 rounded-lg text-sm" data-testid="image-attachment-preview">
          <svg className="h-4 w-4 flex-shrink-0 text-accent-600 dark:text-accent-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span className="truncate text-accent-800 dark:text-accent-300">{attachedImage.file.name}</span>
          {/* Issue #1061: dense p-0.5 icon action in the attachment pill (hover-lift would disturb the compact pill) — 残置 */}
          <button
            type="button"
            onClick={removeAttachment}
            className="flex-shrink-0 p-0.5 text-accent-600 hover:text-danger-foreground dark:text-accent-400 rounded transition-colors"
            aria-label={t('composer.removeAttachment')}
            data-testid="remove-attachment-button"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Hidden file input for image selection */}
      <input
        ref={fileInputRef as React.RefObject<HTMLInputElement>}
        type="file"
        accept={acceptAttribute}
        onChange={handleFileSelect}
        className="hidden"
        data-testid="image-file-input"
      />

      {/* Issue #2598: `relative` anchors the height handle on the top edge. */}
      <form onSubmit={handleSubmit} className="relative rounded-xl bg-surface border border-border shadow-sm px-3 py-2 focus-within:ring-2 focus-within:ring-accent-500/40 transition-shadow flex flex-col gap-1.5">
        {/* Issue #2598: the height handle (PC, and only where the caller named a
            scope). Absolutely positioned over the top border, so it costs the
            composer no height. The handle keeps its own mousedown from moving
            focus, so the textarea keeps the caret and nothing gets selected. */}
        {resizable && (
          <div
            className="absolute inset-x-3 top-0 -translate-y-1/2"
            data-testid="composer-resize-handle"
            data-height-mode={heightFloor === null ? 'auto' : 'floor'}
          >
            <PaneResizer
              orientation="vertical"
              onResize={handleHeightResize}
              onDoubleClick={resetHeight}
              ariaLabel={t('composer.resizeHandle')}
              ariaValueNow={composerHeightPercent(heightFloor, maxHeight)}
            />
          </div>
        )}
        {/* Issue #1080: input area (action buttons + textarea + send) */}
        {/* Issue #2597: `@container` makes this row the query container for
            the controls inside it (AgentModeControl's `shift+tab`), so they
            answer to the pane's width and not the viewport's. This element and
            not `message-input-container`: it holds the controls on both
            layouts, and the slash-command sheet (`fixed`) stays outside it. */}
        {/* Issue #2598: two rows on both layouts now — the toolbar over
            [textarea][send]. It was one row on a PC, where every control but
            the textarea refused to shrink and a 218px split pane left the
            textarea 0px wide. The container is still this element and still as
            wide as the composer, so #2597's threshold means what it meant. */}
        <div
          className="@container flex flex-col gap-1"
          data-testid="composer-input-row"
        >
          {/* Row 1: the toolbar, [attach][opencode][mode] then [interrupt].
              The phone puts the slash button first (a PC opens the selector by
              typing `/`, as the hint says) and keeps the interrupt button in
              line with the others, exactly as before; a PC holds it at the
              right end. */}
          <div className="flex items-center gap-1" data-testid="composer-toolbar">
            {isMobile ? (
              <>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    if (isFreeInputMode) {
                      setIsFreeInputMode(false);
                    }
                    setShowCommandSelector(true);
                  }}
                  className="flex-shrink-0 p-2 text-muted-foreground hover:text-accent-600 hover:bg-accent-50 dark:hover:text-accent-400 dark:hover:bg-accent-900/30 rounded-full transition-colors"
                  aria-label={t('composer.showSlashCommands')}
                  data-testid="mobile-command-button"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
                  </svg>
                </Button>
                {toolbarControls}
                {directInputSlot}
                {interruptButton}
              </>
            ) : (
              <>
                {/* PC: the controls that can outgrow a narrow split pane
                    (opencode's four session buttons do in a 218px one) scroll
                    sideways inside this group rather than push the interrupt
                    button past the pane's clipped edge. `flex-1` is also what
                    puts the interrupt button at the right end. */}
                <div
                  className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-hide"
                  data-testid="composer-toolbar-start"
                >
                  {toolbarControls}
                </div>
                {/* `InterruptButton` takes no className; this group keeps it
                    whole and always on screen. Issue #2797: the direct-input
                    toggle shares it for exactly that reason. */}
                <div className="flex flex-shrink-0 items-center gap-1" data-testid="composer-toolbar-end">
                  {directInputSlot}
                  {interruptButton}
                </div>
              </>
            )}
          </div>

          {/* Row 2: message input + send */}
          {/* PC: `items-end`, so a send button beside a textarea made tall by
              the handle sits at its bottom, next to the last line, instead of
              floating at its middle. Same place for a one-line textarea. */}
          <div
            className={`flex ${isMobile ? 'items-center' : 'items-end'} gap-2 flex-1 min-w-0`}
            data-testid="composer-textarea-row"
          >
            <textarea
              ref={textareaRef}
              data-testid="message-input-textarea"
              value={message}
              onChange={handleMessageChange}
              onKeyDown={handleKeyDown}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onFocus={handleComposerFocus}
              placeholder={t('composer.placeholder')}
              disabled={sending}
              rows={1}
              // Issue #1128: mobile keyboard hints — the composer's primary action
              // is to send, and it accepts free-form text.
              inputMode="text"
              enterKeyHint="send"
              className="flex-1 outline-none bg-transparent resize-none overflow-y-auto scrollbar-thin"
              // Issue #2681: a stored height acts as a floor, bounded by maxHeight.
              // Content auto-grows up to COMPOSER_AUTO_MAX_HEIGHT_PX (and maxHeight).
              style={{
                minHeight: `${Math.min(heightFloor ?? COMPOSER_MIN_HEIGHT_PX, cssBound)}px`,
                maxHeight: `${Math.min(Math.max(heightFloor ?? 0, COMPOSER_AUTO_MAX_HEIGHT_PX), cssBound)}px`,
                paddingTop: '8px',
                paddingBottom: '8px',
                lineHeight: '20px',
              }}
            />

            <ComposerSendButton
              message={message}
              hasAttachment={!!attachedImage}
              sending={sending || briefChecking}
              ariaLabel={t('composer.sendMessage')}
            />
          </div>
        </div>

        <ComposerMetaRow
          autoYesSlot={autoYesSlot}
          isMobile={isMobile}
          commandsHint={t('composer.commandsHint')}
          newlineHint={t('composer.newlineHint')}
        />
      </form>

      {/* Issue #4227 G-PR3 (G-3): how much of the hand-off the agent reads, asked before the send. */}
      {briefAsk ? (
        <SessionStartBriefDialog
          isOpen
          preview={briefAsk.preview.preview}
          notice={briefAsk.notice}
          busy={briefSending}
          onChoose={(choice) => void sendWithBriefChoice(choice)}
          onClose={closeBriefAsk}
        />
      ) : null}

      {/* Slash Command Selector */}
      <SlashCommandSelector
        isOpen={showCommandSelector}
        groups={groups}
        onSelect={handleCommandSelect}
        onClose={handleCommandCancel}
        isMobile={isMobile}
        onFreeInput={handleFreeInput}
        isCatalogStale={isCatalogStale}
        cliToolId={cliToolId}
      />
    </div>
  );
});
