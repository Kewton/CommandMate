/**
 * respond Command - Respond to an agent's prompt
 * Issue #518: [DR1-08] Factory pattern
 *
 * Uses prompt-response API (not respond API) [DR2-06]
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { RespondOptions } from '../types';
import type {
  CurrentOutputResponse,
  PromptResponseResult,
  StructuredDecisionResult,
} from '../types/api-responses';
import { ApiClient, ApiError, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { isCliToolId } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import {
  isInstanceSelector,
  INSTANCE_ALIAS_HELP_SUFFIX,
  INSTANCE_SELECTOR_ERROR,
  resolveInstanceTarget,
} from './instances';

/**
 * Whether this instance's agent can be answered by naming a decision
 * (Issue #2040).
 *
 * The declared capability, read off the server, never inferred from a tool id —
 * §4 D3 of `docs/design/multi-agent-state-architecture.md` puts every such
 * property on the source so exactly this kind of caller does not have to keep a
 * list. `eventIdentity` non-null means the agent publishes a per-decision id,
 * which is what makes an option number a VERDICT that can be POSTed rather than
 * a key that has to be typed.
 *
 * One extra GET, on a command a human or an orchestrator runs once per dialog —
 * not in a poll loop. It buys the thing the probe is for: `respond` never sends
 * a side-effecting request to the endpoint that cannot serve it.
 *
 * **Fail-open, on every failure.** An older daemon (no `structuredEvents`), a
 * server that is not reachable, a worktree that does not exist: all of them
 * answer false, which is the pre-#2040 path, byte for byte. The real request is
 * a step away and will report the same failure properly.
 *
 * @param agent - The resolved CLI tool, when the caller named or resolved one
 * @param instance - `--instance`, when the caller gave one
 */
async function addressesDecisionsById(
  client: ApiClient,
  worktreeId: string,
  agent: string | undefined,
  instance: string | undefined,
): Promise<boolean> {
  const query = new URLSearchParams();
  if (agent) query.set('cliTool', agent);
  if (instance) query.set('instance', instance);
  const suffix = query.toString();
  try {
    const output = await client.get<CurrentOutputResponse>(
      `/api/worktrees/${worktreeId}/current-output${suffix ? `?${suffix}` : ''}`,
    );
    return output.structuredEvents?.source?.capabilities?.eventIdentity != null;
  } catch {
    return false;
  }
}

/**
 * One entry of the 409 body's `decisions` list, as much as is printed.
 *
 * Read defensively out of {@link ApiError.payload} rather than typed on it:
 * `ApiErrorPayload` describes every route's error body and this list belongs to
 * one, so a narrowing here is cheaper than a field five other commands would
 * have to ignore.
 */
interface AmbiguousDecision {
  id: string;
  kind: string;
  toolName: string | null;
}

function readAmbiguousDecisions(payload: unknown): AmbiguousDecision[] {
  const list = (payload as { decisions?: unknown } | undefined)?.decisions;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { id, kind, toolName } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || typeof kind !== 'string') return [];
    return [{ id, kind, toolName: typeof toolName === 'string' ? toolName : null }];
  });
}

/**
 * Answer the one decision this instance is holding (Issue #2040).
 *
 * `POST /api/worktrees/:id/respond` with neither `messageId` nor `decisionId`.
 * Nothing is typed at the pane on this path — the verdict, or the question's
 * chosen label, goes to the agent's own API — which is why every refusal below
 * can say plainly that the terminal is untouched.
 *
 * @returns The server's answer; `'fallback'` when the server says this target
 *   has no addressable decision after all (see below); or null when this
 *   function has already reported a refusal and set the exit code
 */
async function answerSolePendingDecision(
  client: ApiClient,
  worktreeId: string,
  body: Record<string, unknown>,
): Promise<StructuredDecisionResult | 'fallback' | null> {
  try {
    return await client.post<StructuredDecisionResult>(
      `/api/worktrees/${worktreeId}/respond`,
      body,
    );
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;

    if (error.apiCode === 'decision_not_found') {
      console.error(
        'Error: Answer was not sent. Reason: decision_not_found ' +
          '(this agent instance is not waiting on an approval or a question).',
      );
      process.exit(ExitCode.UNEXPECTED_ERROR);
      return null;
    }
    if (error.apiCode === 'multiple_pending_decisions') {
      const decisions = readAmbiguousDecisions(error.payload);
      console.error(
        `Error: Answer was not sent. Reason: multiple_pending_decisions ` +
          `(${decisions.length || 'several'} are open, and an option number names a ` +
          'position in one of them). Answer them in the terminal, or one at a time by id.',
      );
      // The ids are what `{ decisionId, answer }` takes, so the refusal has
      // somewhere to go rather than being a dead end.
      for (const decision of decisions) {
        console.error(`  ${decision.id}  ${decision.kind}${decision.toolName ? `  ${decision.toolName}` : ''}`);
      }
      process.exit(ExitCode.UNEXPECTED_ERROR);
      return null;
    }
    if (error.apiCode === 'decision_source_unaddressable') {
      // The probe and this POST disagreed about which agent the target resolves
      // to — a roster edit between the two requests does it. The server's own
      // instruction for this code is "answer it through /prompt-response", so
      // that is what happens, rather than failing a `respond` over a race.
      return 'fallback';
    }
    if (error.apiCode === 'answer_out_of_range') {
      // Issue #1726's rule, unchanged: a number the agent's own list does not
      // offer is a bad argument, and nothing was sent.
      console.error(
        `Error: Answer was not sent. Reason: answer_out_of_range${error.payload?.error ? ` (${error.payload.error})` : ''}`,
      );
      process.exit(ExitCode.CONFIG_ERROR);
      return null;
    }
    throw error;
  }
}

/** Reason `/prompt-response` gives when no dialog is on screen any more. */
const PROMPT_NO_LONGER_ACTIVE = 'prompt_no_longer_active';

/**
 * Issue #3125: what `--plan-review` takes. Restated rather than imported from
 * `src/lib` (the CLI build does not reach it); the server validates the same set.
 */
const PLAN_REVIEW_ACTIONS = ['comment', 'submit', 'approve', 'cancel'] as const;

/** Reasons the server gives for a plan review answer it refused before any key. */
function isPlanReviewRefusal(reason: string): boolean {
  return reason.startsWith('plan_review_');
}

/** ` --instance <id>` as the caller spelled it, or nothing. */
function instanceFlag(instance: string | undefined): string {
  return instance ? ` --instance ${instance}` : '';
}

/**
 * `textFollowUp` from a `/prompt-response` success (Issue #3093), read
 * defensively: an older server omits it, and the route's mirror type is not
 * this command's to widen.
 */
function readTextFollowUp(result: unknown): { optionNumber: number; optionLabel: string } | null {
  const value = (result as { textFollowUp?: unknown } | null | undefined)?.textFollowUp;
  if (typeof value !== 'object' || value === null) return null;
  const { optionNumber, optionLabel } = value as Record<string, unknown>;
  if (typeof optionNumber !== 'number' || typeof optionLabel !== 'string') return null;
  return { optionNumber, optionLabel };
}

/** Argument checks; returns whether --default was chosen. A mocked `process.exit` returns, so nothing here stops early. */
function validateRespondArgs(worktreeId: string, answer: string | undefined, options: RespondOptions): boolean {
  // [SEC4-04] Validate worktree ID
  if (!isValidWorktreeId(worktreeId)) {
    console.error('Error: Invalid worktree ID format.');
    process.exit(ExitCode.CONFIG_ERROR);
  }

  // Validate agent if provided
  if (options.agent && !isCliToolId(options.agent)) {
    console.error('Error: Invalid agent.');
    process.exit(ExitCode.CONFIG_ERROR);
  }

  // Issue #868 / #2376: an instance id or a roster alias.
  if (options.instance && !isInstanceSelector(options.instance)) {
    console.error(INSTANCE_SELECTOR_ERROR);
    process.exit(ExitCode.CONFIG_ERROR);
  }

  // Issue #1681: exactly one of <answer> / --default
  const useDefault = options.default === true;

  // Issue #3125: Command Code's plan review. `approve` / `cancel` take no text,
  // `comment` needs it, and `submit` takes an optional comment to send first.
  const planReview = options.planReview;
  if (planReview !== undefined) {
    if (!(PLAN_REVIEW_ACTIONS as readonly string[]).includes(planReview)) {
      console.error(`Error: --plan-review must be one of: ${PLAN_REVIEW_ACTIONS.join(', ')}.`);
      process.exit(ExitCode.CONFIG_ERROR);
    }
    if (useDefault) {
      console.error('Error: --plan-review and --default are mutually exclusive.');
      process.exit(ExitCode.CONFIG_ERROR);
    }
    if ((planReview === 'approve' || planReview === 'cancel') && answer !== undefined) {
      console.error(`Error: --plan-review ${planReview} takes no <answer>.`);
      process.exit(ExitCode.CONFIG_ERROR);
    }
    if (planReview === 'comment' && (answer === undefined || !answer.trim())) {
      console.error('Error: --plan-review comment needs the comment text as <answer>.');
      process.exit(ExitCode.CONFIG_ERROR);
    }
    return false;
  }

  if (useDefault && answer !== undefined) {
    console.error('Error: <answer> and --default are mutually exclusive.');
    process.exit(ExitCode.CONFIG_ERROR);
  }
  if (!useDefault && (answer === undefined || !answer.trim())) {
    console.error('Error: Answer cannot be empty. Provide an answer or --default.');
    process.exit(ExitCode.CONFIG_ERROR);
  }
  return useDefault;
}

/** The `/prompt-response` request body. */
function buildPromptResponseBody(
  useDefault: boolean,
  answer: string | undefined,
  agent: string | undefined,
  instanceId: string | undefined,
  planReview?: string,
): Record<string, unknown> {
  // [DR2-06] Use prompt-response API with cliTool (not cliToolId)
  const body: Record<string, unknown> = useDefault ? { useDefault: true } : { answer };
  // Issue #3125: Command Code's plan review action.
  if (planReview !== undefined) {
    body.planReviewAction = planReview;
  }
  if (agent) {
    body.cliTool = agent;
  }
  // Issue #868: target a specific agent instance
  if (instanceId) {
    body.instanceId = instanceId;
  }
  return body;
}

/** Reports a `success: false` result and sets the exit code. */
function reportFailedResponse(
  result: PromptResponseResult | StructuredDecisionResult,
  worktreeId: string,
  answer: string | undefined,
  useDefault: boolean,
  options: RespondOptions,
): void {
  // [DR2-06] Check reason for failure
  const reason = result.reason || 'unknown';
  // Issue #1681 / #1726: these mean the server refused BEFORE sending,
  // so the terminal is untouched — worth saying plainly, because the
  // other reasons leave the answer's fate unknown. Issue #2486 adds
  // `unsupported_dialog_layout`: a picker IS on screen but its layout
  // could not be verified, and the server's message says what to do.
  // Issue #3125 adds the `plan_review_*` refusals: the plan review overlay was
  // read and the request did not fit its current focus, so nothing was typed.
  const refusedBeforeSending =
    reason === 'unresolvable_answer' ||
    reason === 'answer_out_of_range' ||
    reason === 'unsupported_dialog_layout' ||
    isPlanReviewRefusal(reason);
  // Issue #1898: the verdict was addressed to the agent's own API and
  // the POST did not land. Distinct from the two above — the answer was
  // resolved and an attempt was made — and distinct from a keystroke,
  // whose fate is never knowable.
  if (reason === 'decision_not_delivered') {
    console.error(
      `Error: The approval could not be delivered to the agent (reason: ${reason}). ` +
        'The dialog is still open; answer it in the terminal.',
    );
    process.exit(ExitCode.UNEXPECTED_ERROR);
  }
  if (refusedBeforeSending) {
    console.error(`Error: Answer was not sent. Reason: ${reason}${result.message ? ` (${result.message})` : ''}`);
    // Issue #2583: the operator who lands here typed WORDS at a dialog
    // that only takes a choice — a claude / agy Bash approval refused as
    // free text, or #2573's "No, tell … what to do differently" row. The
    // server's sentence ends with "answer with the option number", and
    // this is that command with the ids already filled in, so the next
    // step is a paste rather than a trip to the docs while a dialog sits
    // open. Printed only for the reason that means "this answer could not
    // be mapped onto a choice", and only when the answer was not already
    // a number (where the number itself is what was wrong).
    if (reason === 'unresolvable_answer' && answer !== undefined && !/^\d+$/.test(answer.trim())) {
      const target = options.instance ? ` --instance ${options.instance}` : '';
      console.error(
        `Hint: answer with the option number — \`commandmate respond ${worktreeId} <number>${target}\` ` +
          `(\`commandmate capture ${worktreeId}${target}\` prints the dialog and its numbers).`,
      );
    }
  } else {
    console.error(`Warning: Response may not have been applied. Reason: ${reason}`);
    // Issue #3093: the usual way here is the second half of a "No, tell
    // … what to do differently" answer — the row closed the dialog and
    // the agent is waiting for the reason in its input box, which
    // `respond` (dialogs only) cannot reach and `send` can.
    if (reason === PROMPT_NO_LONGER_ACTIVE && !useDefault && answer !== undefined && !/^\d+$/.test(answer.trim())) {
      console.error(
        'Hint: no dialog is open, so this text was not delivered. If you just chose an option that asks ' +
          'for text (e.g. "No, tell … what to do differently"), the agent is waiting for it in its input box — ' +
          `send it with \`commandmate send ${worktreeId} "<text>"${instanceFlag(options.instance)}\`.`,
      );
    }
  }
  // Issue #1726: an option number the agent's own payload does not offer
  // is a bad argument, so it exits with the input-error code the rest of
  // this command already uses for a malformed worktree id or agent.
  process.exit(
    reason === 'answer_out_of_range' ? ExitCode.CONFIG_ERROR : ExitCode.UNEXPECTED_ERROR
  );
}

/**
 * What was done on Command Code's plan review (Issue #3125), and the next step:
 * a pinned comment is not delivered to the agent until the review is submitted.
 */
function printPlanReviewOutcome(result: PromptResponseResult, worktreeId: string, options: RespondOptions): void {
  const planReview = result.planReview;
  if (!planReview) return;
  const target = instanceFlag(options.instance);
  switch (planReview.action) {
    case 'comment':
      console.log(`Plan review: pinned comment "${planReview.comment ?? ''}".`);
      console.error(
        `Next: send the review with \`commandmate respond ${worktreeId} --plan-review submit${target}\` ` +
          `(ctrl+r), or approve with \`--plan-review approve\` (comments go along as notes).`,
      );
      break;
    case 'submit':
      console.log(
        planReview.comment
          ? `Plan review: pinned comment "${planReview.comment}" and submitted the review (ctrl+r).`
          : 'Plan review: submitted the review (ctrl+r).',
      );
      break;
    case 'approve':
      if (planReview.phase === 'approve-choice') {
        console.log(
          `Plan review: confirmed the approval (${planReview.approveChoice === 'discard-comments' ? 'discarding' : 'with'} the pending comments).`,
        );
      } else {
        console.log('Plan review: approved the plan (ctrl+a).');
        if (planReview.pendingCommentsBefore > 0) {
          console.error(
            'Note: with pending comments Command Code may ask how to approve — confirm with ' +
              `\`commandmate respond ${worktreeId} --plan-review approve${target}\` again, or go back with \`--plan-review cancel\`.`,
          );
        }
      }
      break;
    case 'cancel':
      console.log(
        planReview.phase === 'approve-choice'
          ? 'Plan review: went back from the approval choice (esc).'
          : 'Plan review: cancelled the plan (esc).',
      );
      if (planReview.phase !== 'approve-choice' && planReview.pendingCommentsBefore > 0) {
        console.error(`Note: ${planReview.pendingCommentsBefore} pending comment(s) were discarded with it.`);
      }
      break;
  }
}

/** Audit trail of which option was actually selected. */
function printResolvedAudit(result: PromptResponseResult | StructuredDecisionResult | null, answer: string | undefined): void {
  // Issue #1681: audit trail — print which option was actually selected.
  const resolved = result?.resolved;
  if (resolved) {
    if (resolved.via === 'structured-decision') {
      // Issue #1898: no key was sent. The verdict went to the agent's own
      // API by decision id, which is the only way an opencode approval can
      // be answered at all — worth saying, because "Response sent." on
      // this path would read as "a 1 was typed into the pane".
      console.log(
        `Answered approval ${resolved.decisionId ?? '(unknown id)'} with ` +
          `option ${resolved.optionNumber}: ${resolved.optionLabel}`,
      );
    } else if (resolved.via === 'structured-question') {
      // Issue #2040: a question, answered over `POST /question/:id/reply`.
      // What is printed is what reached the AGENT — the labels — rather
      // than the number that was typed: `respond <id> 2` at a question is
      // a position in the agent's own list, and an operator reconciling
      // what they meant against what was sent needs the other end of that
      // mapping. `freeText` prints the text for the same reason.
      const chosen = resolved.optionLabels ?? [];
      console.log(
        `Answered question ${resolved.decisionId ?? '(unknown id)'} with ` +
          (chosen.length > 0
            ? chosen.map((label, index) => `${resolved.optionNumbers?.[index] ?? '?'}: ${label}`).join(', ')
            : `free text: ${(resolved.answers?.[0] ?? []).join(', ')}`),
      );
    } else if (resolved.via === 'semantic') {
      console.log(`Resolved "${answer}" to option ${resolved.optionNumber}: ${resolved.optionLabel}`);
    } else if (resolved.optionNumber !== undefined) {
      console.log(`Selected default option ${resolved.optionNumber}: ${resolved.optionLabel}`);
    } else {
      console.log(`Selected default answer: ${resolved.optionLabel}`);
    }
  }
}

export function createRespondCommand(): Command {
  const cmd = new Command('respond');
  cmd
    .description("Respond to an agent's prompt (yes/no, number, or text)")
    .argument('<worktree-id>', 'Worktree ID')
    .argument('[answer]', 'Response answer (yes, no, number, or free text)')
    .option('--default', "Select the prompt's default option (mutually exclusive with <answer>)")
    .option(
      '--plan-review <action>',
      'Command Code plan review: comment | submit | approve | cancel ' +
        '(text alone is a comment; submit takes an optional comment; approve/cancel take no <answer>)',
    )
    .option('--instance <id>', `${INSTANCE_OPTION_DESCRIPTION} ${INSTANCE_ALIAS_HELP_SUFFIX}`)
    .option('--agent <agent>', AGENT_OPTION_DESCRIPTION)
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, answer: string | undefined, options: RespondOptions) => {
      try {
        const useDefault = validateRespondArgs(worktreeId, answer, options);

        const client = new ApiClient({ token: options.token });

        // Issue #1629: /prompt-response derives the session name from cliTool
        // and falls back to the worktree default, so `--instance codex` alone
        // answered into a session that was never started. Resolve the tool the
        // instance is registered under first.
        const target = options.instance
          ? await resolveInstanceTarget(client, worktreeId, options.instance, options.agent)
          : null;
        const agent = target ? target.cliToolId : options.agent;
        // Issue #2376: the resolved id. /prompt-response reads instance ids.
        const instanceId = target?.instanceId;

        const body = buildPromptResponseBody(useDefault, answer, agent, instanceId, options.planReview);

        // Issue #2040: for an agent that publishes per-decision ids (opencode
        // today, and only opencode), a bare `respond <worktree> 3` names the ONE
        // decision that agent is holding, and the number is resolved against
        // THAT decision's own options — the three verdicts for an approval, the
        // published choices for a question. Nothing is typed at the pane, and
        // nothing is sent at all unless the count is exactly one.
        //
        // `--default` deliberately stays on the keystroke route. There is a
        // highlighted option in the TUI and nothing on the wire says which, so
        // the structured path refuses it (`answerStructuredDecision` says so in
        // as many words) — while Enter at a `keys` dialog is a real answer that
        // this command has always been able to give.
        //
        // Issue #3125: a plan review action names no decision, so it skips this.
        const structured =
          !useDefault &&
          options.planReview === undefined &&
          (await addressesDecisionsById(client, worktreeId, agent, instanceId));

        let result: PromptResponseResult | StructuredDecisionResult | null = null;
        if (structured) {
          const outcome = await answerSolePendingDecision(client, worktreeId, body);
          // Null means the refusal has already been reported and the exit code
          // set; a mocked `process.exit` returns, so this is the line that keeps
          // the reporting below from running on nothing.
          if (outcome === null) return;
          if (outcome !== 'fallback') result = outcome;
        }
        if (result === null) {
          result = await client.post<PromptResponseResult>(
            `/api/worktrees/${worktreeId}/prompt-response`,
            body
          );
        }

        if (result && !result.success) {
          reportFailedResponse(result, worktreeId, answer, useDefault, options);
        }

        printResolvedAudit(result, answer);
        if (result && 'planReview' in result) printPlanReviewOutcome(result, worktreeId, options);

        console.error('Response sent.');

        // Issue #3093: the option just chosen continues as typed text, which the
        // dialog no longer takes — name the command that does deliver it.
        const followUp = readTextFollowUp(result);
        if (followUp) {
          console.error(
            `Next: option ${followUp.optionNumber} ("${followUp.optionLabel}") asks for your text, and the dialog ` +
              'is closed now, so `respond` cannot deliver it — send it with ' +
              `\`commandmate send ${worktreeId} "<text>"${instanceFlag(options.instance)}\`.`,
          );
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
