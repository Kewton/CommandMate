/**
 * Auto-Yes's Enter on a choice screen CommandMate cannot read (Issue #3397).
 *
 * ## The screen
 *
 * `assessPromptAnswerability` refuses some frames that are plainly a choice
 * screen: an AskUserQuestion picker whose layout no rule could verify
 * (`unsupported_dialog_layout`), or a numbered list the tool's `detectDialog`
 * does not recognise (`prompt_no_longer_active`). The prompt window then says
 * "this screen cannot be operated from CommandMate" and offers direct input,
 * and Auto-Yes — whose dialog gate (#1928) reads the same frame — sends nothing.
 *
 * With Auto-Yes on, that leaves an unattended worker waiting for a human on a
 * screen where one Enter (confirm whatever is selected now) would do.
 *
 * ## When Enter is sent
 *
 * {@link judgeEnterFallback} answers for the frame, and the poller adds the
 * rest (the policy, the session's owner, sending once per screen):
 *
 *  1. the tool is enabled in {@link AUTO_YES_ENTER_FALLBACK_DEFAULT_MODE} (or by
 *     {@link AUTO_YES_ENTER_FALLBACK_ENV_VAR});
 *  2. `assessPromptAnswerability(cliToolId, raw).refusal !== null` — the SAME
 *     reading the status API publishes as `promptAnswerable`, so the screen
 *     that shows the direct-input link and the screen that gets an Enter are
 *     one set of frames, not two copies of a rule;
 *  3. there is evidence that the pane's focus is on a choice screen:
 *     `unsupported_dialog_layout` (the picker's own footer is on screen), or a
 *     claude / codex frame whose input box is not on screen (`no_composer`);
 *  4. the input box is NOT on screen (`content` / `ghost` / `empty`). Not even
 *     for `unsupported_dialog_layout`: with the composer up, the list is far more
 *     likely an agent's reply quoting one (#1896), and an Enter would submit
 *     whatever sits in the composer — the shape of the accident in which a
 *     parked `/create-pr` was confirmed without anyone asking for it;
 *  5. the tool is still on the pane (a shell prompt under the list means the
 *     agent exited) and is not thinking (a frame mid-stream is not a screen).
 *
 * Everything not decided here is decided on the safe side — no Enter.
 *
 * ## Out of scope
 *
 * opencode / copilot's arrow-key screens (`answerMode: 'keys'`, #1893 — an
 * Enter there confirms whatever is highlighted, which once turned a Reject into
 * an Approve), multi-select screens and options that need typed text (the
 * poller asks `resolveAutoAnswerWithPolicy`, which answers null for both), and
 * Antigravity (its frames reach Auto-Yes only with a hook receipt, #2849).
 *
 * @module lib/polling/auto-yes-enter-fallback
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import { resolveLivenessSpec } from '@/lib/cli-tools/liveness-spec';
import { judgeToolLiveness } from '@/lib/detection/tool-liveness';
import { extractComposerText, type ComposerTextState } from '@/lib/detection/composer-text';
import { stripAnsi, detectThinking } from '@/lib/detection/cli-patterns';
import { THINKING_CHECK_LINE_COUNT } from '@/lib/auto-yes-state';
import {
  assessPromptAnswerability,
  UNSUPPORTED_DIALOG_LAYOUT_REASON,
  type PromptResponseRefusal,
} from './auto-yes-dialog-gate';

// =============================================================================
// Rollout
// =============================================================================

/** Whether Auto-Yes may send its Enter on a tool's unreadable choice screens. */
export type AutoYesEnterFallbackMode = 'enabled' | 'disabled';

/** Every accepted value of {@link AutoYesEnterFallbackMode}, for parsing and tests. */
export const AUTO_YES_ENTER_FALLBACK_MODES: readonly AutoYesEnterFallbackMode[] = ['enabled', 'disabled'];

/**
 * The state each tool ships in.
 *
 * `enabled` only for claude and codex: they are the two tools whose input box
 * can be located (`SUPPORTED_COMPOSER_TOOLS` in `detection/composer-text`), so
 * they are the only two for which "the composer is not on screen" can be read
 * at all — and condition 4 of the module docstring is what keeps #1896 from
 * coming back. Every other tool stays as it was: the frame is left to a human.
 */
export const AUTO_YES_ENTER_FALLBACK_DEFAULT_MODE: Readonly<
  Record<CLIToolType, AutoYesEnterFallbackMode>
> = {
  claude: 'enabled',
  codex: 'enabled',
  copilot: 'disabled',
  opencode: 'disabled',
  'opencode-v2': 'disabled',
  gemini: 'disabled',
  antigravity: 'disabled',
  'vibe-local': 'disabled',
  'command-code': 'disabled',
};

/**
 * The switch, spelled like `CM_AUTOYES_DIALOG_GATE`: comma-separated
 * `<tool>=<mode>` pairs, `*` for every tool, a tool-specific entry beating `*`.
 *
 * ```
 * CM_AUTOYES_ENTER_FALLBACK=*=disabled        # never send the Enter
 * CM_AUTOYES_ENTER_FALLBACK=codex=disabled    # claude only
 * ```
 *
 * Read on every poll, so an operator can turn it off without a restart.
 */
export const AUTO_YES_ENTER_FALLBACK_ENV_VAR = 'CM_AUTOYES_ENTER_FALLBACK';

function isMode(value: string): value is AutoYesEnterFallbackMode {
  return (AUTO_YES_ENTER_FALLBACK_MODES as readonly string[]).includes(value);
}

/**
 * Resolve one tool's mode. An unparseable entry is ignored rather than thrown:
 * this runs on the polling path.
 *
 * @param tool - CLI tool to resolve for
 * @param env - Environment to read; injectable for tests
 */
export function resolveAutoYesEnterFallbackMode(
  tool: CLIToolType,
  env: NodeJS.ProcessEnv = process.env,
): AutoYesEnterFallbackMode {
  const raw = env[AUTO_YES_ENTER_FALLBACK_ENV_VAR];
  let wildcard: AutoYesEnterFallbackMode | null = null;
  let specific: AutoYesEnterFallbackMode | null = null;

  if (typeof raw === 'string' && raw.trim() !== '') {
    for (const entry of raw.split(',')) {
      const [rawKey, rawValue] = entry.split('=');
      if (rawValue === undefined) continue;
      const key = rawKey.trim();
      const value = rawValue.trim();
      if (!isMode(value)) continue;
      if (key === '*') wildcard = value;
      else if (key === tool) specific = value;
    }
  }

  return specific ?? wildcard ?? AUTO_YES_ENTER_FALLBACK_DEFAULT_MODE[tool] ?? 'disabled';
}

// =============================================================================
// The frame
// =============================================================================

/** Why {@link judgeEnterFallback} would not send an Enter at a frame. */
export type EnterFallbackIneligibleReason =
  /** The rollout table (or the env switch) has this tool disabled. */
  | 'tool-disabled'
  /** The poller had no raw capture; the composer cannot be read without SGR. */
  | 'no-raw-frame'
  /** `assessPromptAnswerability` would answer the frame: not this module's case. */
  | 'answerable'
  /** The input box is on screen (`content` / `ghost` / `empty`). */
  | 'composer-visible'
  /** Neither a picker footer nor a missing composer says a choice screen is up. */
  | 'no-choice-screen-evidence'
  /** A shell prompt is under the list: the agent is not on the pane. */
  | 'tool-exited'
  /** The agent is still generating. */
  | 'thinking';

/** What {@link judgeEnterFallback} read off a frame. */
export type EnterFallbackJudgement =
  | {
      eligible: true;
      /** Which refusal the frame drew — what the prompt window shows a link for. */
      refusalReason: PromptResponseRefusal['reason'];
      composerState: ComposerTextState;
    }
  | {
      eligible: false;
      reason: EnterFallbackIneligibleReason;
      refusalReason: PromptResponseRefusal['reason'] | null;
      composerState: ComposerTextState | null;
    };

/** The composer states that mean "the input box is on screen". */
const COMPOSER_ON_SCREEN: ReadonlySet<ComposerTextState> = new Set(['content', 'ghost', 'empty']);

/** The tools whose `no_composer` is a measured reading (see `SUPPORTED_COMPOSER_TOOLS`). */
const NO_COMPOSER_EVIDENCE_TOOLS: ReadonlySet<CLIToolType> = new Set(['claude', 'codex']);

/**
 * May Auto-Yes send its Enter at this frame? Conditions 1-5 of the module
 * docstring, in that order; the policy, the session's owner and "once per
 * screen" are the poller's.
 *
 * @param cliToolId - CLI tool the frame came from
 * @param rawOutput - The tick's capture as captured (ANSI and box drawing
 *   intact). `undefined` is refused: the composer's dim placeholder is only
 *   distinguishable with the SGR attributes, and box drawing is what locates it.
 * @param env - Environment to read the switch from; injectable for tests
 */
export function judgeEnterFallback(
  cliToolId: CLIToolType,
  rawOutput: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): EnterFallbackJudgement {
  if (resolveAutoYesEnterFallbackMode(cliToolId, env) !== 'enabled') {
    return { eligible: false, reason: 'tool-disabled', refusalReason: null, composerState: null };
  }
  if (rawOutput === undefined) {
    return { eligible: false, reason: 'no-raw-frame', refusalReason: null, composerState: null };
  }

  const refusal = assessPromptAnswerability(cliToolId, rawOutput).refusal;
  if (refusal === null) {
    return { eligible: false, reason: 'answerable', refusalReason: null, composerState: null };
  }

  const composerState = extractComposerText(rawOutput, cliToolId).state;
  const ineligible = (reason: EnterFallbackIneligibleReason): EnterFallbackJudgement => ({
    eligible: false,
    reason,
    refusalReason: refusal.reason,
    composerState,
  });

  if (COMPOSER_ON_SCREEN.has(composerState)) return ineligible('composer-visible');

  const pickerFooterOnScreen = refusal.reason === UNSUPPORTED_DIALOG_LAYOUT_REASON;
  const composerOffScreen =
    NO_COMPOSER_EVIDENCE_TOOLS.has(cliToolId) && composerState === 'no_composer';
  if (!pickerFooterOnScreen && !composerOffScreen) return ineligible('no-choice-screen-evidence');

  if (!judgeToolLiveness(rawOutput, resolveLivenessSpec(cliToolId)).alive) {
    return ineligible('tool-exited');
  }

  const recentLines = stripAnsi(rawOutput).split('\n').slice(-THINKING_CHECK_LINE_COUNT).join('\n');
  if (detectThinking(cliToolId, recentLines)) return ineligible('thinking');

  return { eligible: true, refusalReason: refusal.reason, composerState };
}

// The screen key, the record and the session epoch live in
// `./auto-yes-enter-fallback-state` (Issue #3397, review round 2): a module with
// no detection imports, so `agent-session-lifecycle` — on every tool's
// `startSession` path — can expire the record without pulling this one in.
export {
  enterFallbackScreenKey,
  recordEnterFallbackSent,
  recordEnterFallbackNoEffect,
  getLastEnterFallback,
  publishEnterFallback,
  forgetEnterFallback,
  forgetEnterFallbacksByWorktree,
  clearEnterFallbacks,
  beginEnterFallbackSession,
  getEnterFallbackSessionEpoch,
  type AutoYesEnterFallbackOutcome,
  type AutoYesEnterFallbackRecord,
  type AutoYesEnterFallbackPublished,
} from './auto-yes-enter-fallback-state';
