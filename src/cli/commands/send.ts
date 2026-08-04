/**
 * send Command - Send a message to a worktree agent
 * Issue #518: [DR1-08] Factory pattern
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { SendOptions } from '../types';
import type { ChatMessage, TaskCreateResponse } from '../types/api-responses';
import { ApiClient, ApiError, assertResponseShape, isValidWorktreeId, isValidInstanceId, MAX_STOP_PATTERN_LENGTH } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { parseDurationToMs, ALLOWED_DURATIONS } from '../config/duration-constants';
import { isCliToolId, CLI_TOOL_IDS } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import { validateCopilotModelName, validateAntigravityModelName } from '../config/model-validation';
import { fetchAgentInstances, saveAgentInstances, defaultAlias, MAX_AGENT_INSTANCES } from '../utils/agent-instances';
import { resolveInstanceCliTool } from './instances';

/** Auto-yes duration used when --duration is omitted. */
const DEFAULT_AUTO_YES_DURATION = '1h';

/**
 * Resolve --duration to milliseconds, exiting on an invalid value.
 *
 * Issue #1608: this is called from the option-validation block at the top of
 * the action, not from enableAutoYes(). enableAutoYes() runs after --contract
 * has already created the task row, so validating there left a `pending` task
 * behind for a message that was never sent.
 */
function resolveAutoYesDurationMs(duration: string | undefined): number {
  const durationMs = parseDurationToMs(duration ?? DEFAULT_AUTO_YES_DURATION);

  if (durationMs === null) {
    console.error(`Error: Invalid duration. Must be one of: ${ALLOWED_DURATIONS.join(', ')}`);
    process.exit(ExitCode.CONFIG_ERROR);
  }

  return durationMs;
}

/**
 * Build auto-yes request body and send it to the API (DRY extraction).
 *
 * @param client - API client instance
 * @param worktreeId - Target worktree ID
 * @param options - Send command options containing auto-yes settings
 * @param durationMs - Duration already validated by resolveAutoYesDurationMs()
 * @param agent - CLI tool resolved for --instance (Issue #1629), else --agent
 */
async function enableAutoYes(
  client: ApiClient,
  worktreeId: string,
  options: SendOptions,
  durationMs: number,
  agent: string | undefined
): Promise<void> {
  const autoYesBody: Record<string, unknown> = {
    enabled: true,
    duration: durationMs,
  };
  if (agent) {
    autoYesBody.cliToolId = agent;
  }
  // Issue #896: per-instance auto-yes. When --instance is given, the poller keys
  // on worktreeId:cliToolId:instanceId so the targeted instance is auto-answered
  // independently of other instances of the same agent.
  if (options.instance) {
    autoYesBody.instanceId = options.instance;
  }
  if (options.stopPattern) {
    autoYesBody.stopPattern = options.stopPattern;
  }

  await client.post<void>(`/api/worktrees/${worktreeId}/auto-yes`, autoYesBody);
  console.error('Auto-yes enabled.');
}

/**
 * Register an ad-hoc --instance session into the agent-instance roster
 * (Issue #1000: --register). No-ops when already registered so `send
 * --register` is safe to repeat across multiple messages to the same instance.
 */
async function registerInstance(
  client: ApiClient,
  worktreeId: string,
  instanceId: string,
  cliTool: string
): Promise<void> {
  const existing = await fetchAgentInstances(client, worktreeId);
  if (existing.some((inst) => inst.id === instanceId)) {
    return;
  }
  if (existing.length >= MAX_AGENT_INSTANCES) {
    console.error(`Warning: could not register '${instanceId}' in the roster (already at the ${MAX_AGENT_INSTANCES}-instance limit).`);
    return;
  }

  const next = [...existing, { id: instanceId, cliTool, alias: defaultAlias(cliTool, instanceId), order: existing.length }];
  await saveAgentInstances(client, worktreeId, next);
  console.error(`Instance registered in roster: ${instanceId}`);
}

/**
 * Create the task row for `--contract` and get the message to send back.
 *
 * The contract is parsed server-side: the path is relative to the worktree,
 * which only the server can resolve, and the completion criterion is expanded
 * from that worktree's verify.yaml. Every violation the server found is printed
 * before exiting, so a broken contract is fixed in one pass (Issue #1545).
 */
async function createContractTask(
  client: ApiClient,
  worktreeId: string,
  options: SendOptions,
  agent: string | undefined
): Promise<{ taskId: string; message: string }> {
  const body: Record<string, unknown> = { contractPath: options.contract };
  if (agent) {
    body.cliToolId = agent;
  }
  if (options.instance) {
    body.instanceId = options.instance;
  }

  try {
    const response = await client.post<TaskCreateResponse>(
      `/api/worktrees/${worktreeId}/tasks`,
      body
    );
    const created = assertResponseShape<TaskCreateResponse>(
      response,
      ['task', 'message'],
      'POST /api/worktrees/:id/tasks'
    );
    return { taskId: created.task.id, message: created.message };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 400 && error.payload?.issues?.length) {
      console.error('Error: invalid task contract:');
      for (const issue of error.payload.issues) {
        console.error(`  - ${issue}`);
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }
    throw error;
  }
}

/**
 * Report a task transition to the server, best effort.
 *
 * A failure here is worth a warning but not the command's exit code: the
 * message either reached the agent or it did not, and that outcome is what the
 * caller is waiting on.
 */
async function reportTaskStatus(
  client: ApiClient,
  taskId: string,
  status: 'running' | 'failed'
): Promise<void> {
  try {
    await client.patch<unknown>(`/api/tasks/${taskId}`, { status });
  } catch {
    console.error(`Warning: could not record task ${taskId} as ${status}.`);
  }
}

export function createSendCommand(): Command {
  const cmd = new Command('send');
  cmd
    .description('Send a message to a worktree agent')
    .argument('<worktree-id>', 'Worktree ID')
    .argument('[message]', 'Message to send (omit when using --contract)')
    .option('--instance <id>', INSTANCE_OPTION_DESCRIPTION)
    .option('--agent <agent>', AGENT_OPTION_DESCRIPTION)
    .option('--register', 'Register the --instance session into the agent-instance roster (needs --agent unless the instance id is itself a CLI tool id)')
    .option('--model <model>', 'Specify AI model for Copilot or Antigravity agent')
    .option('--auto-yes', 'Enable auto-yes before sending (session-wide, no policy guard; for unattended runs prefer --contract with an autoYes policy)')
    .option('--duration <duration>', `Auto-yes duration (${ALLOWED_DURATIONS.join(', ')})`)
    .option('--stop-pattern <pattern>', 'Auto-yes stop pattern (regex). Matched against terminal output; cannot block commands (use the task contract\'s autoYes.denyPatterns for that)')
    .option('--contract <path>', 'Execution contract path relative to the worktree root (e.g. .commandmate/tasks/my-task.yaml). Records a task and sends the contract preamble plus its goal.')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, message: string | undefined, options: SendOptions) => {
      try {
        // [SEC4-04] Validate worktree ID
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #1545: the contract supplies the message, so accepting both
        // would leave which one the agent receives ambiguous.
        if (options.contract && message !== undefined) {
          console.error('Error: --contract supplies the message; do not pass a message argument as well.');
          process.exit(ExitCode.CONFIG_ERROR);
        }
        if (!options.contract && message === undefined) {
          console.error('Error: a message argument is required unless --contract is given.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Validate agent if provided
        if (options.agent && !isCliToolId(options.agent)) {
          console.error(`Error: Invalid agent. Must be one of: ${CLI_TOOL_IDS.join(', ')}`);
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #868: Validate instance ID if provided
        if (options.instance && !isValidInstanceId(options.instance)) {
          console.error('Error: Invalid --instance. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #1000: --register requires --instance, and requires --agent
        // unless the instance id is itself a primary CLI tool id (e.g. claude).
        if (options.register) {
          if (!options.instance) {
            console.error('Error: --register requires --instance.');
            process.exit(ExitCode.CONFIG_ERROR);
          }
          if (!options.agent && !isCliToolId(options.instance)) {
            console.error('Error: --register requires --agent when --instance is not a primary instance id (e.g. claude, codex).');
            process.exit(ExitCode.CONFIG_ERROR);
          }
        }

        // [SEC4-06] Validate stop-pattern length
        if (options.stopPattern && options.stopPattern.length > MAX_STOP_PATTERN_LENGTH) {
          console.error(`Error: stop-pattern exceeds maximum length of ${MAX_STOP_PATTERN_LENGTH} characters.`);
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #576/#588/#989: Validate --model option via shared validator (DR1-003)
        if (options.model) {
          // --model requires --agent copilot or --agent antigravity
          if (!options.agent || (options.agent !== 'copilot' && options.agent !== 'antigravity')) {
            console.error('Error: --model option requires --agent copilot or --agent antigravity');
            process.exit(ExitCode.CONFIG_ERROR);
          }
          const modelValidation = options.agent === 'antigravity'
            ? validateAntigravityModelName(options.model)
            : validateCopilotModelName(options.model);
          if (!modelValidation.valid) {
            console.error(`Error: Invalid model name: ${modelValidation.reason}`);
            process.exit(ExitCode.CONFIG_ERROR);
          }
        }

        // Issue #1608: every option that can be judged from its own value is
        // judged here, before the first side effect. --duration used to be the
        // exception: enableAutoYes() validated it, and that runs after
        // --contract has already created the task row, so `--duration 2h` left
        // a `pending` task for a message that was never sent. Validated
        // unconditionally, like --stop-pattern and --model above: a value the
        // CLI cannot honour is an error whether or not --auto-yes accompanies it.
        const autoYesDurationMs = resolveAutoYesDurationMs(options.duration);

        const client = new ApiClient({ token: options.token });

        // Issue #1629: --instance names an agent instance, not a CLI tool, and
        // the roster is the only place that pairs the two. Resolve it once, up
        // front, so the task row, the send and auto-yes all name the same tool
        // as the session that actually starts.
        const agent = options.instance
          ? await resolveInstanceCliTool(client, worktreeId, options.instance, options.agent)
          : options.agent;

        // Issue #1545: resolve the contract before anything with a side effect,
        // so an invalid contract cannot leave auto-yes enabled for a message
        // that was never sent.
        let taskId: string | undefined;
        let content = message;
        if (options.contract) {
          const task = await createContractTask(client, worktreeId, options, agent);
          taskId = task.taskId;
          content = task.message;
          console.error(`Task created: ${taskId}`);
          console.log(taskId);
        }

        // --auto-yes: enable auto-yes first (unless --model is specified, then after send) [DR2-02]
        if (options.autoYes && !options.model) {
          await enableAutoYes(client, worktreeId, options, autoYesDurationMs, agent);
        }

        // [DR2-05] Send API uses "content" not "message"
        const sendBody: Record<string, unknown> = { content };
        if (agent) {
          sendBody.cliToolId = agent;
        }
        // Issue #868: Include instance ID in send body
        if (options.instance) {
          sendBody.instanceId = options.instance;
        }
        // Issue #576: Include model in send body
        if (options.model) {
          sendBody.model = options.model;
        }

        try {
          await client.post<ChatMessage>(`/api/worktrees/${worktreeId}/send`, sendBody);
        } catch (error) {
          // A task whose message never arrived is a failed task, not a pending
          // one: nothing is working on it and nothing ever will.
          if (taskId) {
            await reportTaskStatus(client, taskId, 'failed');
          }
          throw error;
        }
        console.error('Message sent.');

        if (taskId) {
          await reportTaskStatus(client, taskId, 'running');
        }

        // Issue #1000: register the ad-hoc instance into the roster after the
        // session has started, so a follow-up `commandmate instances` lists it.
        if (options.register && options.instance) {
          await registerInstance(client, worktreeId, options.instance, options.agent ?? options.instance);
        }

        // Issue #576: Enable auto-yes AFTER send when --model is specified
        // This avoids auto-yes interfering with the /model command interaction
        if (options.autoYes && options.model) {
          await enableAutoYes(client, worktreeId, options, autoYesDurationMs, agent);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
