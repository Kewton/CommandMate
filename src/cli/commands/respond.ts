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
import { ApiClient, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { isCliToolId } from '../config/cli-tool-ids';

export function createRespondCommand(): Command {
  const cmd = new Command('respond');
  cmd
    .description("Respond to an agent's prompt (yes/no, number, or text)")
    .argument('<worktree-id>', 'Worktree ID')
    .argument('<answer>', 'Response answer (yes, no, number, or free text)')
    .option('--agent <agent>', 'CLI tool agent (claude, codex, gemini, vibe-local, opencode)')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, answer: string, options: RespondOptions) => {
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

        // Validate answer is not empty
        if (!answer.trim()) {
          console.error('Error: Answer cannot be empty.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token: options.token });

        // [DR2-06] Use prompt-response API with cliTool (not cliToolId)
        const body: Record<string, unknown> = { answer };
        if (options.agent) {
          body.cliTool = options.agent;
        }

        const result = await client.post<PromptResponseResult>(
          `/api/worktrees/${worktreeId}/prompt-response`,
          body
        );

        if (result && !result.success) {
          // [DR2-06] Check reason for failure
          const reason = result.reason || 'unknown';
          console.error(`Warning: Response may not have been applied. Reason: ${reason}`);
          process.exit(ExitCode.UNEXPECTED_ERROR);
        }

        console.error('Response sent.');
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
