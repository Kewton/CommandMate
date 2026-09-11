/**
 * send Command - Send a message to a worktree agent
 * Issue #518: [DR1-08] Factory pattern
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { SendOptions } from '../types';
import type { ChatMessage, TaskCreateResponse } from '../types/api-responses';
import { ApiClient, ApiError, assertResponseShape, isValidWorktreeId, MAX_STOP_PATTERN_LENGTH } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { parseDurationToMs, ALLOWED_DURATIONS } from '../config/duration-constants';
import { isCliToolId, CLI_TOOL_IDS } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import { validateCopilotModelName, validateAntigravityModelName } from '../config/model-validation';
import { fetchAgentInstances, saveAgentInstances, defaultAlias, MAX_AGENT_INSTANCES } from '../utils/agent-instances';
import {
  isInstanceSelector,
  INSTANCE_ALIAS_HELP_SUFFIX,
  INSTANCE_SELECTOR_ERROR,
  resolveInstanceTarget,
} from './instances';
import {
  ALLOW_RELAY_CHAIN_DESCRIPTION,
  REPLY_TO_OPTION_DESCRIPTION,
  cancelRelayQuietly,
  registerRelay,
  resolveEndpointForWorktree,
  resolveRelayEndpoint,
} from './relays';

/** Auto-yes duration used when --duration is omitted. */
const DEFAULT_AUTO_YES_DURATION = '1h';

/**
 * The message length `send` is verified to deliver whole (Issue #2464): the
 * largest body sent through the paste path to claude, codex, command-code and
 * antigravity and found byte-identical in each tool's own transcript
 * (`docs/design/2464-long-body-repro-matrix.md`). Stated in `--help` so a
 * caller can choose "put it in a file" instead. A documented guarantee, not an
 * enforced cap: a longer message takes the same path and the same check.
 */
const SEND_VERIFIED_MAX_KIB = 48;
const SEND_VERIFIED_MAX_LINES = 240;

/**
 * Code the send API returns when the session is blocked on a prompt (Issue
 * #1708). Mirrors PROMPT_WAITING_CODE in src/lib/session/prompt-waiting-guard.ts;
 * duplicated rather than imported so the CLI bundle does not pull the server's
 * tmux/detection graph in for one string.
 */
const PROMPT_WAITING_CODE = 'PROMPT_WAITING';

/**
 * What to print when a PROMPT_WAITING response carried no message body — an
 * older daemon, or a truncated body. The code is the contract; the sentence is
 * a courtesy, and the CLI must still say what to do without it.
 */
function promptWaitingFallback(worktreeId: string): string {
  return (
    `${worktreeId} is waiting on a prompt; the message was not sent. ` +
    `Answer it first: \`commandmate respond ${worktreeId} <answer>\`.`
  );
}

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
  agent: string | undefined,
  instanceId: string | undefined
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
  if (instanceId) {
    autoYesBody.instanceId = instanceId;
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
  agent: string | undefined,
  instanceId: string | undefined
): Promise<{ taskId: string; message: string }> {
  const body: Record<string, unknown> = { contractPath: options.contract };
  if (agent) {
    body.cliToolId = agent;
  }
  if (instanceId) {
    body.instanceId = instanceId;
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
    .option('--instance <id>', `${INSTANCE_OPTION_DESCRIPTION} ${INSTANCE_ALIAS_HELP_SUFFIX}`)
    .option('--agent <agent>', AGENT_OPTION_DESCRIPTION)
    .option('--register', 'Register the --instance session into the agent-instance roster (needs --agent unless the instance id is itself a CLI tool id)')
    .option('--model <model>', 'Specify AI model for Copilot or Antigravity agent')
    .option('--auto-yes', 'Enable auto-yes before sending (session-wide, no policy guard; for unattended runs prefer --contract with an autoYes policy)')
    .option('--duration <duration>', `Auto-yes duration (${ALLOWED_DURATIONS.join(', ')})`)
    .option('--stop-pattern <pattern>', 'Auto-yes stop pattern (regex). Matched against terminal output; cannot block commands (use the task contract\'s autoYes.denyPatterns for that)')
    .option('--contract <path>', 'Execution contract path relative to the worktree root (e.g. .commandmate/tasks/my-task.yaml). Records a task and sends the contract preamble plus its goal.')
    .option('--ignore-structured-prompt', 'Send even if only the agent\'s hooks report an open dialog (Issue #1737). Use when the pane looks idle but sends are refused; a prompt visible in the terminal is still refused.')
    .option('--reply-to <target>', REPLY_TO_OPTION_DESCRIPTION)
    .option('--allow-relay-chain', ALLOW_RELAY_CHAIN_DESCRIPTION)
    .option('--token <token>', TOKEN_WARNING)
    .addHelpText('after', `
--reply-to registers a relay: when the target session finishes this turn,
CommandMate puts its answer into the named session's composer, prefixed with
\`[from <alias> / <worktree>]\`. Nothing blocks — there is no wait to run and
no pane to scrape. Watch it with \`commandmate relays\`, withdraw it with
\`commandmate relays cancel <id>\`; it expires after 24h either way.

Exit 2 when the relay is refused: you are answering a relayed message already
(pass --allow-relay-chain), the chain would exceed 3 hops, or an open relay
between these two sessions exists. Nothing is sent in that case.

Message length (Issue #2464): up to ${SEND_VERIFIED_MAX_KIB} KiB and ${SEND_VERIFIED_MAX_LINES} lines is verified
to arrive whole on claude, codex, command-code and antigravity. A message over
512 bytes is pasted into the agent's composer as one bracketed paste, and Enter
waits until the composer shows all of it. If it never does, nothing is
submitted and send exits 99 with "Message body did not arrive intact" -- it
does not print "Message sent.". For a longer brief, write it to a file in the
worktree and send a short message that tells the agent to read that file.
`)
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

        // Issue #868 / #2376: Validate the instance SELECTOR if provided. An id
        // or an alias — which of the two it is, only the roster knows.
        if (options.instance && !isInstanceSelector(options.instance)) {
          console.error(INSTANCE_SELECTOR_ERROR);
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
        const target = options.instance
          ? await resolveInstanceTarget(client, worktreeId, options.instance, options.agent)
          : null;
        const agent = target ? target.cliToolId : options.agent;
        // Issue #2376: the RESOLVED id, never the string the user typed.
        // `--instance "Codex 2"` has to reach /send as `codex-2`; no route but
        // /resolve-target knows how to read an alias.
        const instanceId = target?.instanceId;

        // Issue #576/#588/#989: Validate --model option via shared validator (DR1-003).
        // Issue #1925: judged against the RESOLVED agent, not against --agent.
        // `--instance copilot-2 --model gpt-5` names a copilot session in the
        // only way the roster understands, and this check used to reject it for
        // not repeating `--agent copilot` — the tool-dependent option was being
        // validated before the tool was known (design §4 D5 決定 3). Still ahead
        // of every side effect: resolution only reads.
        if (options.model) {
          if (agent !== 'copilot' && agent !== 'antigravity') {
            console.error(
              'Error: --model option requires --agent copilot or --agent antigravity'
              + ' (or an --instance registered as one)'
            );
            process.exit(ExitCode.CONFIG_ERROR);
          }
          const modelValidation = agent === 'antigravity'
            ? validateAntigravityModelName(options.model)
            : validateCopilotModelName(options.model);
          if (!modelValidation.valid) {
            console.error(`Error: Invalid model name: ${modelValidation.reason}`);
            process.exit(ExitCode.CONFIG_ERROR);
          }
        }

        // Issue #1545: resolve the contract before anything with a side effect,
        // so an invalid contract cannot leave auto-yes enabled for a message
        // that was never sent.
        let taskId: string | undefined;
        let content = message;
        if (options.contract) {
          const task = await createContractTask(client, worktreeId, options, agent, instanceId);
          taskId = task.taskId;
          content = task.message;
          console.error(`Task created: ${taskId}`);
          console.log(taskId);
        }

        // --auto-yes: enable auto-yes first (unless --model is specified, then after send) [DR2-02]
        if (options.autoYes && !options.model) {
          await enableAutoYes(client, worktreeId, options, autoYesDurationMs, agent, instanceId);
        }

        // Issue #2377: the relay is registered BEFORE the message goes out, so a
        // session that answers immediately cannot finish its turn in the window
        // between the send and the ledger row — the completion trigger reads the
        // ledger, and a row that does not exist yet is a reply nobody collects.
        // A refusal exits 2 here, having sent nothing.
        let relayId: string | undefined;
        if (options.replyTo) {
          const replyEndpoint = await resolveRelayEndpoint(client, options.replyTo);
          const workerEndpoint = await resolveEndpointForWorktree(
            client,
            worktreeId,
            options.instance,
            options.agent
          );
          relayId = await registerRelay(client, {
            from: replyEndpoint,
            to: workerEndpoint,
            allowRelayChain: options.allowRelayChain,
          });
          // stderr, not stdout: `--contract` already owns this command's stdout
          // (it prints the task id there), and two commands writing two ids to
          // one stream is how a `$(…)` capture ends up with both. `ask --async`
          // is the form that hands the relay id back on stdout.
          console.error(`Relay registered: ${relayId}`);
        }

        // [DR2-05] Send API uses "content" not "message"
        const sendBody: Record<string, unknown> = { content };
        if (agent) {
          sendBody.cliToolId = agent;
        }
        // Issue #868: Include instance ID in send body
        if (instanceId) {
          sendBody.instanceId = instanceId;
        }
        // Issue #576: Include model in send body
        if (options.model) {
          sendBody.model = options.model;
        }
        // Issue #1737: waive the structured half of the prompt guard for this
        // send. Sent only when asked for, so an older daemon that does not know
        // the field sees exactly the body it always did.
        if (options.ignoreStructuredPrompt) {
          sendBody.ignoreStructuredPromptGuard = true;
        }

        try {
          await client.post<ChatMessage>(`/api/worktrees/${worktreeId}/send`, sendBody);
        } catch (error) {
          // A task whose message never arrived is a failed task, not a pending
          // one: nothing is working on it and nothing ever will.
          if (taskId) {
            await reportTaskStatus(client, taskId, 'failed');
          }
          // A relay whose message never arrived can never be answered; leaving
          // it open would have the requester waiting 24h for a turn that was
          // never started.
          if (relayId) {
            await cancelRelayQuietly(client, relayId);
          }
          // Issue #1708: the session is sitting on a prompt, so the message
          // would have been typed into the prompt's input line rather than
          // reaching the agent. Reported on its own so an unattended runner sees
          // "answer the prompt", not a generic HTTP failure — nudging a stalled
          // worker is exactly what made #1708 worse.
          if (error instanceof ApiError && error.apiCode === PROMPT_WAITING_CODE) {
            // The server's own sentence, not error.message: handleApiError maps a
            // bare 409 to "Unexpected HTTP status: 409", which says nothing about
            // what to do next.
            console.error(`Error: ${error.payload?.error ?? promptWaitingFallback(worktreeId)}`);
            process.exit(ExitCode.CONFIG_ERROR);
          }
          throw error;
        }
        console.error('Message sent.');

        if (taskId) {
          await reportTaskStatus(client, taskId, 'running');
        }

        // Issue #1000: register the ad-hoc instance into the roster after the
        // session has started, so a follow-up `commandmate instances` lists it.
        if (options.register && instanceId) {
          await registerInstance(client, worktreeId, instanceId, options.agent ?? instanceId);
        }

        // Issue #576: Enable auto-yes AFTER send when --model is specified
        // This avoids auto-yes interfering with the /model command interaction
        if (options.autoYes && options.model) {
          await enableAutoYes(client, worktreeId, options, autoYesDurationMs, agent, instanceId);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
