/**
 * Auto-Yes's Enter record and the session epoch it belongs to (Issue #3397).
 *
 * Split out of `./auto-yes-enter-fallback` so that this — the part a session's
 * lifecycle has to touch — imports nothing from detection. `beginAgentSession`
 * (every tool's `startSession`, on the creation path) calls
 * {@link beginEnterFallbackSession}: a new process on the same instance key is
 * a new screen history, and an Enter sent to the previous process's dialog must
 * neither be published against the new one (`currentPrompt: true` for the same
 * question) nor keep the poller from answering it (`enterFallbackSentKey`).
 *
 * @module lib/polling/auto-yes-enter-fallback-state
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { generatePromptKey } from '@/lib/detection/prompt-key';
import { buildCompositeKey, filterCompositeKeysByWorktree } from '@/lib/auto-yes-state';
import type { PromptData, PromptType } from '@/types/models';
import { getOrInitGlobal } from '../global-state';
import type { PromptResponseRefusal } from './auto-yes-dialog-gate';

/**
 * What tells two prompts apart for the published record: the type, the
 * question and the option labels.
 *
 * Not the poller's `promptFrameKey` (in `auto-yes-poller-state.ts`): that one also carries the cursor and
 * `approvalTarget`, and the status API reads a different number of rows than
 * the poller does, so `approvalTarget` can differ between the two readings of
 * one screen. The record is matched against the status API's prompt (to say
 * "Auto-Yes sent Enter" under the window it was sent to), so it is keyed on
 * what both readings share.
 */
export function enterFallbackScreenKey(promptData: PromptData): string {
  const options =
    promptData.type === 'multiple_choice'
      ? promptData.options.map((o) => `${o.number}.${o.label}`)
      : promptData.options;
  return [generatePromptKey(promptData), ...options].join('\u0000');
}

// =============================================================================
// The record
// =============================================================================

/**
 * - `sent` — Auto-Yes sent its Enter to the screen;
 * - `no-effect` — the same screen was still up after it, and Auto-Yes did not
 *   send another: the screen is a human's again.
 */
export type AutoYesEnterFallbackOutcome = 'sent' | 'no-effect';

/** The last Enter Auto-Yes sent for one session, as kept in memory. */
export interface AutoYesEnterFallbackRecord {
  outcome: AutoYesEnterFallbackOutcome;
  /** Type of the prompt the Enter was sent to. */
  promptType: PromptType;
  /** The refusal the screen drew (the reason the prompt window offered direct input). */
  refusalReason: PromptResponseRefusal['reason'];
  /** Epoch ms the Enter was sent. */
  sentAt: number;
  /** Epoch ms of the last change: `sentAt`, or when `no-effect` was found. */
  at: number;
  /** {@link enterFallbackScreenKey} of the prompt. Never published. */
  screenKey: string;
}

/**
 * The record as `current-output` publishes it (`autoYes.lastEnterFallback`)
 * and the terminal push carries it.
 */
export interface AutoYesEnterFallbackPublished {
  outcome: AutoYesEnterFallbackOutcome;
  promptType: PromptType;
  refusalReason: PromptResponseRefusal['reason'];
  sentAt: number;
  at: number;
  /**
   * Whether the record is about the prompt this payload publishes. The prompt
   * window shows "Auto-Yes sent Enter" only when this is true and `outcome` is
   * `sent`; a record about an earlier screen says nothing about this one.
   */
  currentPrompt: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __autoYesEnterFallbacks: Map<string, AutoYesEnterFallbackRecord> | undefined;
  // eslint-disable-next-line no-var
  var __autoYesEnterFallbackEpochs: Map<string, number> | undefined;
}

/**
 * compositeKey -> the last Enter. `globalThis` for the reason
 * `auto-yes-suppression-state` gives: the poller writes it and the
 * `current-output` route reads it, and under `next dev` the two are bundled apart.
 */
const lastEnterFallbacks = getOrInitGlobal(
  '__autoYesEnterFallbacks',
  () => new Map<string, AutoYesEnterFallbackRecord>(),
);

/**
 * Record that Auto-Yes sent its Enter to a screen.
 *
 * @param at - Epoch ms; defaults to now. Overridable so tests are deterministic.
 */
export function recordEnterFallbackSent(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  sent: { promptType: PromptType; refusalReason: PromptResponseRefusal['reason']; screenKey: string },
  at: number = Date.now(),
): void {
  lastEnterFallbacks.set(buildCompositeKey(worktreeId, cliToolId, instanceId), {
    outcome: 'sent',
    ...sent,
    sentAt: at,
    at,
  });
}

/**
 * Record that the screen the last Enter went to is still up. A no-op when there
 * is no record, or when it is about another screen.
 *
 * @param at - Epoch ms; defaults to now
 */
export function recordEnterFallbackNoEffect(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  screenKey: string,
  at: number = Date.now(),
): void {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const record = lastEnterFallbacks.get(key);
  if (!record || record.screenKey !== screenKey) return;
  lastEnterFallbacks.set(key, { ...record, outcome: 'no-effect', at });
}

/** @returns The last Enter for this session, or null when Auto-Yes never sent one. */
export function getLastEnterFallback(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): AutoYesEnterFallbackRecord | null {
  return lastEnterFallbacks.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? null;
}

/**
 * The record as published, judged against the prompt the payload carries.
 *
 * @param promptData - The screen-read prompt of the same payload, or null
 */
export function publishEnterFallback(
  record: AutoYesEnterFallbackRecord | null,
  promptData: PromptData | null | undefined,
): AutoYesEnterFallbackPublished | null {
  if (record === null) return null;
  return {
    outcome: record.outcome,
    promptType: record.promptType,
    refusalReason: record.refusalReason,
    sentAt: record.sentAt,
    at: record.at,
    currentPrompt: promptData != null && enterFallbackScreenKey(promptData) === record.screenKey,
  };
}

/**
 * Drop one session's record (Issue #3397). Called wherever the poller for it is
 * stopped — `stopAutoYesPolling`, which the kill-session route (through
 * `releaseAutoYes`), the Auto-Yes disable route and an expired / disabled grant
 * all reach. A record that outlived its session would read `currentPrompt: true`
 * against the same question on the NEXT session, and the window would say
 * "Auto-Yes sent Enter" about an Enter nobody sent there.
 */
export function forgetEnterFallback(compositeKey: string): void {
  lastEnterFallbacks.delete(compositeKey);
}

/** {@link forgetEnterFallback} for every instance of a worktree. */
export function forgetEnterFallbacksByWorktree(worktreeId: string): void {
  for (const key of filterCompositeKeysByWorktree([...lastEnterFallbacks.keys()], worktreeId)) {
    lastEnterFallbacks.delete(key);
  }
}

/** Drop every record: server shutdown (`stopAllAutoYesPolling`), and a test seam. */
export function clearEnterFallbacks(): void {
  lastEnterFallbacks.clear();
}

// =============================================================================
// The session epoch
// =============================================================================

/**
 * compositeKey -> how many sessions have been begun on it in this process.
 * `globalThis` for the same reason as the record: `startSession` and the poller
 * can be bundled apart under `next dev`.
 */
const sessionEpochs = getOrInitGlobal('__autoYesEnterFallbackEpochs', () => new Map<string, number>());

/**
 * A new agent process is being created for this instance (called from
 * `beginAgentSession`): the record is dropped, and the epoch moves on so the
 * poller drops its own per-screen keys at its next tick.
 */
export function beginEnterFallbackSession(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): void {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  lastEnterFallbacks.delete(key);
  sessionEpochs.set(key, (sessionEpochs.get(key) ?? 0) + 1);
}

/** The instance's current session epoch (0 until a session is begun). */
export function getEnterFallbackSessionEpoch(compositeKey: string): number {
  return sessionEpochs.get(compositeKey) ?? 0;
}
