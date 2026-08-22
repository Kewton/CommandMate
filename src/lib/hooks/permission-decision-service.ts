/**
 * Auto-Yes v2: adjudicating Claude's `PermissionRequest` hook (Issue #1724).
 *
 * Auto-Yes has always worked by reading the pane with a regex and injecting a
 * keystroke. This module is the structured replacement: Claude asks *before*
 * drawing the dialog, over HTTP, with the tool call attached, and the answer is
 * a verdict rather than a key. Three bug families stop being possible rather
 * than being fixed — a dialog the detectors cannot read (#1708) never has to be
 * read, deny patterns cannot be poisoned by scrollback (#1699) because there is
 * no scrollback in the input, and an overlay cannot be mistaken for a prompt
 * (#1495) because nothing is typed anywhere.
 *
 * ## The safety rule
 *
 * **A wrong `allow` executes a command; a wrong no-decision costs a dialog.**
 * Every branch that is not certain therefore returns no-decision, which the
 * Issue #1721 spike measured (D5) as landing back in the ordinary TUI approval
 * flow — the behaviour of a machine where this feature does not exist. Timeouts
 * and refused connections are fail-open for the same reason (§1.1).
 *
 * `deny` is never returned. Today's Auto-Yes suppression means *"do not answer
 * this"*, not *"refuse this"*, and a contract's `denyPatterns` is a rule about
 * what may be auto-answered — not a rule about what the human may approve.
 * Turning suppression into a `Denied by PermissionRequest hook` would change the
 * meaning of every existing contract in the field.
 *
 * ## Why the verdict is computed as a `multiple_choice`
 *
 * The dialog this hook pre-empts is detected on screen as a `multiple_choice`
 * prompt ("Do you want to proceed? / 1. Yes / 2. Yes, and … / 3. No"). Feeding
 * that same type into the shared policy evaluator is what stops the hook from
 * being *more permissive* than the poller it front-runs: under `mode: safe` the
 * screen path suppresses a permission dialog, so this one must too.
 *
 * @module lib/hooks/permission-decision-service
 */

import { getAutoYesState } from '@/lib/auto-yes-state';
import { getDbInstance } from '@/lib/db/db-instance';
import { createMessage } from '@/lib/db/chat-db';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { getSessionAutoYesPolicy } from '@/lib/polling/auto-yes-policy';
import {
  evaluatePolicyAgainstTexts,
  MAX_DENY_MATCH_TEXT_LENGTH,
  type AutoYesMode,
  type AutoYesPolicy,
  type AutoYesSuppressionReason,
} from '@/lib/polling/auto-yes-resolver';
import { recordPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import {
  recordAskUserQuestion,
  reportPermissionRequestPending,
} from '@/lib/session/agent-event-state';
import type { PromptType } from '@/types/models';
import { createLogger } from '@/lib/logger';
import { parseAskUserQuestionPayload } from './ask-user-question-payload';
import {
  ASK_USER_QUESTION_TOOL,
  collectToolInputMatchTexts,
  type PermissionRequestPayload,
} from './permission-request-payload';
import { getAgentEventSource } from './sources/registry';
import { recordToolInputNormalization } from './tool-input-normalization-state';

const logger = createLogger('lib/hooks/permission-decision-service');

/**
 * How the pre-empted dialog would have been classified on screen.
 *
 * Not cosmetic: it is what `mode: safe` (yes_no only) and `mode: allow-listed`
 * are evaluated against, so the hook and the poller agree.
 */
export const PERMISSION_REQUEST_PROMPT_TYPE: PromptType = 'multiple_choice';

/** Response time past which the hook is holding the agent up noticeably. */
export const PERMISSION_DECISION_SLOW_MS = 500;

/** Why the adjudicator answered the way it did. */
export type PermissionDecisionReason =
  /** Auto-Yes is on, nothing suppressed it: the only branch that returns a decision. */
  | 'auto-yes'
  /** Not a `PermissionRequest` this server can read — the conservative default. */
  | 'unknown-payload'
  /** `AskUserQuestion`; never adjudicated (Issue #1726). */
  | 'ask-user-question'
  /** Auto-Yes off, never enabled, or expired. */
  | 'auto-yes-disabled'
  /** A contract policy withheld the approval; see `suppressedBy`. */
  | 'policy-suppressed'
  /** The (worktreeId, instanceId) pair named no worktree this server knows. */
  | 'worktree-unresolved';

export interface PermissionDecision {
  /**
   * `'allow'`, or null for no-decision.
   *
   * Null is serialised as an empty object, which the spike measured as landing
   * in the normal TUI approval flow (D5). `'deny'` is not a member: see the
   * module comment.
   */
  behavior: 'allow' | null;
  reason: PermissionDecisionReason;
  /** Which policy rule withheld the approval, when `reason` is policy-suppressed. */
  suppressedBy?: AutoYesSuppressionReason;
  /** The deny pattern responsible, for the escalation log. */
  pattern?: string;
  /** Policy mode in force (null = contract stated no mode, or no contract). */
  mode?: AutoYesMode | null;
}

/** The session a permission request belongs to, resolved from the hook URL. */
export interface PermissionRequestSession {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Defaults to the primary instance (=== cliToolId) at the call site. */
  instanceId: string;
}

const NO_DECISION = (reason: PermissionDecisionReason): PermissionDecision => ({
  behavior: null,
  reason,
});

/**
 * The two things the adjudicator reaches outside itself, made substitutable
 * (Issue #1847).
 *
 * Both defaults are the production ones and both talk to SQLite; every caller
 * in `src/` omits this parameter and is unchanged. It exists for the live
 * canary (`scripts/canary/hook-receiver.ts`), which drives a real Claude TUI
 * with the injected hooks pointed at itself so the `allow` / no-decision
 * verdicts can be observed on screen. That process is not a CommandMate server:
 * it has no worktree row, no task row, and no business opening the developer's
 * database — `recordAllow` would write a prompt-history row into it, and
 * `readPolicy` would silently answer `null` for every contract, which is
 * exactly the branch the no-decision scenario needs to exercise.
 *
 * Substituting these two is what lets the canary run **this** function rather
 * than a re-implementation of it. A copy in the canary would be a second
 * ordering of the table above, free to drift from the one that actually decides
 * whether a command runs unattended — and drift in the permissive direction is
 * not detectable by anything the canary asserts.
 */
export interface PermissionDecisionDeps {
  /**
   * The contract policy governing this session. Defaults to the `autoYes` block
   * of the instance's active task, read through the TTL cache.
   */
  readPolicy?: (session: PermissionRequestSession) => AutoYesPolicy | null;
  /**
   * Where an `allow` is recorded for the audit trail. Defaults to the
   * prompt-history row `capture --prompts` reads.
   */
  recordAllow?: (session: PermissionRequestSession, payload: PermissionRequestPayload) => void;
}

/** Production policy source: the active task's contract, TTL-cached. */
function readContractPolicy(session: PermissionRequestSession): AutoYesPolicy | null {
  return getSessionAutoYesPolicy(session.worktreeId, session.cliToolId, session.instanceId);
}

/**
 * The verdict for one permission request. Pure apart from reading Auto-Yes
 * state and the (TTL-cached) contract policy; the recording side effects live
 * in {@link resolvePermissionRequest}.
 *
 * Order matters and mirrors the table in Issue #1724:
 *
 * | condition | verdict |
 * |---|---|
 * | payload unreadable | no-decision |
 * | `AskUserQuestion` | no-decision |
 * | Auto-Yes off / expired | no-decision |
 * | policy suppresses (mode off, deny pattern, type) | no-decision + suppression |
 * | otherwise | allow |
 *
 * @param session - Worktree / tool / instance the request came from
 * @param payload - Parsed payload, or null when it could not be parsed
 * @param deps - Substitutions for the database-backed lookups; see
 *   {@link PermissionDecisionDeps}. Omit in the server.
 */
export function decidePermissionRequest(
  session: PermissionRequestSession,
  payload: PermissionRequestPayload | null,
  deps: PermissionDecisionDeps = {}
): PermissionDecision {
  if (!payload) {
    return NO_DECISION('unknown-payload');
  }

  // Before the Auto-Yes check on purpose: this verdict must not depend on
  // whether Auto-Yes happens to be on, so that turning Auto-Yes on can never
  // start approving questions.
  if (payload.toolName === ASK_USER_QUESTION_TOOL) {
    return NO_DECISION('ask-user-question');
  }

  const { worktreeId, cliToolId, instanceId } = session;
  // Returns null for "never enabled" and for expired (it disables on read), so
  // the expiry boundary is the same one the poller sees.
  const state = getAutoYesState(worktreeId, cliToolId, instanceId);
  if (!state?.enabled) {
    return NO_DECISION('auto-yes-disabled');
  }

  const policy = (deps.readPolicy ?? readContractPolicy)({ worktreeId, cliToolId, instanceId });
  const denial = evaluatePolicyAgainstTexts(
    PERMISSION_REQUEST_PROMPT_TYPE,
    // Issue #1902: the third argument is what stops a normalised payload from
    // being judged on its whole body. See `collectToolInputMatchTexts`.
    collectToolInputMatchTexts(payload.toolName, payload.toolInput, payload.toolInputNormalization),
    policy
  );
  if (denial) {
    return {
      behavior: null,
      reason: 'policy-suppressed',
      suppressedBy: denial.reason,
      pattern: denial.pattern,
      mode: policy?.mode ?? null,
    };
  }

  return { behavior: 'allow', reason: 'auto-yes', mode: policy?.mode ?? null };
}

/**
 * Persist an `allow` to the prompt history `capture --prompts` reads
 * (Issue #1685's layer).
 *
 * Only `allow` is written here, and that asymmetry is deliberate. An allowed
 * request never draws a dialog, so this row is the *only* record that anything
 * happened — without it, Auto-Yes v2 approves commands invisibly. Every other
 * verdict ends in the dialog being drawn, where the existing response poller
 * records the prompt exactly as it does today; a second row would double-count
 * the audit trail, and writing it as `pending` would be worse still, because
 * `recordAnsweredPrompt` stamps the newest pending row when the real answer
 * arrives and would attach the human's answer to this synthetic one.
 *
 * A new row is always created rather than reusing `recordAnsweredPrompt`, which
 * looks for a pending row to stamp: on this path there is no dialog, so any
 * pending row it found would belong to a *different*, still-unanswered prompt.
 *
 * Never throws — the verdict has already been decided and the agent is waiting.
 */
function recordAllowedPermission(
  session: PermissionRequestSession,
  payload: PermissionRequestPayload
): void {
  const texts = collectToolInputMatchTexts(
    payload.toolName,
    payload.toolInput,
    payload.toolInputNormalization
  );
  const target = texts.join('\n').slice(0, MAX_DENY_MATCH_TEXT_LENGTH);
  const now = new Date();

  try {
    createMessage(getDbInstance(), {
      worktreeId: session.worktreeId,
      role: 'assistant',
      content: `${payload.toolName}: ${target}`.slice(0, MAX_DENY_MATCH_TEXT_LENGTH),
      // D2: there is no tool_use_id. `prompt_id` + `tool_name` is the
      // correlation key that actually exists in the payload.
      summary: `PermissionRequest allow · tool=${payload.toolName} · prompt_id=${
        payload.promptId ?? 'unknown'
      }`,
      messageType: 'prompt',
      promptData: {
        type: 'multiple_choice',
        question: `Approve ${payload.toolName}?`,
        // Empty on purpose: the hook fires before the dialog exists, so the
        // options Claude would have offered were never rendered. Inventing
        // them would put text in the audit trail that nobody ever saw.
        options: [],
        status: 'answered',
        answer: 'allow',
        answeredAt: now.toISOString(),
        answeredBy: 'auto',
        // Exactly what the deny patterns were judged against (#1699).
        approvalTarget: target,
      },
      timestamp: now,
      cliToolId: session.cliToolId,
      instanceId: session.instanceId,
    });
  } catch (error) {
    logger.warn('permission-request:audit-record-failed', {
      worktreeId: session.worktreeId,
      instanceId: session.instanceId,
      toolName: payload.toolName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Permission modes in which declining to decide does NOT produce a dialog.
 *
 * `bypassPermissions` is Claude's "do not ask me" mode. If the hook fires at
 * all there, a no-decision is answered by the agent itself and no human is ever
 * blocked — so reporting a dialog would make `wait --on-prompt agent` exit 10
 * on a session that is running perfectly well. Whether the hook fires in that
 * mode was NOT measured by the #1721 spike; this guard costs nothing and
 * removes the question.
 */
const NON_BLOCKING_PERMISSION_MODES = new Set(['bypassPermissions']);

/**
 * Tell the detection layer that a dialog is about to be drawn (Issue #1725),
 * but only on a source where that is true (Issue #1901).
 *
 * On Claude a no-decision means precisely this: D5 measured `{}` landing back
 * in the ordinary TUI approval flow, i.e. the dialog appears. That is ~6
 * seconds before `Notification(permission_prompt)` announces the same dialog
 * (§5.5), so it is the earliest moment anything in this system can know a human
 * is needed.
 *
 * It is a prediction rather than an observation, and it is recorded as one:
 * `agent-event-state` expires a `permission-request` record that nothing
 * corroborates within 20 s. See STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS for
 * why the asymmetry with the notification source is deliberate.
 *
 * ## Why the source is asked first (Issue #1901)
 *
 * "Non-allow means a dialog is coming" is *Claude's* semantics, and #1725
 * applied it to every tool that reached this module. copilot fires its
 * `PreToolUse` on **every** tool call and executes most of them straight away
 * — measured: `Read` followed by `PostToolUse` 0–1 s later, no dialog — so a
 * forecast was filed for every `Read` / `Grep` / `Bash` of a build. Each one
 * published `waiting / hook_permission_request` for up to
 * STRUCTURED_PROMPT_PROVISIONAL_MAX_AGE_MS, which made `wait --on-prompt agent`
 * exit 10 on a session nobody was blocking, refused `send` with
 * `blockedBy: 'structured'`, and flashed a WS / push notification per tool call.
 * antigravity is wired the same way.
 *
 * So the forecast is now conditioned on the source's declared
 * {@link AgentSourceCapabilities.permissionHookPredictsDialog} (#1924, §4 D3
 * decision 1; §6.2 names this function). Not a tool-id branch and not
 * `supportedEvents`: the capability block is the whole vocabulary, exactly as
 * `permission-adjudication` reads `permissionReplyReleasesPrompt` (#1898) and
 * `sources/opencode/ingest` reads it for `permission.replied`.
 *
 * **What is given up, and why it is affordable.** On a source that declares
 * `false`, whether a dialog is on the pane goes back to being the scraper's
 * question alone. That premise was re-checked against the detection #1885 /
 * #1886 landed rather than assumed: copilot draws an approval as a box over the
 * bottom of the pane, which takes the status bar and the composer away, so
 * `detectSessionStatus` answers `waiting` / `prompt_detected` /
 * `hasActivePrompt: true` on the live frame
 * (`tests/unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt`).
 * The cost is latency, not blindness: the scraper reads through a 5 s capture
 * cache, so a real copilot dialog is reported up to a poll later than the
 * forecast would have reported it. opencode gives up nothing at all — its
 * approvals arrive as `notification(permission_prompt)` frames, which are
 * observations and open the record through `recordAgentEvent` regardless.
 *
 * `AskUserQuestion` is included on a forecasting source even though this Issue
 * does not claim to detect its screens: it also raises a `PermissionRequest`,
 * and allowing it does not dismiss the picker (§5.6), so a no-decision there is
 * followed by a screen a human must act on just the same. What is NOT claimed
 * is that the state survives — nothing about that screen produces events, so
 * unless the scraper corroborates it the record expires, which is the honest
 * outcome for a screen this layer cannot see. That screen belongs to
 * #1708 / #1726.
 */
function reportPendingDialog(
  session: PermissionRequestSession,
  payload: PermissionRequestPayload | null
): void {
  if (payload?.permissionMode && NON_BLOCKING_PERMISSION_MODES.has(payload.permissionMode)) {
    return;
  }
  // The declared value, read through the registry rather than compared against
  // a tool id. An unregistered tool answers from `sources/legacy-relay`, which
  // declares `false` on purpose (#1924): forecasting a dialog for a permission
  // hook nobody has measured would publish `waiting` for a prompt that may not
  // exist.
  if (!getAgentEventSource(session.cliToolId).capabilities.permissionHookPredictsDialog) {
    logger.debug('permission-request:dialog-forecast-skipped', {
      worktreeId: session.worktreeId,
      cliToolId: session.cliToolId,
      instanceId: session.instanceId,
      toolName: payload?.toolName ?? null,
      reason: 'capability-permissionHookPredictsDialog-false',
    });
    return;
  }
  reportPermissionRequestPending(
    session.worktreeId,
    session.cliToolId,
    session.instanceId,
    payload?.toolName ?? null
  );
}

/**
 * Adjudicate a permission request and record the outcome.
 *
 * @param session - Worktree / tool / instance the request came from
 * @param payload - Parsed payload, or null when it could not be parsed
 * @param deps - Substitutions for the database-backed lookups; see
 *   {@link PermissionDecisionDeps}. Omit in the server.
 * @returns The verdict the route serialises
 */
export function resolvePermissionRequest(
  session: PermissionRequestSession,
  payload: PermissionRequestPayload | null,
  deps: PermissionDecisionDeps = {}
): PermissionDecision {
  const decision = decidePermissionRequest(session, payload, deps);

  // Issue #1902: before anything else, and regardless of the verdict. The
  // adjudicated `tool_input` is not the one copilot sent, and the design
  // policy's discoverability rule (§7) says a rewrite nobody can observe is a
  // rewrite that should not happen. Recording it only on the allow path would
  // hide it on exactly the path an operator investigates — a suppressed edit
  // whose deny pattern was matched against the patch's action headers rather
  // than its body.
  if (payload?.toolInputNormalization) {
    recordToolInputNormalization(
      session.worktreeId,
      session.cliToolId,
      session.instanceId,
      payload.toolInputNormalization,
      payload.toolName
    );
  }

  // Issue #1726: `AskUserQuestion` raises a `PermissionRequest` carrying the
  // same `tool_input` its `PreToolUse` does (§5.6), so the questions are
  // recorded from here too. Redundant on a session this server started — both
  // hooks are injected — and the only source on a session started before the
  // upgrade, whose settings file has no `PreToolUse` entry at all. The two
  // deliveries carry identical content, so the second is a harmless overwrite.
  //
  // This does NOT adjudicate anything: `decidePermissionRequest` still answers
  // no-decision for `AskUserQuestion`, unchanged from #1724, because allowing it
  // does not dismiss the picker.
  if (payload?.toolName === ASK_USER_QUESTION_TOOL) {
    const spec = parseAskUserQuestionPayload({
      tool_name: payload.toolName,
      tool_input: payload.toolInput,
      prompt_id: payload.promptId,
    });
    if (spec) {
      recordAskUserQuestion(session.worktreeId, session.cliToolId, session.instanceId, spec);
    }
  }

  if (decision.behavior !== 'allow') {
    reportPendingDialog(session, payload);
  }

  if (decision.reason === 'policy-suppressed' && decision.suppressedBy) {
    // Issue #1684's record, so `capture --json` can say why the worker is
    // waiting on a dialog it never asked for. Recording it — and NOT denying —
    // is what keeps the meaning of `denyPatterns` unchanged.
    recordPolicySuppression(
      session.worktreeId,
      session.cliToolId,
      session.instanceId,
      {
        reason: decision.suppressedBy,
        mode: decision.mode ?? null,
        promptType: PERMISSION_REQUEST_PROMPT_TYPE,
        pattern: decision.pattern,
      }
    );
    logger.warn('permission-request:suppressed-by-policy', {
      worktreeId: session.worktreeId,
      cliToolId: session.cliToolId,
      instanceId: session.instanceId,
      toolName: payload?.toolName,
      promptId: payload?.promptId,
      reason: decision.suppressedBy,
      mode: decision.mode ?? null,
      pattern: decision.pattern,
    });
  }

  if (decision.behavior === 'allow' && payload) {
    (deps.recordAllow ?? recordAllowedPermission)(session, payload);
  }

  return decision;
}
