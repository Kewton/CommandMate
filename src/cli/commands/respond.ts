/**
 * respond Command - Respond to an agent's prompt
 * Issue #518: [DR1-08] Factory pattern
 *
 * Uses prompt-response API (not respond API) [DR2-06]
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { RespondOptions } from '../types';
import type { PromptResponseResult } from '../types/api-responses';
import { ApiClient, isValidWorktreeId, isValidInstanceId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { isCliToolId } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import { resolveInstanceCliTool } from './instances';

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

        const result = await client.post<PromptResponseResult>(
          `/api/worktrees/${worktreeId}/prompt-response`,
          body
        );

        if (result && !result.success) {
          // [DR2-06] Check reason for failure
          const reason = result.reason || 'unknown';
          // Issue #1681 / #1726: these two mean the server refused BEFORE
          // sending, so the terminal is untouched — worth saying plainly,
          // because the other reasons leave the answer's fate unknown.
          const refusedBeforeSending =
            reason === 'unresolvable_answer' || reason === 'answer_out_of_range';
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
          if (resolved.via === 'semantic') {
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
