/**
 * Option validation and request-body building for `send`, split out of `send.ts`
 * (Issue #4128).
 */

import { ExitCode } from '../types';
import type { SendOptions } from '../types';
import type { CurrentOutputResponse } from '../types/api-responses';
import { isValidWorktreeId, MAX_STOP_PATTERN_LENGTH, type ApiClient } from '../utils/api-client';
import { isCliToolId, CLI_TOOL_IDS } from '../config/cli-tool-ids';
import {
  validateCopilotModelName,
  validateAntigravityModelName,
  validateClaudeModelName,
} from '../config/model-validation';
import { isInstanceSelector, INSTANCE_SELECTOR_ERROR } from './instances';
import { validateAnswerModeOption } from './auto-yes';
import { usageError } from '../utils/agent-roles';
import type { RoleAssignmentInput } from '../../types/agent-roles';
import { resolveAutoYesDurationMs } from './send-auto-yes';

/** Option checks before any side effect. Returns --duration in ms. A mocked `process.exit` returns, so nothing here stops early. */
export function validateSendArgs(worktreeId: string, message: string | undefined, options: SendOptions): number {
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

  // Issue #4226: a note is about the reply this send waits for, so it needs the relay.
  if (options.note !== undefined && !options.replyTo) {
    console.error('Error: --note needs --reply-to (the note is kept with the relay it waits on). Nothing was sent.');
    process.exit(ExitCode.CONFIG_ERROR);
  }

  // Issue #4274: one send cannot both carry the brief and skip it.
  if (options.brief === false && options.withBrief) {
    console.error('Error: give --with-brief or --no-brief, not both. Nothing was sent.');
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
export function validateSendModel(options: SendOptions, agent: string | undefined): void {
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
export function expectedRoleOf(options: SendOptions): Record<string, unknown> | undefined {
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

/**
 * `--new-conversation` applies to a stopped OpenCode V1 session and nothing else
 * (Issue #4133). `POST /send` ignores the field anywhere else, without saying so, so
 * this is the only place that can refuse it. Read before anything with a side effect.
 *
 * What remains: a start between this read and the send. Closing that takes the API.
 *
 * @throws A usage error (exit 2) for anything but a session known to be stopped
 */
export async function assertNewConversationApplies(
  client: ApiClient,
  worktreeId: string,
  agent: string | undefined,
  instanceId: string | undefined
): Promise<void> {
  if (agent !== 'opencode') {
    throw usageError(
      `--new-conversation applies only to OpenCode V1 (opencode), the one tool that resumes a remembered conversation; this send addresses ${agent ?? 'no tool'}. Nothing was sent.`
    );
  }
  const instance = instanceId ?? agent;
  const query = new URLSearchParams({ cliTool: agent, instance });
  const { isRunning, startingSince } = await client.get<CurrentOutputResponse>(`/api/worktrees/${worktreeId}/current-output?${query.toString()}`);
  // Ahead of isRunning, which can be false during a launch: that is not "stopped".
  // Absent on a server that predates the field, and then isRunning is all there is.
  if (startingSince !== undefined && startingSince !== null) {
    throw usageError(
      `--new-conversation applies when a session starts, and ${instance} is still starting. Nothing was sent. Stop it first: commandmate instances ${worktreeId} kill ${instance}`
    );
  }
  if (isRunning === true) {
    throw usageError(
      `--new-conversation applies when a session starts, and ${instance} is running. Nothing was sent. Stop it first: commandmate instances ${worktreeId} kill ${instance}`
    );
  }
  if (isRunning !== false) {
    throw usageError(`--new-conversation needs ${instance} stopped, and the server did not say whether it is. Nothing was sent.`);
  }
}

/** The `/send` request body. */
export function buildSendBody(
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
  // Issue #4133: sent only when asked for, and checked by the CLI first.
  if (options.newConversation) {
    sendBody.newConversation = true;
  }
  // Issue #4274: sent only when asked for, so a plain send is the body it was.
  if (options.brief === false) {
    sendBody.brief = 'skip';
  } else if (options.withBrief) {
    sendBody.brief = 'force';
  }
  return sendBody;
}
