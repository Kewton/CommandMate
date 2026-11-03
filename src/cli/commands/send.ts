/**
 * send Command - Send a message to a worktree agent
 * Issue #518: [DR1-08] Factory pattern
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { SendOptions } from '../types';
import type { AutoYesContractPolicy, AutoYesSetResult, TaskCreateResponse, TaskView } from '../types/api-responses';
import { ApiClient, ApiError, assertResponseShape, isValidWorktreeId, MAX_STOP_PATTERN_LENGTH } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { parseDurationToMs, AUTO_YES_DURATION_FLAG_RANGE, DEFAULT_DURATION_FLAG } from '../config/duration-constants';
import { isCliToolId, CLI_TOOL_IDS } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import {
  validateCopilotModelName,
  validateAntigravityModelName,
  validateClaudeModelName,
} from '../config/model-validation';
import { fetchAgentInstances, saveAgentInstances, defaultAlias, MAX_AGENT_INSTANCES } from '../utils/agent-instances';
import {
  isInstanceSelector,
  resolveInstanceTarget,
  INSTANCE_ALIAS_HELP_SUFFIX,
  INSTANCE_SELECTOR_ERROR,
} from './instances';
import { resolveCommandTarget, type CommandTarget } from './command-target';
import { followUpCommand } from '../utils/follow-up-command';
import {
  ANSWER_MODE_OPTION_DESCRIPTION,
  describeAnswerMode,
  describeContractPolicy,
  validateAnswerModeOption,
} from './auto-yes';
import {
  ALLOW_RELAY_CHAIN_DESCRIPTION,
  REPLY_TO_OPTION_DESCRIPTION,
  cancelRelayQuietly,
  type RegisteredRelay,
} from './relays';
import { postMessage, registerRelayForMessage, type FailedSendOutcome } from './message-dispatch';
import {
  assertRoleTool,
  roleAssignmentFromFlag,
  roleFailureFromApi,
  RoleCliError,
  usageError,
  watchRoleFlagConflict,
} from '../utils/agent-roles';
import type {
  InstanceRoleCreateResponse,
  InstanceRoleSettingsResponse,
  RoleAssignmentInput,
} from '../../types/agent-roles';

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
 * What to print when a PROMPT_WAITING response carried no message body — an
 * older daemon, or a truncated body. The code is the contract; the sentence is
 * a courtesy, and the CLI must still say what to do without it.
 */
function promptWaitingFallback(worktreeId: string, target: CommandTarget): string {
  return (
    `${worktreeId} is waiting on a prompt; the message was not sent. ` +
    // Issue #3982: the prompt is the resolved target's, not the worktree default's.
    `Answer it first: \`${followUpCommand('respond', worktreeId, target, '<answer>')}\`.`
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
  const durationMs = parseDurationToMs(duration ?? DEFAULT_DURATION_FLAG);

  if (durationMs === null) {
    console.error(`Error: Invalid duration. Must be ${AUTO_YES_DURATION_FLAG_RANGE} (e.g. 5h).`);
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
 * @param contractPolicy - The policy of the contract this send created (Issue #3723), else null
 */
async function enableAutoYes(
  client: ApiClient,
  worktreeId: string,
  options: SendOptions,
  durationMs: number,
  agent: string | undefined,
  instanceId: string | undefined,
  contractPolicy: AutoYesContractPolicy | null = null
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
  // Issue #3863: sent only when given, so the server keeps a live grant's mode.
  if (options.autoYesAnswerMode !== undefined) {
    autoYesBody.answerMode = options.autoYesAnswerMode;
  }

  // Issue #3723: the response is read now. It names what the contract on the
  // instance lets Auto-Yes answer; with `autoYes.mode: off` the poller this
  // armed answers nothing, and "Auto-yes enabled." alone said otherwise.
  const result = await client.post<AutoYesSetResult | undefined>(
    `/api/worktrees/${worktreeId}/auto-yes`,
    autoYesBody,
  );
  console.error('Auto-yes enabled.');
  // Issue #3863: the mode the server put it on with.
  const modeLine = describeAnswerMode(result?.answerMode, options.autoYesAnswerMode !== undefined);
  if (modeLine !== null) console.error(modeLine);
  // The server's reading wins when it has one. It has none for a `--contract`
  // send armed before the message goes out: the task is still `pending`, which
  // the server does not count as governing the instance (ACTIVE_TASK_STATUSES).
  // The contract this send just created is what will govern it, so its policy
  // is the one to describe then — a null from the server is not "no contract".
  for (const line of describeContractPolicy(result?.contractPolicy ?? contractPolicy)) {
    console.error(line);
  }
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
 * `--register` with a role: the instance and its role are created together, before
 * anything goes out, so the first start already has it (Issue #4116). Without a role
 * the order stays as it was: sent, then {@link registerInstance}.
 *
 * Repeating the command creates nothing. The role on the send replaces what the
 * instance holds, and is then a condition like any `--role`.
 *
 * @throws The roster changed since it was read (exit 31), or the server refused
 */
async function registerInstanceWithRole(
  client: ApiClient,
  worktreeId: string,
  instanceId: string,
  cliTool: string,
  role: RoleAssignmentInput
): Promise<void> {
  const url = `/api/worktrees/${worktreeId}/instances/roles`;
  const { instances, rosterRevision } = await client.get<InstanceRoleSettingsResponse>(url);
  if (instances.some((instance) => instance.instanceId === instanceId)) return;
  try {
    await client.post<InstanceRoleCreateResponse>(url, {
      instance: { id: instanceId, cliTool, alias: defaultAlias(cliTool, instanceId) },
      role,
      expectedRosterRevision: rosterRevision,
    });
  } catch (error) {
    // Another send got there first; what remains is the same as a repeat.
    if (error instanceof ApiError && error.payload?.error === 'instance_exists') return;
    const roleFailure = roleFailureFromApi(error);
    if (roleFailure) throw roleFailure;
    throw error;
  }
  console.error(`Instance registered in roster: ${instanceId}`);
}

/**
 * The `autoYes` block of a just-created task in the shape `describeContractPolicy`
 * reads (Issue #3723), or null when the response carries none. Read defensively:
 * `contract_json` is replayed verbatim, never re-validated.
 */
function contractPolicyOf(task: TaskView): AutoYesContractPolicy | null {
  const autoYes = task.contract?.autoYes;
  if (!autoYes || typeof autoYes !== 'object') return null;
  return {
    taskId: task.id,
    mode: typeof autoYes.mode === 'string' ? autoYes.mode : null,
    allowPromptTypes: Array.isArray(autoYes.allowPromptTypes) ? autoYes.allowPromptTypes : [],
    denyPatternCount: Array.isArray(autoYes.denyPatterns) ? autoYes.denyPatterns.length : 0,
  };
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
): Promise<{ taskId: string; message: string; contractPolicy: AutoYesContractPolicy | null }> {
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
    return {
      taskId: created.task.id,
      message: created.message,
      contractPolicy: contractPolicyOf(created.task),
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 400 && error.payload?.issues?.length) {
      console.error('Error: invalid task contract:');
      for (const issue of error.payload.issues) {
        console.error(`  - ${issue}`);
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }
    // Issue #4115/#4116: the role settings moved since this process started.
    const roleFailure = roleFailureFromApi(error);
    if (roleFailure) throw roleFailure;
    throw error;
  }
}

/**
 * The tool and instance a request naming neither is answered for: the worktree's
 * default, whose primary instance has the tool's own id (#868).
 */
async function effectiveTarget(
  client: ApiClient,
  worktreeId: string,
  agent: string | undefined,
  instanceId: string | undefined
): Promise<{ cliToolId: string | undefined; instanceId: string | undefined }> {
  const cliToolId = agent ?? (await resolveInstanceTarget(client, worktreeId, undefined, undefined)).cliToolId;
  return { cliToolId, instanceId: instanceId ?? cliToolId };
}

/**
 * `--contract` with a role (Issue #4116): the task check compares the process with
 * the SETTINGS, so `--role A` to a process running A while the setting says B would be
 * refused for a setting this very command is replacing. A plain `send --role` saves,
 * then checks; refused here, this does the same and checks again. Only then, because
 * the contract is read first: a broken contract saves nothing. As with any `--role`,
 * a refusal after the save leaves the setting saved, and says so.
 */
async function createContractTaskWithRole(
  client: ApiClient,
  worktreeId: string,
  options: SendOptions,
  agent: string | undefined,
  instanceId: string | undefined,
  role: RoleAssignmentInput | undefined
): ReturnType<typeof createContractTask> {
  const unmet = (error: unknown): error is RoleCliError =>
    error instanceof RoleCliError && error.code === 'ROLE_CONDITION_UNMET';
  try {
    return await createContractTask(client, worktreeId, options, agent, instanceId);
  } catch (error) {
    if (role === undefined || !unmet(error)) throw error;
  }
  const target = await effectiveTarget(client, worktreeId, agent, instanceId);
  try {
    await client.put<InstanceRoleSettingsResponse>(`/api/worktrees/${worktreeId}/instances/roles`, {
      instanceId: target.instanceId,
      role,
    });
  } catch (error) {
    const roleFailure = roleFailureFromApi(error);
    if (roleFailure) throw roleFailure;
    throw error;
  }
  try {
    return await createContractTask(client, worktreeId, options, agent, instanceId);
  } catch (error) {
    if (!unmet(error)) throw error;
    throw new RoleCliError(
      error.code,
      `${error.message} The role setting stayed saved, so after a restart the contract can be sent again without --role.`,
      error.exitCode,
      error.details,
      error.statusCode,
      error.payload
    );
  }
}

/**
 * Whether a failed send is known to have typed nothing: the server's word, or a 4xx
 * refused before an attempt. Not known otherwise (no answer, a 5xx saying nothing).
 */
function knownNotSent(error: unknown, outcome: FailedSendOutcome | null): boolean {
  if (outcome !== null) return outcome !== 'unknown';
  if (!(error instanceof ApiError)) return false;
  const reported = error.payload?.sendOutcome;
  if (reported !== undefined) return reported === 'not_sent';
  return error.statusCode !== undefined && error.statusCode < 500;
}

/**
 * Whether this instance's Auto-Yes is on, or null when that could not be read. A send
 * with a role has to know: on a refusal it puts back what it found.
 */
async function readPriorAutoYes(
  client: ApiClient,
  worktreeId: string,
  agent: string | undefined,
  instanceId: string | undefined
): Promise<boolean | null> {
  try {
    const target = await effectiveTarget(client, worktreeId, agent, instanceId);
    if (target.cliToolId === undefined) return null;
    const query = new URLSearchParams({ cliToolId: target.cliToolId });
    if (target.instanceId) query.set('instanceId', target.instanceId);
    const state = await client.get<{ enabled?: unknown }>(`/api/worktrees/${worktreeId}/auto-yes?${query.toString()}`);
    return typeof state?.enabled === 'boolean' ? state.enabled : null;
  } catch {
    return null;
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

/** Option checks before any side effect. Returns --duration in ms. A mocked `process.exit` returns, so nothing here stops early. */
function validateSendArgs(worktreeId: string, message: string | undefined, options: SendOptions): number {
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

  // Issue #3863: a value the server would refuse, and a mode with nothing to arm.
  validateAnswerModeOption(options.autoYesAnswerMode, '--auto-yes-answer-mode');
  if (options.autoYesAnswerMode !== undefined && !options.autoYes) {
    console.error('Error: --auto-yes-answer-mode requires --auto-yes.');
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
  // --contract has already created the task row, so `--duration 25h` left
  // a `pending` task for a message that was never sent. Validated
  // unconditionally, like --stop-pattern and --model above: a value the
  // CLI cannot honour is an error whether or not --auto-yes accompanies it.
  return resolveAutoYesDurationMs(options.duration);
}

/** --model checks against the resolved agent. */
function validateSendModel(options: SendOptions, agent: string | undefined): void {
  // Issue #576/#588/#989: Validate --model option via shared validator (DR1-003).
  // Issue #1925: judged against the RESOLVED agent, not against --agent.
  // `--instance copilot-2 --model gpt-5` names a copilot session in the
  // only way the roster understands, and this check used to reject it for
  // not repeating `--agent copilot` — the tool-dependent option was being
  // validated before the tool was known (design §4 D5 決定 3). Still ahead
  // of every side effect: resolution only reads.
  //
  // Issue #2771: claude joins the list. `agent` is undefined when neither
  // --instance nor --agent was given, and the server would then pick the
  // worktree's default tool — which the CLI cannot know, so it cannot pick
  // a validator either. The target has to be named.
  if (options.model) {
    if (agent !== 'copilot' && agent !== 'antigravity' && agent !== 'claude') {
      console.error(
        'Error: --model option requires --agent copilot, --agent antigravity or --agent claude'
        + ' (or an --instance registered as one)'
      );
      process.exit(ExitCode.CONFIG_ERROR);
    }
    const modelValidation = agent === 'antigravity'
      ? validateAntigravityModelName(options.model)
      : agent === 'claude'
        ? validateClaudeModelName(options.model)
        : validateCopilotModelName(options.model);
    if (!modelValidation.valid) {
      console.error(`Error: Invalid model name: ${modelValidation.reason}`);
      process.exit(ExitCode.CONFIG_ERROR);
    }
  }
}

/**
 * The `--expect-*` flags as the `/send` field that carries them to the last check
 * before the first key, or undefined when none was given (Issue #4116).
 */
function expectedRoleOf(options: SendOptions): Record<string, unknown> | undefined {
  const { expectRoleGeneration, expectRoleFingerprint, expectNoRole } = options;
  if (expectRoleGeneration === undefined && expectRoleFingerprint === undefined && !expectNoRole) return undefined;
  if ((expectRoleFingerprint === undefined) === !expectNoRole) {
    throw usageError('Give the pinned role with one of --expect-role-fingerprint <fingerprint> or --expect-no-role.');
  }
  return {
    injectionFingerprint: expectRoleFingerprint ?? null,
    ...(expectRoleGeneration !== undefined ? { sessionGeneration: expectRoleGeneration } : {}),
  };
}

/** The `/send` request body. */
function buildSendBody(
  content: string | undefined,
  agent: string | undefined,
  instanceId: string | undefined,
  options: SendOptions,
  role: { assignment: RoleAssignmentInput | undefined; expected: Record<string, unknown> | undefined }
): Record<string, unknown> {
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
  // Issue #4115/#4116: sent only when asked for, so a plain send stays the body it was.
  if (role.assignment !== undefined) {
    sendBody.role = role.assignment;
  }
  if (role.expected !== undefined) {
    sendBody.expectedRole = role.expected;
  }
  return sendBody;
}

export function createSendCommand(): Command {
  const cmd = new Command('send');
  const bothRoleFlags = watchRoleFlagConflict(cmd);
  cmd
    .description('Send a message to a worktree agent')
    .argument('<worktree-id>', 'Worktree ID')
    .argument('[message]', 'Message to send (omit when using --contract)')
    .option('--instance <id>', `${INSTANCE_OPTION_DESCRIPTION} ${INSTANCE_ALIAS_HELP_SUFFIX}`)
    .option('--agent <agent>', AGENT_OPTION_DESCRIPTION)
    .option('--register', 'Register the --instance session into the agent-instance roster (needs --agent unless the instance id is itself a CLI tool id)')
    .option('--role <role>', 'Role ID or name this instance must hold: saved for it, and a condition of this send (see below)')
    .option('--no-role', 'Like --role, for explicitly no role')
    .option('--expect-role-generation <generation>', 'Only send to this process, as read from `capture --json` roleLaunch.sessionGeneration')
    .option('--expect-role-fingerprint <fingerprint>', 'Only send to a process started with this injection fingerprint (roleLaunch.injectionFingerprint)')
    .option('--expect-no-role', 'Only send to a process started with no role')
    .option(
      '--model <model>',
      'Specify AI model for a Copilot, Antigravity or Claude agent. For Antigravity and Claude it is a launch'
        + ' flag: it applies only when this send starts the session, and a running session answers 400'
    )
    .option('--auto-yes', 'Enable auto-yes before sending (session-wide, no policy guard; for unattended runs prefer --contract with an autoYes policy)')
    .option('--auto-yes-answer-mode <mode>', `With --auto-yes: ${ANSWER_MODE_OPTION_DESCRIPTION}`)
    .option('--duration <duration>', `Auto-yes duration (${AUTO_YES_DURATION_FLAG_RANGE}, e.g. 1h, 3h, 8h; default ${DEFAULT_DURATION_FLAG})`)
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

--role / --no-role (Issue #4116): a role is fixed when the process starts, so this is
a condition, not a switch. The setting is saved for the instance first. A session that
is not running starts with it; a running one gets the message only if it was started
with exactly what that setting injects. A different role, or a process whose start
this server has no record of (after a server restart), is exit 32 with nothing typed,
and the setting stays saved: stop the session (\`instances <wt> kill <id>\`) and send
again, with no --role needed. A role names an instance on the roster: an ad-hoc id
needs --register as well.

--register --role creates the instance and its role together BEFORE sending, so the
first start has it. Repeating that command creates nothing: --role replaces what the
instance holds and is a condition as above. A changed roster is exit 31, nothing sent.
--register without a role keeps its old order (sent, then registered) and never
touches a role already there.

--expect-* pin this send to what the caller read earlier, saving nothing; the server
reads them again right before the first key, so a process replaced in between gets
nothing (exit 32). \`launch-worker\` passes what its starting message fixed. With
--contract too, the contract is recorded as a failed task.

With a role or a pin, --auto-yes does not outlive a refusal: a grant this send armed is
withdrawn when nothing was typed, and a grant already on is left as it was until the
message is in. --contract --role saves the role before the contract's own check if that
check would refuse it, so it behaves like send --role; a broken contract saves nothing.

Exit codes: 2 usage, or an unknown or ambiguous role, or a tool roles do not apply to
(nothing sent); 31 a roster conflict (nothing sent); 32 the role condition does not
hold or the start was refused because of its role (nothing typed).
`)
    .action(async (worktreeId: string, message: string | undefined, options: SendOptions) => {
      try {
        const autoYesDurationMs = validateSendArgs(worktreeId, message, options);
        if (bothRoleFlags()) throw usageError('Give --role or --no-role, not both.');
        const expectedRole = expectedRoleOf(options);

        const client = new ApiClient({ token: options.token });

        // Issue #1629: --instance names an agent instance, not a CLI tool, and
        // the roster is the only place that pairs the two. Resolve it once, up
        // front, so the task row, the send and auto-yes all name the same tool
        // as the session that actually starts.
        const commandTarget = await resolveCommandTarget(client, worktreeId, options.instance, options.agent);
        const { agent, instanceId } = commandTarget;
        // Issue #2376: the RESOLVED id, never the string the user typed.
        // `--instance "Codex 2"` has to reach /send as `codex-2`; no route but
        // /resolve-target knows how to read an alias.

        validateSendModel(options, agent);

        // Issue #4116: named before anything with a side effect, so a role that does
        // not exist leaves no task row and no armed Auto-Yes behind.
        if (options.role !== undefined && agent !== undefined) assertRoleTool(agent);
        const roleAssignment = await roleAssignmentFromFlag(client, options.role);
        if (roleAssignment !== undefined && options.register && instanceId) {
          await registerInstanceWithRole(client, worktreeId, instanceId, options.agent ?? instanceId, roleAssignment);
        }

        // Issue #1545: resolve the contract before anything with a side effect,
        // so an invalid contract cannot leave auto-yes enabled for a message
        // that was never sent.
        let taskId: string | undefined;
        // Issue #3723: what the created contract lets Auto-Yes answer.
        let contractPolicy: AutoYesContractPolicy | null = null;
        let content = message;
        if (options.contract) {
          const task = await createContractTaskWithRole(client, worktreeId, options, agent, instanceId, roleAssignment);
          taskId = task.taskId;
          content = task.message;
          contractPolicy = task.contractPolicy;
          console.error(`Task created: ${taskId}`);
          console.log(taskId);
        }

        // A task whose message never arrived is a failed task, not a pending
        // one: nothing is working on it and nothing ever will. Every step
        // between the task row and the delivered message reports through this.
        const failTask = async (): Promise<void> => {
          if (taskId) {
            await reportTaskStatus(client, taskId, 'failed');
          }
        };

        // --auto-yes: enable auto-yes first (unless --model is specified, then after send) [DR2-02]
        //
        // Issue #2771: claude is the exception to the exception. The deferral
        // exists so Auto-Yes does not answer copilot's `/model` interaction; a
        // claude model is a launch flag with no interaction to protect, and a
        // contract send must have Auto-Yes on BEFORE the worker starts working.
        const deferAutoYes = Boolean(options.model) && agent !== 'claude';
        const registerRelay = async (): Promise<RegisteredRelay> => {
          const registered = await registerRelayForMessage(client, {
            worktreeId,
            replyTo: options.replyTo as string,
            instance: options.instance,
            agent: options.agent,
            allowRelayChain: options.allowRelayChain,
          });
          // stderr, not stdout: `--contract` already owns this command's stdout
          // (it prints the task id there), and two commands writing two ids to
          // one stream is how a `$(…)` capture ends up with both. `ask --async`
          // is the form that hands the relay id back on stdout.
          console.error(`Relay registered: ${registered.id}`);
          return registered;
        };

        // Issue #4116: a send with a role can be refused after Auto-Yes went on, and a
        // grant left behind answers a process this send never reached. So it looks
        // first. Already on: that grant goes on answering, untouched, and this send's
        // terms replace it only once the message is in. Off: armed now, and withdrawn
        // on a refusal. Its relay goes first too, because a refused relay exits on the
        // spot. A send saying nothing about a role reads nothing and is as it was.
        const conditional = roleAssignment !== undefined || expectedRole !== undefined;
        let relay: RegisteredRelay | undefined;
        if (options.replyTo && conditional) relay = await registerRelay();
        const armsNow = options.autoYes && !deferAutoYes;
        const priorAutoYes = armsNow && conditional ? await readPriorAutoYes(client, worktreeId, agent, instanceId) : false;
        const applyAutoYesAfterSend = options.autoYes && (deferAutoYes || priorAutoYes === true);
        if (armsNow && priorAutoYes !== true) {
          // Issue #3290: the server can refuse this — 409 when the session by
          // that name belongs to another CommandMate server — and the command
          // then stops here, after --contract created the task row and before
          // anything is sent. That is the outcome a failed send has, so it gets
          // the same record; left alone the row stayed `pending` for a message
          // that never went out, which is the state #1608 removed for a bad
          // --duration.
          try {
            await enableAutoYes(client, worktreeId, options, autoYesDurationMs, agent, instanceId, contractPolicy);
          } catch (error) {
            await failTask();
            if (relay) await cancelRelayQuietly(client, relay.id);
            throw error;
          }
        }

        /** Issue #4116: what a conditional send armed, once it is known to have typed nothing. */
        const withdrawAutoYes = async (error: unknown, outcome: FailedSendOutcome | null): Promise<void> => {
          if (!conditional || !armsNow || priorAutoYes === true) return;
          const manual = `commandmate auto-yes ${worktreeId} --disable${instanceId ? ` --instance ${instanceId}` : ''}`;
          if (priorAutoYes === null || !knownNotSent(error, outcome)) {
            console.error(`Warning: Auto-Yes stays on (it was not known to be off, or the message may have gone in). To turn it off: ${manual}`);
            return;
          }
          try {
            await client.post<unknown>(`/api/worktrees/${worktreeId}/auto-yes`, {
              enabled: false,
              ...(agent ? { cliToolId: agent } : {}),
              ...(instanceId ? { instanceId } : {}),
            });
            console.error('Auto-yes withdrawn: the message was not sent.');
          } catch {
            console.error(`Warning: could not withdraw Auto-Yes. To turn it off: ${manual}`);
          }
        };

        // Issue #2377: the relay is registered BEFORE the message goes out, so a
        // session that answers immediately cannot finish its turn in the window
        // between the send and the ledger row — the completion trigger reads the
        // ledger, and a row that does not exist yet is a reply nobody collects.
        // A refusal exits 2 here, having sent nothing.
        if (options.replyTo && !conditional) relay = await registerRelay();

        const sendBody = buildSendBody(content, agent, instanceId, options, {
          assignment: roleAssignment,
          expected: expectedRole,
        });

        // Issue #3957: a bound relay's id rides on the send, which reserves it
        // and records where the body went in.
        const sent = await postMessage(client, worktreeId, sendBody, {
          relay,
          onFailure: async (error, outcome) => {
            await failTask();
            await withdrawAutoYes(error, outcome);
          },
          promptWaitingFallback: promptWaitingFallback(worktreeId, commandTarget),
          target: commandTarget,
        });
        console.error('Message sent.');
        if (sent?.replacesDefaultInstructions) {
          console.error(`Note: on ${agent ?? 'this tool'}, the role replaces the tool's default instructions rather than adding to them.`);
        }
        // Not the server's sentence: it names an API field, and this command has no such flag.
        if (sent?.roleResume?.continued) {
          console.error(
            'Note: this conversation continues under a different role, and what the earlier role said stays in its history. '
              + 'The CLI cannot start a new conversation instead: stopping the session does not forget this one.'
          );
        }

        if (taskId) {
          await reportTaskStatus(client, taskId, 'running');
        }

        // Issue #1000: register the ad-hoc instance into the roster after the
        // session has started, so a follow-up `commandmate instances` lists it.
        // Issue #4116: with a role it was registered before the send.
        if (options.register && instanceId && roleAssignment === undefined) {
          await registerInstance(client, worktreeId, instanceId, options.agent ?? instanceId);
        }

        // Issue #576: Enable auto-yes AFTER send when --model is specified
        // This avoids auto-yes interfering with the /model command interaction.
        // A failure here does not fail the task: the message was delivered and
        // the task is running, which is what the row already says.
        if (applyAutoYesAfterSend) {
          await enableAutoYes(client, worktreeId, options, autoYesDurationMs, agent, instanceId, contractPolicy);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
