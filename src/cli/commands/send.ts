/**
 * send Command - Send a message to a worktree agent
 * Issue #518: [DR1-08] Factory pattern
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { SendOptions } from '../types';
import type { ChatMessage } from '../types/api-responses';
import { ApiClient, isValidWorktreeId, MAX_STOP_PATTERN_LENGTH } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { parseDurationToMs, ALLOWED_DURATIONS } from '../config/duration-constants';
import { isCliToolId, CLI_TOOL_IDS } from '../config/cli-tool-ids';
import { validateCopilotModelName } from '../config/model-validation';

/**
 * Build auto-yes request body and send it to the API (DRY extraction).
 * Validates duration and exits on invalid input.
 *
 * @param client - API client instance
 * @param worktreeId - Target worktree ID
 * @param options - Send command options containing auto-yes settings
 */
async function enableAutoYes(
  client: ApiClient,
  worktreeId: string,
  options: SendOptions
): Promise<void> {
  const durationMs = options.duration
    ? parseDurationToMs(options.duration)
    : parseDurationToMs('1h'); // default 1h

  if (durationMs === null) {
    console.error(`Error: Invalid duration. Must be one of: ${ALLOWED_DURATIONS.join(', ')}`);
    process.exit(ExitCode.CONFIG_ERROR);
  }

  const autoYesBody: Record<string, unknown> = {
    enabled: true,
    duration: durationMs,
  };
  if (options.agent) {
    autoYesBody.cliToolId = options.agent;
  }
  if (options.stopPattern) {
    autoYesBody.stopPattern = options.stopPattern;
  }

  await client.post<void>(`/api/worktrees/${worktreeId}/auto-yes`, autoYesBody);
  console.error('Auto-yes enabled.');
}

export function createSendCommand(): Command {
  const cmd = new Command('send');
  cmd
    .description('Send a message to a worktree agent')
    .argument('<worktree-id>', 'Worktree ID')
    .argument('<message>', 'Message to send')
    .option('--agent <agent>', 'CLI tool agent (claude, codex, gemini, vibe-local, opencode, copilot)')
    .option('--model <model>', 'Specify AI model for Copilot agent')
    .option('--auto-yes', 'Enable auto-yes before sending')
    .option('--duration <duration>', `Auto-yes duration (${ALLOWED_DURATIONS.join(', ')})`)
    .option('--stop-pattern <pattern>', 'Auto-yes stop pattern (regex)')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, message: string, options: SendOptions) => {
      try {
        // [SEC4-04] Validate worktree ID
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Validate agent if provided
        if (options.agent && !isCliToolId(options.agent)) {
          console.error(`Error: Invalid agent. Must be one of: ${CLI_TOOL_IDS.join(', ')}`);
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // [SEC4-06] Validate stop-pattern length
        if (options.stopPattern && options.stopPattern.length > MAX_STOP_PATTERN_LENGTH) {
          console.error(`Error: stop-pattern exceeds maximum length of ${MAX_STOP_PATTERN_LENGTH} characters.`);
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #576/#588: Validate --model option via shared validator (DR1-003)
        if (options.model) {
          // --model requires --agent copilot
          if (!options.agent || options.agent !== 'copilot') {
            console.error('Error: --model option requires --agent copilot');
            process.exit(ExitCode.CONFIG_ERROR);
          }
          const modelValidation = validateCopilotModelName(options.model);
          if (!modelValidation.valid) {
            console.error(`Error: Invalid model name: ${modelValidation.reason}`);
            process.exit(ExitCode.CONFIG_ERROR);
          }
        }

        const client = new ApiClient({ token: options.token });

        // --auto-yes: enable auto-yes first (unless --model is specified, then after send) [DR2-02]
        if (options.autoYes && !options.model) {
          await enableAutoYes(client, worktreeId, options);
        }

        // [DR2-05] Send API uses "content" not "message"
        const sendBody: Record<string, unknown> = { content: message };
        if (options.agent) {
          sendBody.cliToolId = options.agent;
        }
        // Issue #576: Include model in send body
        if (options.model) {
          sendBody.model = options.model;
        }

        await client.post<ChatMessage>(`/api/worktrees/${worktreeId}/send`, sendBody);
        console.error('Message sent.');

        // Issue #576: Enable auto-yes AFTER send when --model is specified
        // This avoids auto-yes interfering with the /model command interaction
        if (options.autoYes && options.model) {
          await enableAutoYes(client, worktreeId, options);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
