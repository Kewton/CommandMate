/**
 * Auto Yes Resolver - Determines automatic answer for prompt data
 *
 * Base rules (unchanged since Issue #479):
 * - yes/no prompt -> 'y'
 * - multiple_choice with default option -> default option number
 * - multiple_choice without default -> first option number
 * - option requiring text input -> null (skip)
 * - unknown type -> null (skip)
 *
 * Issue #1547: an optional {@link AutoYesPolicy} — the `autoYes` block of an
 * execution contract — can withhold an answer the base rules would have sent.
 * The policy can only ever suppress: it never turns a null into an answer, and
 * omitting it (or passing one that states nothing) reproduces the pre-#1547
 * behaviour exactly, which is what keeps contract-less operation untouched.
 *
 * Client-safe: no server-only imports, because a 'use client' hook
 * (`hooks/useAutoYes.ts`) imports this module.
 */

import { executeRegexWithTimeout, validateStopPattern } from '@/config/auto-yes-config';
import type { PromptData, PromptType } from '@/types/models';

/** Auto-answer policy modes; mirrors AUTO_YES_MODES in lib/tasks/contract-parser. */
export type AutoYesMode = 'off' | 'safe' | 'allow-listed';

/**
 * The `autoYes` block of an execution contract, as the resolver sees it.
 *
 * Declared structurally rather than imported from `lib/tasks/contract-parser`:
 * that module reads from disk, and this one is bundled into the client. The
 * wiring site assigns a `TaskContractAutoYes` to this type, so a drift between
 * the two fails the build.
 */
export interface AutoYesPolicy {
  /** null when the contract states no mode — keep the existing behaviour, unlike 'off'. */
  mode: AutoYesMode | null;
  /** Only consulted under `mode: 'allow-listed'`. */
  allowPromptTypes: PromptType[];
  /** Regex sources that must escalate to a human instead of being auto-answered. */
  denyPatterns: string[];
}

/**
 * Why an auto-answer was withheld.
 *
 * `deny-pattern-unusable` is the fail-closed case: a deny pattern that cannot be
 * evaluated (unsafe, unparseable, or over-long) suppresses instead of being
 * skipped. Ignoring it would silently drop the protection the contract author
 * asked for, which is the more dangerous of the two directions.
 */
export type AutoYesSuppressionReason =
  | 'mode-off'
  | 'deny-pattern'
  | 'deny-pattern-unusable'
  | 'type-not-allowed'
  /**
   * Issue #1829: not a policy verdict at all, but the same outcome recorded
   * through the same channel. The prompt on screen is a CLI-lifecycle dialog
   * whose answer belongs to the tool's own launch sequence, so the poller
   * withheld one. Listed here so `capture --json` / `cmate wait` can name it
   * instead of showing a session that has silently gone quiet.
   */
  | 'agent-launch-dialog';

export interface AutoYesResolution {
  /** The answer to send, or null when nothing should be sent. */
  answer: string | null;
  /** Non-null only when the policy withheld an answer the base rules produced. */
  suppressedBy: AutoYesSuppressionReason | null;
  /** The deny pattern responsible, for the escalation log. */
  pattern?: string;
}

/**
 * Upper bound on a deny pattern, mirroring MAX_PATTERN_LENGTH in
 * lib/tasks/contract-parser (asserted equal by the unit tests). Contracts are
 * validated on load, so this is defence in depth for a contract snapshot that
 * reached the database some other way.
 */
export const MAX_DENY_PATTERN_LENGTH = 200;

/**
 * Upper bound on the text a deny pattern is matched against, per field.
 *
 * A prompt question or option label is a few hundred characters; the bound only
 * exists so a pathological pane cannot make every poll scan megabytes with 32
 * patterns. Matching is over the head of the field, deterministically.
 */
export const MAX_DENY_MATCH_TEXT_LENGTH = 20_000;

/** The pre-policy resolution: the rules as they were before Issue #1547. */
function resolveBaseAnswer(promptData: PromptData): string | null {
  if (promptData.type === 'yes_no') {
    return 'y';
  }

  if (promptData.type === 'multiple_choice') {
    const defaultOpt = promptData.options.find(o => o.isDefault);
    const target = defaultOpt ?? promptData.options[0];

    if (!target) {
      return null;
    }

    if (target.requiresTextInput) {
      return null;
    }

    return target.number.toString();
  }

  return null;
}

/**
 * Every piece of prompt text a deny pattern is matched against.
 *
 * `approvalTarget` is included because that is where the dangerous part usually
 * is — Claude's permission prompts put the command being approved in the lines
 * above the question, not in the question itself.
 *
 * Issue #1699: it used to be `instructionText` that was included here, and that
 * was the bug. `instructionText` is a scrollback window sized for a human to
 * read, so a `rm -rf` approved several turns earlier stayed inside it and went
 * on matching — suppressing every later prompt, including edits that had
 * nothing to do with it, until the line scrolled off the pane. `approvalTarget`
 * is the same block bounded at the previous turn, so what is judged here is
 * what *this* prompt is asking for. Prompts detected before the field existed
 * (an old row replayed from the database) simply match on question and options.
 */
function collectDenyMatchTexts(promptData: PromptData): string[] {
  const texts: string[] = [promptData.question];
  if (promptData.approvalTarget) {
    texts.push(promptData.approvalTarget);
  }
  if (promptData.type === 'multiple_choice') {
    for (const option of promptData.options) {
      texts.push(option.label);
    }
  } else {
    texts.push(...promptData.options);
  }
  return texts;
}

interface DenyOutcome {
  outcome: 'no-match' | 'match' | 'unusable';
  pattern?: string;
}

/**
 * Test the prompt against every deny pattern.
 *
 * Patterns are screened by {@link validateStopPattern} (length, safe-regex2
 * catastrophic-backtracking detection, syntax) before execution, which is the
 * same ReDoS defence the stop-pattern path uses. A pattern that fails screening
 * — or whose execution throws — is reported as `unusable`, not skipped.
 */
function evaluateDenyPatterns(rawTexts: string[], patterns: string[]): DenyOutcome {
  if (patterns.length === 0) {
    return { outcome: 'no-match' };
  }

  const texts = rawTexts.map(text =>
    text.length > MAX_DENY_MATCH_TEXT_LENGTH ? text.slice(0, MAX_DENY_MATCH_TEXT_LENGTH) : text
  );

  for (const pattern of patterns) {
    if (pattern.length > MAX_DENY_PATTERN_LENGTH || !validateStopPattern(pattern).valid) {
      return { outcome: 'unusable', pattern };
    }

    const regex = new RegExp(pattern);
    for (const text of texts) {
      const matched = executeRegexWithTimeout(regex, text);
      if (matched === null) {
        return { outcome: 'unusable', pattern };
      }
      if (matched) {
        return { outcome: 'match', pattern };
      }
    }
  }

  return { outcome: 'no-match' };
}

/** A policy denial, or null when the policy permits the answer. */
export interface AutoYesPolicyDenial {
  reason: AutoYesSuppressionReason;
  pattern?: string;
}

/**
 * Decide whether the policy forbids answering, given the prompt type and the
 * exact texts the deny patterns are to be judged against.
 *
 * Split out of {@link evaluatePolicy} for Issue #1724: the `PermissionRequest`
 * hook adjudicates a structured tool call rather than a screen-scraped prompt,
 * so it has no {@link PromptData} to pass — but it must reach *the same verdict*
 * the screen path would. Two implementations of this ordering would be two
 * chances for the hook to be quietly more permissive than the poller, and the
 * hook's verdict is executed without a dialog.
 *
 * Deny patterns are honoured even when `mode` is null: a contract that lists
 * them has stated a policy, and a listed pattern that quietly did nothing is the
 * worst failure a contract can have. `mode` null with no deny patterns — what
 * the parser produces for a contract with no `autoYes` block — reaches none of
 * these branches and leaves behaviour identical.
 *
 * @param promptType - How the prompt would be classified on screen
 * @param denyMatchTexts - The only strings deny patterns are matched against
 * @param policy - Contract policy; null/undefined permits everything
 */
export function evaluatePolicyAgainstTexts(
  promptType: PromptType,
  denyMatchTexts: string[],
  policy: AutoYesPolicy | null | undefined
): AutoYesPolicyDenial | null {
  if (!policy) return null;

  if (policy.mode === 'off') {
    return { reason: 'mode-off' };
  }

  const deny = evaluateDenyPatterns(denyMatchTexts, policy.denyPatterns);
  if (deny.outcome === 'match') {
    return { reason: 'deny-pattern', pattern: deny.pattern };
  }
  if (deny.outcome === 'unusable') {
    return { reason: 'deny-pattern-unusable', pattern: deny.pattern };
  }

  if (policy.mode === 'safe') {
    return promptType === 'yes_no' ? null : { reason: 'type-not-allowed' };
  }

  if (policy.mode === 'allow-listed') {
    return policy.allowPromptTypes.includes(promptType) ? null : { reason: 'type-not-allowed' };
  }

  return null;
}

/** {@link evaluatePolicyAgainstTexts} over a detected on-screen prompt. */
function evaluatePolicy(
  promptData: PromptData,
  policy: AutoYesPolicy | null | undefined
): AutoYesPolicyDenial | null {
  return evaluatePolicyAgainstTexts(promptData.type, collectDenyMatchTexts(promptData), policy);
}

/**
 * Resolve the automatic answer, reporting whether a policy withheld it.
 *
 * `suppressedBy` is set only when an answer was actually withheld, so the
 * escalation log records real suppressions and not prompts the base rules were
 * never going to answer anyway (an empty option list, an option that needs
 * typing). Those still resolve to null, with `suppressedBy` null.
 *
 * @param promptData - Detected prompt
 * @param policy - Contract auto-answer policy; omit for the unconstrained behaviour
 */
export function resolveAutoAnswerWithPolicy(
  promptData: PromptData,
  policy?: AutoYesPolicy | null
): AutoYesResolution {
  const answer = resolveBaseAnswer(promptData);
  if (answer === null) {
    return { answer: null, suppressedBy: null };
  }

  const denial = evaluatePolicy(promptData, policy);
  if (denial) {
    return { answer: null, suppressedBy: denial.reason, pattern: denial.pattern };
  }

  return { answer, suppressedBy: null };
}

/**
 * Resolve the automatic answer for a given prompt.
 *
 * @param promptData - Detected prompt
 * @param policy - Contract auto-answer policy; omit for the unconstrained behaviour
 * @returns The answer string to send, or null if auto-answer is not possible
 */
export function resolveAutoAnswer(
  promptData: PromptData,
  policy?: AutoYesPolicy | null
): string | null {
  return resolveAutoAnswerWithPolicy(promptData, policy).answer;
}
