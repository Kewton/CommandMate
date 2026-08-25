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
import { ApiClient, ApiError, isValidWorktreeId, isValidInstanceId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { isCliToolId } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import { resolveInstanceCliTool } from './instances';

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

export function createRespondCommand(): Command {
  const cmd = new Command('respond');
  cmd
    .description("Respond to an agent's prompt (yes/no, number, or text)")
    .argument('<worktree-id>', 'Worktree ID')
    .argument('[answer]', 'Response answer (yes, no, number, or free text)')
    .option('--default', "Select the prompt's default option (mutually exclusive with <answer>)")
    .option('--instance <id>', INSTANCE_OPTION_DESCRIPTION)
    .option('--agent <agent>', AGENT_OPTION_DESCRIPTION)
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, answer: string | undefined, options: RespondOptions) => {
      try {
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

        // Issue #868: Validate instance ID if provided
        if (options.instance && !isValidInstanceId(options.instance)) {
          console.error('Error: Invalid --instance. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #1681: exactly one of <answer> / --default
        const useDefault = options.default === true;
        if (useDefault && answer !== undefined) {
          console.error('Error: <answer> and --default are mutually exclusive.');
          process.exit(ExitCode.CONFIG_ERROR);
        }
        if (!useDefault && (answer === undefined || !answer.trim())) {
          console.error('Error: Answer cannot be empty. Provide an answer or --default.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token: options.token });

        // Issue #1629: /prompt-response derives the session name from cliTool
        // and falls back to the worktree default, so `--instance codex` alone
        // answered into a session that was never started. Resolve the tool the
        // instance is registered under first.
        const agent = options.instance
          ? await resolveInstanceCliTool(client, worktreeId, options.instance, options.agent)
          : options.agent;

        // [DR2-06] Use prompt-response API with cliTool (not cliToolId)
        const body: Record<string, unknown> = useDefault ? { useDefault: true } : { answer };
        if (agent) {
          body.cliTool = agent;
        }
        // Issue #868: target a specific agent instance
        if (options.instance) {
          body.instanceId = options.instance;
        }

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
        const structured =
          !useDefault && (await addressesDecisionsById(client, worktreeId, agent, options.instance));

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
          // [DR2-06] Check reason for failure
          const reason = result.reason || 'unknown';
          // Issue #1681 / #1726: these two mean the server refused BEFORE
          // sending, so the terminal is untouched — worth saying plainly,
          // because the other reasons leave the answer's fate unknown.
          const refusedBeforeSending =
            reason === 'unresolvable_answer' || reason === 'answer_out_of_range';
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
          } else {
            console.error(`Warning: Response may not have been applied. Reason: ${reason}`);
          }
          // Issue #1726: an option number the agent's own payload does not offer
          // is a bad argument, so it exits with the input-error code the rest of
          // this command already uses for a malformed worktree id or agent.
          process.exit(
            reason === 'answer_out_of_range' ? ExitCode.CONFIG_ERROR : ExitCode.UNEXPECTED_ERROR
          );
        }

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

        console.error('Response sent.');
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
