/**
 * wait Command - Block until agent completion or prompt detection
 * Issue #518: [DR1-08] Factory pattern
 *
 * Exit codes [DR1-03]:
 * - 0: SUCCESS (agent completed)
 * - 10: PROMPT_DETECTED (agent waiting for user input, including arrow-key
 *       selection lists — Issue #1628)
 * - 124: TIMEOUT (--timeout exceeded)
 * Issue #1544 adds --verify / --require-work, which can turn a detected
 * completion into 20 (VERIFY_FAILED) or 21 (NOT_STARTED).
 * Issue #1628 also returns 21 without --verify when the session was never
 * running: a wait with nothing to wait for must not report success.
 * Infrastructure errors use ExitCode (1, 2, 99)
 */

import { Command } from 'commander';
import { ExitCode, VerifyExitCode, WAIT_EXIT_CODE_PRIORITY, WaitExitCode } from '../types';
import type { WaitOptions } from '../types';
import type {
  CurrentOutputResponse,
  TaskListResponse,
  TaskStatus,
  WaitPromptOutput,
} from '../types/api-responses';
import { ApiClient, ApiError, isValidWorktreeId, isValidInstanceId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { runVerification, WORK_EVIDENCE_GATE_ID } from '../utils/verify-runner';
import { WAIT_INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';

/** [IA3-02] Polling interval 5 seconds (matches tmux-capture-cache TTL=2s) */
const POLL_INTERVAL_MS = 5000;

/**
 * `type` reported for a blocked-on-a-human frame that carries no parsable prompt
 * (Issue #1628). Arrow-key menus — Codex's pager and `/model`, antigravity's
 * permission menu, OpenCode's `/models` overlay — are deliberately published as
 * selection lists rather than prompts so the UI renders NavigationButtons, which
 * left `wait` with no signal at all for them: it polled until the timeout while
 * the agent sat stopped. They are not answerable as a prompt, so the payload
 * names the state instead of inventing options.
 */
const SELECTION_LIST_PROMPT_TYPE = 'selection_list';

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
  /**
   * Issue #1628: whether this wait ever saw the session alive. `!isRunning` on the
   * FIRST poll is "there is nothing here to wait for", not "the agent finished" —
   * reporting SUCCESS for it is how a wait on a worktree whose agent never started
   * (wrong tool, wrong instance, session never created) came back `Completed` in
   * milliseconds and handed a `passed` verdict to whatever ran next.
   */
  let everRunning = false;

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
      // Issue #868: scope polling to a specific agent instance when provided.
      const path = options.instance
        ? `/api/worktrees/${worktreeId}/current-output?instance=${encodeURIComponent(options.instance)}`
        : `/api/worktrees/${worktreeId}/current-output`;
      const data = await client.get<CurrentOutputResponse>(path);

      // Track content changes for stall detection
      if (data.content !== lastContent) {
        lastContent = data.content;
        lastActivityTime = Date.now();
      }

      if (data.isRunning) {
        everRunning = true;
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

      // Issue #1628: an arrow-key menu is the agent blocked on a human just as much
      // as a numbered prompt is, but it is published with isPromptWaiting=false so
      // the UI can render NavigationButtons instead of PromptPanel. Treat it as a
      // prompt here — otherwise `wait` polls a stopped agent until --timeout.
      if (data.isSelectionListActive) {
        if (options.onPrompt === 'human') {
          console.error(
            `Selection list active on ${worktreeId} (${data.sessionStatusReason ?? 'selection_list'}). ` +
              'Waiting for human response...',
          );
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        return {
          exitCode: WaitExitCode.PROMPT_DETECTED,
          output: {
            worktreeId,
            cliToolId: data.cliToolId || 'claude',
            type: SELECTION_LIST_PROMPT_TYPE,
            question: data.sessionStatusReason ?? SELECTION_LIST_PROMPT_TYPE,
            options: [],
            status: 'pending',
          },
        };
      }

      // Completion check [DR1-04]:
      // Path A: the tmux session went away after we had seen it alive — the agent
      //         finished and its session was stopped.
      // Path B: agent completed task (sessionStatus === 'ready', input prompt detected)
      // Both indicate "no more work in progress" from wait command's perspective.
      //
      // Issue #1628 narrowed Path A: a session that was NEVER seen running is
      // "nothing to wait for" (NOT_STARTED), not a completion. See `everRunning`.
      if (!data.isRunning && !everRunning) {
        console.error(
          `Not started: ${worktreeId} has no running ${data.cliToolId ?? 'agent'} session` +
            `${options.instance ? ` for instance ${options.instance}` : ''}.`,
        );
        return { exitCode: VerifyExitCode.NOT_STARTED };
      }

      if (!data.isRunning || data.sessionStatus === 'ready') {
        console.error(`Completed: ${worktreeId}`);
        return { exitCode: WaitExitCode.SUCCESS };
      }

      // Progress indicator on stderr [DR1-05]
      console.error(`Waiting: ${worktreeId} (status=${data.sessionStatus}, running=${data.isRunning}, prompt=${data.isPromptWaiting})`);
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

/** True when the caller asked for a verdict rather than "the agent stopped". */
function verifyRequested(options: WaitOptions): boolean {
  return Boolean(options.verify || options.requireWork);
}

/**
 * Whether this poll outcome should still be handed to the verification gates.
 *
 * A completion is the obvious case. NOT_STARTED joins it (Issue #1628) so the
 * operator gets the gate results instead of a bare "no session": work committed
 * by an agent whose session has since gone away is still worth reporting. The
 * verdict is merged rather than substituted — mergeExitCode never lets a passing
 * run overwrite NOT_STARTED, so "wait never saw this agent" survives to the exit
 * code even when the gates are green.
 */
function shouldVerify(exitCode: number, options: WaitOptions): boolean {
  if (!verifyRequested(options)) return false;
  return exitCode === WaitExitCode.SUCCESS || exitCode === VerifyExitCode.NOT_STARTED;
}

/**
 * Task statuses that mean "this wait is about that task".
 *
 * Mirrors ACTIVE_TASK_STATUSES in src/lib/db/tasks-db.ts. Deliberately narrower
 * than the set the server will attach a run to: this is a guess made from a
 * worktree id alone, and a task that had already finished before the wait began
 * is a different delegation, not this one.
 */
const IN_FLIGHT_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'running',
  'waiting_input',
  'verifying',
]);

/**
 * Read the task this wait is about, before waiting for it (Issue #1620).
 *
 * Timing is the whole point. Agents are asked to run the gates themselves
 * before reporting completion, and doing so moves their task to a terminal
 * status — after which a verification run started with only a worktree id has
 * no contract to resolve, judges no scope, and still reports `passed`. Read
 * while the task is still in flight, the id survives that transition and the
 * run that follows is judged against the contract it was supposed to judge.
 *
 * Never throws: an unreadable ledger costs the attribution, and refusing to
 * verify over it would cost every gate.
 *
 * @returns the task id, or undefined to leave resolution to the server
 */
async function resolveWaitedTaskId(
  client: ApiClient,
  worktreeId: string,
): Promise<string | undefined> {
  try {
    const data = await client.get<TaskListResponse>(
      `/api/worktrees/${worktreeId}/tasks?limit=1`,
    );
    const task = data?.tasks?.[0];
    if (!task || !IN_FLIGHT_TASK_STATUSES.has(task.status)) return undefined;
    return task.id;
  } catch (error) {
    console.error(
      `Note: could not read the task ledger for ${worktreeId} ` +
        `(${error instanceof Error ? error.message : String(error)}); ` +
        'verification will resolve its own task.',
    );
    return undefined;
  }
}

/**
 * Run verification for one worktree after its completion was detected.
 *
 * Swallows ApiError into an exit code: with several worktrees in flight, one
 * unreachable run must not abort the verdicts of the others.
 */
async function verifyAfterWait(
  client: ApiClient,
  worktreeId: string,
  options: WaitOptions,
  taskId: string | undefined,
): Promise<number> {
  // --verify runs every gate, and work-evidence is always part of "every gate",
  // so combining it with --require-work is a superset rather than a conflict.
  const gateIds = options.verify ? undefined : [WORK_EVIDENCE_GATE_ID];
  try {
    const outcome = await runVerification(client, {
      worktreeId,
      trigger: 'wait',
      instanceId: options.instance,
      taskId,
      gateIds,
      // stdout stays reserved for the prompt JSON contract.
      resultStream: 'stderr',
    });
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof ApiError) {
      console.error(`Error: ${error.message}`);
      return error.exitCode;
    }
    console.error(
      `Error: verification of ${worktreeId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return ExitCode.UNEXPECTED_ERROR;
  }
}

/**
 * Fold one worktree's exit code into the aggregate.
 *
 * Ranked codes (see WAIT_EXIT_CODE_PRIORITY) beat unranked infrastructure
 * codes, and among equals the first one observed stands.
 */
function mergeExitCode(current: number, candidate: number): number {
  if (candidate === WaitExitCode.SUCCESS) return current;
  if (current === WaitExitCode.SUCCESS) return candidate;

  const rank = (code: number): number => {
    const index = WAIT_EXIT_CODE_PRIORITY.indexOf(code);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return rank(candidate) < rank(current) ? candidate : current;
}

export function createWaitCommand(): Command {
  const cmd = new Command('wait');
  cmd
    .description('Wait for agent completion (1 worktree per CLI instance recommended)')
    .argument('<worktree-ids...>', 'Worktree ID(s) to wait on')
    .option('--timeout <seconds>', 'Maximum wait time in seconds', parseInt)
    .option('--on-prompt <mode>', 'Prompt handling: agent (default) exits 10 with a prompt JSON payload on stdout (read it before re-capturing); human keeps waiting for a human reply')
    .option('--stall-timeout <seconds>', 'Maximum time without output change', parseInt)
    .option('--instance <id>', WAIT_INSTANCE_OPTION_DESCRIPTION)
    .option('--verify', 'After completion, run every verification gate; exit 20 when a gate fails, 21 when there is nothing to verify')
    .option('--require-work', 'After completion, run only the work-evidence gate; exit 21 when the worktree has no commits and no uncommitted changes')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeIds: string[], options: WaitOptions) => {
      try {
        // [SEC4-04] Validate all worktree IDs
        for (const id of worktreeIds) {
          if (!isValidWorktreeId(id)) {
            console.error(`Error: Invalid worktree ID format: ${id}`);
            process.exit(ExitCode.CONFIG_ERROR);
            return;
          }
        }

        // Issue #868: Validate instance ID if provided
        if (options.instance && !isValidInstanceId(options.instance)) {
          console.error('Error: Invalid --instance. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        const client = new ApiClient({ token: options.token });

        // Issue #1620: resolved before any polling starts. Once the agent stops
        // there is no reliable way left to tell which contract this wait was
        // about — the agent's own verification may have closed it by then.
        const boundTaskIds = verifyRequested(options)
          ? await Promise.all(worktreeIds.map(id => resolveWaitedTaskId(client, id)))
          : worktreeIds.map(() => undefined);

        if (worktreeIds.length === 1) {
          // Single worktree
          const result = await pollWorktree(client, worktreeIds[0], options);
          if (result.output) {
            // stdout for result (JSON output)
            console.log(JSON.stringify(result.output));
          }
          // Issue #1544: only a detected completion is worth verifying — a
          // prompt or a timeout means the agent never claimed to be done.
          const exitCode = shouldVerify(result.exitCode, options)
            ? mergeExitCode(
                result.exitCode,
                await verifyAfterWait(client, worktreeIds[0], options, boundTaskIds[0]),
              )
            : result.exitCode;
          process.exit(exitCode);
          return;
        }

        // [DR1-07] Multiple worktrees: Promise.allSettled for error isolation
        const results = await Promise.allSettled(
          worktreeIds.map(id => pollWorktree(client, id, options))
        );

        // Collect results
        const outputs: WaitPromptOutput[] = [];
        let finalExitCode: number = WaitExitCode.SUCCESS;
        const verifyTargets: Array<{ id: string; taskId: string | undefined }> = [];

        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            if (result.value.output) {
              outputs.push(result.value.output);
            }
            if (shouldVerify(result.value.exitCode, options)) {
              verifyTargets.push({ id: worktreeIds[index], taskId: boundTaskIds[index] });
              // Issue #1628: fold NOT_STARTED in before verification so a green
              // gate run cannot promote "no session was ever running" to success.
              finalExitCode = mergeExitCode(finalExitCode, result.value.exitCode);
              return;
            }
            finalExitCode = mergeExitCode(finalExitCode, result.value.exitCode);
          } else {
            const err = result.reason;
            finalExitCode = mergeExitCode(
              finalExitCode,
              err instanceof ApiError ? err.exitCode : ExitCode.UNEXPECTED_ERROR,
            );
          }
        });

        // Issue #1544: serial on purpose. The server caps concurrent runs
        // process-wide, so firing them together only queues them behind each
        // other while every gate competes for the same machine.
        for (const target of verifyTargets) {
          finalExitCode = mergeExitCode(
            finalExitCode,
            await verifyAfterWait(client, target.id, options, target.taskId),
          );
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
