/**
 * useAutoYes - the browser's side of Auto-Yes.
 *
 * Issue #3821: the browser no longer answers prompts. Until this Issue the hook
 * posted an answer to `/prompt-response` whenever Auto-Yes was on and no server
 * poller ran for the agent (#501) — with no execution contract applied (a
 * browser cannot read the task row the policy comes from, #1547), so a poller
 * refused by the concurrent limit left the contract's `off` and deny patterns
 * unenforced on exactly that agent. Automatic answers now come from the server
 * alone: its poller, the `PermissionRequest` hook and the API adjudication. An
 * agent with no poller is left to a human, and the answer panel says so
 * (`autoYesDecision: withheld`, `server-poller-inactive`).
 *
 * The server refuses an answer that still carries the browser's `origin`
 * (`auto-yes-browser`, #3820) with 409, so a tab loaded before this release
 * cannot answer either once it posts one; a tab loaded before #3820 added the
 * `origin` sends none and cannot be told from a person until it is reloaded.
 *
 * The hook stays, with its parameters, so the callers compile unchanged; it
 * sends nothing, and `lastAutoResponse` is always null (nothing is announced
 * that the browser did not do).
 */

'use client';

import type { LivePromptData } from '@/types/models';

/** Parameters for useAutoYes hook */
export interface UseAutoYesParams {
  /** Worktree ID */
  worktreeId: string;
  /** CLI tool identifier */
  cliTool: string;
  /** Whether a prompt is currently waiting */
  isPromptWaiting: boolean;
  /**
   * Current prompt data.
   *
   * Issue #1738: {@link LivePromptData}, because the reducer slice this is read
   * from carries the degraded structured form (#1725) like any other prompt.
   */
  promptData: LivePromptData | null;
  /** Whether auto-yes mode is enabled */
  autoYesEnabled: boolean;
  /** Last server-side response timestamp (Issue #138) */
  lastServerResponseTimestamp?: number | null;
  /** Whether server-side auto-yes poller is active (Issue #501) */
  serverPollerActive?: boolean;
  /** The agent instance the prompt was read from (Issue #3331). */
  instanceId?: string;
}

/** Return value of useAutoYes hook */
export interface UseAutoYesReturn {
  /**
   * The answer the browser sent, for the toggle's notice. Issue #3821: always
   * null — the browser sends none.
   */
  lastAutoResponse: string | null;
}

/**
 * The browser's Auto-Yes: answers nothing (Issue #3821).
 *
 * @returns `lastAutoResponse: null`
 */
export function useAutoYes(_params: UseAutoYesParams): UseAutoYesReturn {
  return { lastAutoResponse: null };
}
