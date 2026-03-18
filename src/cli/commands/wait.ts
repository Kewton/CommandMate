/**
 * wait Command - Block until agent completion or prompt detection
 * Issue #518: [DR1-08] Factory pattern
 *
 * Exit codes [DR1-03]:
 * - 0: SUCCESS (agent completed)
 * - 10: PROMPT_DETECTED (agent waiting for user input)
 * - 124: TIMEOUT (--timeout exceeded)
 * Infrastructure errors use ExitCode (1, 2, 99)
 */

import { Command } from 'commander';
import { ExitCode, WaitExitCode } from '../types';
import type { WaitOptions } from '../types';
import type { CurrentOutputResponse, WaitPromptOutput } from '../types/api-responses';
import { ApiClient, ApiError, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';

/** [IA3-02] Polling interval 5 seconds (matches tmux-capture-cache TTL=2s) */
const POLL_INTERVAL_MS = 5000;

/**
 * Poll a single worktree until completion, prompt, or timeout.
 */
async function pollWorktree(
  client: ApiClient,
  worktreeId: string,
  options: WaitOptions,
): Promise<{ exitCode: number; output?: WaitPromptOutput }> {
  const startTime = Date.now();
  let lastActivityTime = Date.now();
  let lastContent = '';

  while (true) {
    // Check timeout
    if (options.timeout) {
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed >= options.timeout) {
        console.error(`Timeout: ${worktreeId} exceeded ${options.timeout}s`);
        return { exitCode: WaitExitCode.TIMEOUT };
      }
    }

    // Check stall-timeout
    if (options.stallTimeout) {
      const stallElapsed = (Date.now() - lastActivityTime) / 1000;
      if (stallElapsed >= options.stallTimeout) {
        console.error(`Stall timeout: ${worktreeId} no output for ${options.stallTimeout}s`);
        return { exitCode: WaitExitCode.TIMEOUT };
      }
    }

    try {
      const data = await client.get<CurrentOutputResponse>(
        `/api/worktrees/${worktreeId}/current-output`
      );

      // Track content changes for stall detection
      if (data.content !== lastContent) {
        lastContent = data.content;
        lastActivityTime = Date.now();
      }

      // Prompt detected
      if (data.isPromptWaiting && data.promptData) {
        // [DR1-03] Prompt detection exit code
        if (options.onPrompt === 'human') {
          // Block and continue polling - user handles prompt manually
          console.error(`Prompt detected on ${worktreeId}. Waiting for human response...`);
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        // Default (agent mode): output prompt info and exit 10
        const promptOutput: WaitPromptOutput = {
          worktreeId,
          cliToolId: data.cliToolId || 'claude',
          type: data.promptData.type || 'unknown',
          question: data.promptData.question || '',
          options: (data.promptData.options as unknown[]) || [],
          status: data.promptData.status || 'pending',
        };

        return { exitCode: WaitExitCode.PROMPT_DETECTED, output: promptOutput };
      }

      // Completion check: isRunning===false && isPromptWaiting===false
      if (!data.isRunning && !data.isPromptWaiting) {
        console.error(`Completed: ${worktreeId}`);
        return { exitCode: WaitExitCode.SUCCESS };
      }

      // Progress indicator on stderr
      console.error(`Waiting: ${worktreeId} (running=${data.isRunning}, prompt=${data.isPromptWaiting})`);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      console.error(`Poll error for ${worktreeId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createWaitCommand(): Command {
  const cmd = new Command('wait');
  cmd
    .description('Wait for agent completion (1 worktree per CLI instance recommended)')
    .argument('<worktree-ids...>', 'Worktree ID(s) to wait on')
    .option('--timeout <seconds>', 'Maximum wait time in seconds', parseInt)
    .option('--on-prompt <mode>', 'Prompt handling: agent (default) or human')
    .option('--stall-timeout <seconds>', 'Maximum time without output change', parseInt)
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeIds: string[], options: WaitOptions) => {
      try {
        // [SEC4-04] Validate all worktree IDs
        for (const id of worktreeIds) {
          if (!isValidWorktreeId(id)) {
            console.error(`Error: Invalid worktree ID format: ${id}`);
            process.exit(ExitCode.CONFIG_ERROR);
          }
        }

        const client = new ApiClient({ token: options.token });

        if (worktreeIds.length === 1) {
          // Single worktree
          const result = await pollWorktree(client, worktreeIds[0], options);
          if (result.output) {
            // stdout for result (JSON output)
            console.log(JSON.stringify(result.output));
          }
          process.exit(result.exitCode);
        }

        // [DR1-07] Multiple worktrees: Promise.allSettled for error isolation
        const results = await Promise.allSettled(
          worktreeIds.map(id => pollWorktree(client, id, options))
        );

        // Collect results
        const outputs: WaitPromptOutput[] = [];
        let finalExitCode: number = WaitExitCode.SUCCESS;

        for (const result of results) {
          if (result.status === 'fulfilled') {
            if (result.value.output) {
              outputs.push(result.value.output);
            }
            if (result.value.exitCode === WaitExitCode.PROMPT_DETECTED) {
              finalExitCode = WaitExitCode.PROMPT_DETECTED;
            } else if (result.value.exitCode !== WaitExitCode.SUCCESS && finalExitCode === WaitExitCode.SUCCESS) {
              finalExitCode = result.value.exitCode;
            }
          } else {
            const err = result.reason;
            if (err instanceof ApiError && finalExitCode === WaitExitCode.SUCCESS) {
              finalExitCode = err.exitCode;
            } else if (finalExitCode === WaitExitCode.SUCCESS) {
              finalExitCode = ExitCode.UNEXPECTED_ERROR;
            }
          }
        }

        if (outputs.length > 0) {
          console.log(JSON.stringify(outputs));
        }
        process.exit(finalExitCode);
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
