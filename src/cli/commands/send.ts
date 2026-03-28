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

export function createSendCommand(): Command {
  const cmd = new Command('send');
  cmd
    .description('Send a message to a worktree agent')
    .argument('<worktree-id>', 'Worktree ID')
    .argument('<message>', 'Message to send')
    .option('--agent <agent>', 'CLI tool agent (claude, codex, gemini, vibe-local, opencode, copilot)')
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

        const client = new ApiClient({ token: options.token });

        // --auto-yes: enable auto-yes first [DR2-02]
        if (options.autoYes) {
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

        // [DR2-05] Send API uses "content" not "message"
        const sendBody: Record<string, unknown> = { content: message };
        if (options.agent) {
          sendBody.cliToolId = options.agent;
        }

        await client.post<ChatMessage>(`/api/worktrees/${worktreeId}/send`, sendBody);
        console.error('Message sent.');
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
