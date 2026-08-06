/**
 * Pure expectations for the detection canary (Issue #1727).
 *
 * Everything in this file is a predicate over an {@link Observation}, so the
 * assertions can be exercised in `npm run test:unit` against committed fixture
 * frames without tmux or a Claude subscription. `npm run canary` supplies the
 * same predicates with LIVE frames.
 */

import { STATUS_REASON } from '@/lib/detection/status-detector';
import { stripAnsi } from '@/lib/detection/ansi';
import type { Expectation, Observation } from './types';

/**
 * Claude's bottom task panel header, e.g. `  3 tasks (0 done, 3 open)`.
 *
 * This is the line at the heart of Issue #1708: `NORMAL_OPTION_PATTERN` reads it
 * as "option 3", poisoning option collection for the AskUserQuestion picker
 * rendered ~950 rows above it. Scenario 3 asserts the panel is actually on
 * screen, so a green result proves the coexistence was really exercised rather
 * than the picker having been captured on its own.
 */
export const TASK_PANEL_HEADER_PATTERN = /^[^\S\n]*\d+\s+tasks?\s*\(/m;

/** True when the frame shows Claude's bottom task panel. */
export function hasTaskPanel(observation: Observation): boolean {
  return TASK_PANEL_HEADER_PATTERN.test(stripAnsi(observation.frame));
}

/**
 * Scenario 1 — idle composer right after startup.
 * Auto-Yes must stay quiet, so `autoYes.isPrompt` is asserted too.
 */
export const expectIdleReady: Expectation = {
  label: 'status=ready reason=input_prompt, no active prompt, Auto-Yes silent',
  matches: (o: Observation): boolean =>
    o.status.status === 'ready' &&
    o.status.reason === STATUS_REASON.INPUT_PROMPT &&
    o.status.hasActivePrompt === false &&
    o.autoYes.isPrompt === false,
};

/**
 * Scenario 2 — tool permission dialog ("Do you want to …? 1. Yes / 2. … / 3. No").
 * Both paths must see it: the status path drives the UI PromptPanel and
 * `wait --on-prompt`, the Auto-Yes path drives automatic answering.
 */
export const expectPermissionDialog: Expectation = {
  label: 'status=waiting reason=prompt_detected hasActivePrompt=true, Auto-Yes sees a prompt',
  matches: (o: Observation): boolean =>
    o.status.status === 'waiting' &&
    o.status.reason === STATUS_REASON.PROMPT_DETECTED &&
    o.status.hasActivePrompt === true &&
    o.autoYes.isPrompt === true,
};

/**
 * Scenario 3 — AskUserQuestion picker WITH the task panel rendered underneath
 * (the Issue #1708 shape). Accepts either classification, matching the Issue
 * table: a prompt (PromptPanel) or a Claude selection list (NavigationButtons).
 * Both keep the session visible as `waiting`; being reported `ready` is the
 * failure that made a worker sit silent until `wait` timed out.
 */
export const expectAskUserQuestionWithTaskPanel: Expectation = {
  label: 'status=waiting (prompt_detected | claude_selection_list) while the task panel is on screen',
  matches: (o: Observation): boolean =>
    o.status.status === 'waiting' &&
    (o.status.reason === STATUS_REASON.PROMPT_DETECTED ||
      o.status.reason === STATUS_REASON.CLAUDE_SELECTION_LIST) &&
    hasTaskPanel(o),
};

/**
 * Scenario 4 — the `/model` overlay.
 *
 * Two independent assertions, because the overlay writes the user's default
 * model when confirmed (Issue #1495):
 * - the status path must classify it as a selection list (NavigationButtons +
 *   escape hatch in the UI), and
 * - the Auto-Yes path must NOT see a prompt, or it would Enter-confirm the
 *   highlighted model and silently change the default.
 */
export const expectModelOverlay: Expectation = {
  label: 'status=waiting reason=claude_selection_list AND Auto-Yes sees no prompt',
  matches: (o: Observation): boolean =>
    o.status.status === 'waiting' &&
    o.status.reason === STATUS_REASON.CLAUDE_SELECTION_LIST &&
    o.status.hasActivePrompt === false &&
    o.status.promptDetection.isPrompt === false &&
    o.autoYes.isPrompt === false,
};

/** Scenario 5 — actively generating. */
export const expectGenerating: Expectation = {
  label: 'status=running reason=thinking_indicator, Auto-Yes silent',
  matches: (o: Observation): boolean =>
    o.status.status === 'running' &&
    o.status.reason === STATUS_REASON.THINKING_INDICATOR &&
    o.status.hasActivePrompt === false &&
    o.autoYes.isPrompt === false,
};

/**
 * Startup screens that eat keystrokes before the composer is usable.
 *
 * `isolated-home.ts` seeds `~/.claude.json` so none of these should appear, but
 * a new Claude version can add one back — and a swallowed first prompt looks
 * exactly like a detection regression. `session.ts` dismisses the answerable
 * ones and aborts on the fatal ones with an actionable message.
 */
export interface StartupOverlay {
  id: string;
  pattern: RegExp;
  /** Key to dismiss it, or `null` when the run cannot continue. */
  dismissKey: 'Enter' | 'Escape' | null;
  /** Explanation printed when `dismissKey` is null. */
  fatalHint?: string;
}

export const STARTUP_OVERLAYS: readonly StartupOverlay[] = [
  {
    id: 'theme-picker',
    pattern: /Choose the text style that looks best/i,
    dismissKey: 'Enter',
  },
  {
    // Two known wordings: the classic "Do you trust the files in this folder?"
    // and the v2.1.x "Quick safety check" workspace screen. Both are answered by
    // Enter on the default "yes" option.
    id: 'trust-dialog',
    pattern:
      /Do you trust the files in this (folder|directory)|Is this a project you created or one you trust|Yes, I trust this folder/i,
    dismissKey: 'Enter',
  },
  {
    id: 'login-method',
    pattern: /Select login method:/i,
    dismissKey: null,
    fatalHint:
      'the throwaway HOME is not authenticated. Set CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) or ANTHROPIC_API_KEY, or run `claude` once so the keychain credential is fresh.',
  },
  {
    id: 'not-logged-in',
    pattern: /Not logged in\s*·\s*(Run|Please run)\s*\/login/i,
    dismissKey: null,
    fatalHint:
      'Claude started but reports "Not logged in". The credential copied into the throwaway HOME was rejected — re-authenticate with `claude /login`, or set CLAUDE_CODE_OAUTH_TOKEN.',
  },
];

/** First startup overlay visible in the frame, if any. */
export function findStartupOverlay(frame: string): StartupOverlay | null {
  const clean = stripAnsi(frame);
  return STARTUP_OVERLAYS.find(overlay => overlay.pattern.test(clean)) ?? null;
}

/**
 * Upstream conditions that stall a scenario without saying anything about the
 * detection layer: API overload, rate/usage limits, transport errors.
 *
 * Observed for real on 2026-08-06 — a `529 Overloaded · Retrying in 34s ·
 * attempt 9/10` banner kept a scenario "running" past its timeout. Reporting
 * that as a detection regression would train everyone to ignore the canary, so
 * these frames get their own outcome (`blocked`) and buy extra waiting time.
 */
export interface UpstreamFault {
  id: string;
  pattern: RegExp;
  /** Whether Claude retries on its own, so waiting longer is worthwhile. */
  selfRetrying: boolean;
}

/**
 * Patterns are anchored on ERROR wording, not on the words "usage limit".
 * Claude's own banner advertises "up to 50% of your weekly usage limit on
 * Fable 5" on a perfectly healthy frame — a looser pattern marked every
 * scenario of a run as `blocked` (measured 2026-08-06), which would have hidden
 * real regressions behind a fake infrastructure excuse.
 */
export const UPSTREAM_FAULTS: readonly UpstreamFault[] = [
  { id: 'overloaded', pattern: /\b5\d{2}\s+Overloaded\b/i, selfRetrying: true },
  { id: 'retrying', pattern: /Retrying in \d+s\s*[·•]\s*attempt \d+\/\d+/i, selfRetrying: true },
  { id: 'limit-reached', pattern: /\blimit reached\b/i, selfRetrying: false },
  { id: 'api-error', pattern: /\bAPI Error(?::|\s+\d{3})/i, selfRetrying: false },
];

/** First upstream fault visible in the frame, if any. */
export function findUpstreamFault(frame: string): UpstreamFault | null {
  const clean = stripAnsi(frame);
  return UPSTREAM_FAULTS.find(fault => fault.pattern.test(clean)) ?? null;
}
