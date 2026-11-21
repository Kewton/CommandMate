/**
 * Synchronous decisions, assertions and reports the `send` action makes between its
 * awaits, split out of `send.ts` (Issue #4128). Nothing here awaits: the waits stay
 * in the action, and only the judgement after them lives here.
 */

import { ExitCode } from '../types';
import type { SendOptions } from '../types';
import type { AutoYesContractPolicy, AutoYesSetResult, ChatMessage, TaskView } from '../types/api-responses';
import { ApiError } from '../utils/api-client';
import { handleCommandError } from '../utils/command-helpers';
import { assertRoleTool, usageError } from '../utils/agent-roles';
import { isValidInstanceId as isRosterInstanceId } from '../../lib/cli-tools/types';
import {
  flushClientWarnings,
  isToolPolicyDenied,
  reportToolPolicyDenial,
  toolPolicyDenialFromResponse,
} from '../utils/tool-policy-failure';
import type { RoleAssignmentInput } from '../../types/agent-roles';
import type { CommandTarget } from './command-target';
import type { RegisteredRelay, RelayEndpointArg } from './relays';
import type { SessionIdentity } from './whoami';
import type { RelayEndpoints } from './message-dispatch';
import { reportModelRefusal } from './send-model-refusal';

/** `--role` and `--no-role` were both given. */
export function assertRoleFlagChoice(bothRoleFlags: () => boolean): void {
  if (bothRoleFlags()) throw usageError('Give --role or --no-role, not both.');
}

/**
 * Issue #4458: --register saves this id into the roster, and the roster write
 * refuses an id outside its rules. Refused here, by the same rule, before anything
 * is sent: after the send it could only be a warning.
 */
export function assertRegisterTargetId(register: boolean | undefined, instanceId: string | undefined): void {
  if (register && instanceId !== undefined && !isRosterInstanceId(instanceId)) {
    console.error(
      `Error: --register needs an instance id the roster accepts, and '${instanceId}' is not one `
        + '(letters, digits, _ or -, at most 64 characters). Nothing was sent.'
    );
    process.exit(ExitCode.CONFIG_ERROR);
  }
}

/** The instance id `--register` has to ask the server about before the send, or null. */
export function candidateRowTarget(
  register: boolean | undefined,
  instanceId: string | undefined
): { instanceId: string } | null {
  return register && instanceId !== undefined ? { instanceId } : null;
}

/** The tool `--register` records: `--agent`, else the instance id itself. */
export function registerToolOr(agent: string | undefined, instanceId: string): string {
  return agent ?? instanceId;
}

export function assertNoteAuthor(noteAuthor: SessionIdentity | null): void {
  if (!noteAuthor) {
    console.error('Error: --note needs a session identity (run it inside a CommandMate session). Nothing was sent.');
    process.exit(ExitCode.CONFIG_ERROR);
  }
}

export function isConditionalSend(options: SendOptions, expectedRole: Record<string, unknown> | undefined): boolean {
  return options.role !== undefined || expectedRole !== undefined;
}

export function pinsSendTarget(options: SendOptions, conditional: boolean): boolean {
  return Boolean(options.newConversation)
    || (conditional && Boolean(options.autoYes || options.contract || options.replyTo));
}

/**
 * Issue #2771: claude is the exception to the exception. The deferral
 * exists so Auto-Yes does not answer copilot's `/model` interaction; a
 * claude model is a launch flag with no interaction to protect, and a
 * contract send must have Auto-Yes on BEFORE the worker starts working.
 */
export function defersAutoYes(options: SendOptions, agent: string | undefined): boolean {
  return Boolean(options.model) && agent !== 'claude';
}

/**
 * Issue #4226 (P3-2): a --note send that arms Auto-Yes reads its state first, and
 * the state is read for a named instance. With none (`--agent` alone, nothing
 * pinned) there is nothing to read, ever: an input error, before any side effect.
 */
export function assertNoteAutoYesTarget(
  options: SendOptions,
  deferAutoYes: boolean,
  agent: string | undefined,
  instanceId: string | undefined
): void {
  if (options.note !== undefined && Boolean(options.autoYes) && !deferAutoYes && (!agent || !instanceId)) {
    console.error('Error: --note with --auto-yes needs --instance <id> (the Auto-Yes state of that instance is read first). Nothing was sent.');
    process.exit(ExitCode.CONFIG_ERROR);
  }
}

/**
 * Issue #4116: named before anything with a side effect, so a role that does
 * not exist leaves no task row and no armed Auto-Yes behind.
 */
export function assertRoleToolForSend(options: SendOptions, agent: string | undefined): void {
  if (options.role !== undefined && agent !== undefined) assertRoleTool(agent);
}

export function relayTargetOf(
  worktreeId: string,
  pinsTarget: boolean,
  commandTarget: CommandTarget,
  options: SendOptions
): { worktreeId: string; instance: string | undefined; agent: string | undefined } {
  return {
    worktreeId,
    instance: pinsTarget ? commandTarget.instanceId : options.instance,
    agent: pinsTarget ? commandTarget.agent : options.agent,
  };
}

/** `--register --role` with the instance and role it names, or null when it does not run. */
export function roleRegistrationTarget(
  roleAssignment: RoleAssignmentInput | undefined,
  options: SendOptions,
  instanceId: string | undefined
): { instanceId: string; role: RoleAssignmentInput } | null {
  return roleAssignment !== undefined && options.register && instanceId
    ? { instanceId, role: roleAssignment }
    : null;
}

/** The `--reply-to` to resolve endpoints for first, or null when none has to be. */
export function relayEndpointsReplyTo(options: SendOptions, registersWithRole: boolean): string | null {
  return options.replyTo && (options.contract || options.autoYes || registersWithRole) ? options.replyTo : null;
}

/** What `--contract` left for the message and the grant, from the created task. */
export function contractTaskOutcome(
  task: { task: TaskView; message: string; contractPolicy: AutoYesContractPolicy | null },
  agent: string | undefined,
  instanceId: string | undefined
): { taskId: string; content: string; contractPolicy: AutoYesContractPolicy | null; boundTaskId: string | undefined } {
  const taskId = task.task.id;
  if (agent === undefined && instanceId === undefined) {
    return { taskId, content: task.message, contractPolicy: task.contractPolicy, boundTaskId: taskId };
  }
  return { taskId, content: task.message, contractPolicy: task.contractPolicy, boundTaskId: undefined };
}

export function shouldRegisterRelayBefore(options: SendOptions, conditional: boolean): boolean {
  return Boolean(options.replyTo) && conditional;
}

export function isArmedNow(options: SendOptions, deferAutoYes: boolean): boolean {
  return Boolean(options.autoYes) && !deferAutoYes;
}

export function autoYesReadTarget(
  armsNow: boolean,
  conditional: boolean,
  options: SendOptions,
  agent: string | undefined,
  instanceId: string | undefined
): { cliToolId: string | undefined; instanceId: string | undefined } | null {
  return armsNow && (conditional || options.replyTo) ? { cliToolId: agent, instanceId } : null;
}

export function autoYesStateTarget(
  target: { cliToolId: string | undefined; instanceId: string | undefined } | null
): { cliToolId: string; instanceId: string } | null {
  if (!target?.cliToolId || !target.instanceId) return null;
  return { cliToolId: target.cliToolId, instanceId: target.instanceId };
}

export function initialPriorAutoYes(
  target: { cliToolId: string | undefined; instanceId: string | undefined } | null,
  priorState: Partial<AutoYesSetResult> | null
): boolean | null {
  if (target === null) return false;
  return typeof priorState?.enabled === 'boolean' ? priorState.enabled : null;
}

/**
 * Off when read, so it can only be armed if it is off still: overwriting a grant armed
 * since would make it this send's to withdraw.
 */
export function onlyIfOffFor(
  conditional: boolean,
  target: { cliToolId: string | undefined; instanceId: string | undefined } | null,
  priorAutoYes: boolean | null
): boolean {
  return conditional || (target !== null && priorAutoYes === false);
}

/**
 * Issue #4226: a --note send undoes its grant when mem refuses the note, which needs
 * the state before it. Not known, it stops here, before the grant (design §6.2).
 */
export function stopsForUnknownAutoYes(options: SendOptions, armsNow: boolean, priorAutoYes: boolean | null): boolean {
  return options.note !== undefined && armsNow && priorAutoYes === null;
}

export function shouldArmAutoYes(armsNow: boolean, priorAutoYes: boolean | null): boolean {
  return armsNow && priorAutoYes !== true;
}

/**
 * Issue #4132: a grant armed since that read. It is theirs: it stays as it
 * is, and this is now the send that found one on.
 */
export function isAutoYesRace(error: unknown, onlyIfOff: boolean): boolean {
  return !onlyIfOff || !(error instanceof ApiError) || error.apiCode !== 'AUTO_YES_ALREADY_ENABLED';
}

/**
 * Issue #4437 (re-instruction 3): the Auto-Yes route refuses antigravity with
 * its own 409 TOOL_POLICY_DENIED (#4436), and the relay of --reply-to with
 * RELAY_TOOL_POLICY_DENIED (#4449). The same refusal as the send's: exit 33,
 * reason first.
 */
export function autoYesDenialOf(
  error: unknown,
  agent: string | undefined,
  instanceId: string | undefined
): ReturnType<typeof toolPolicyDenialFromResponse> | null {
  return error instanceof ApiError
    ? toolPolicyDenialFromResponse(error.statusCode ?? 0, error.payload, { cliToolId: agent, instanceId })
    : null;
}

/** Throw the policy refusal the Auto-Yes route answered with, else the error itself. */
export function rethrowAutoYes(error: unknown, denial: ReturnType<typeof toolPolicyDenialFromResponse> | null): never {
  throw denial ?? error;
}

/** Issue #4449: the relay not opened yet is judged with the grant, before it is written. */
export function autoYesRelayEndpoint(
  relay: RegisteredRelay | undefined,
  relayEndpoints: RelayEndpoints | undefined
): RelayEndpointArg | undefined {
  return relay ? undefined : relayEndpoints?.from;
}

export function appliesAutoYesAfterSend(options: SendOptions, deferAutoYes: boolean, priorAutoYes: boolean | null): boolean {
  return Boolean(options.autoYes) && (deferAutoYes || priorAutoYes === true);
}

export function shouldRegisterRelayAfter(options: SendOptions, conditional: boolean): boolean {
  return Boolean(options.replyTo) && !conditional;
}

/** The `--note` write to make, or null when it does not run. */
export function noteToWrite(
  options: SendOptions,
  noteAuthor: SessionIdentity | null,
  relay: RegisteredRelay | undefined
): { author: SessionIdentity; relay: RegisteredRelay; note: string } | null {
  return options.note !== undefined && noteAuthor && relay
    ? { author: noteAuthor, relay, note: options.note }
    : null;
}

/**
 * Issue #4449 (I2): the message of a --contract send naming no target goes to the
 * target its task was judged and created for — the server reads it from the task,
 * so a default changed since the task is not resolved again. The body still names
 * nobody (#4116); a send that names its target already pins it.
 */
export function withBoundTask(sendBody: Record<string, unknown>, boundTaskId: string | undefined): Record<string, unknown> {
  if (boundTaskId) sendBody.taskId = boundTaskId;
  return sendBody;
}

export function reportSendNotes(
  sent: ChatMessage,
  worktreeId: string,
  agent: string | undefined,
  instanceId: string | undefined
): void {
  if (sent?.replacesDefaultInstructions) {
    console.error(`Note: on ${agent ?? 'this tool'}, the role replaces the tool's default instructions rather than adding to them.`);
  }
  // Not the server's sentence: it names an API field, and this command has no such flag.
  if (sent?.roleResume?.continued) {
    console.error(
      'Note: this conversation continues under a different role, and what the earlier role said stays in its history. '
        + 'The CLI cannot start a new conversation on a running session, and stopping it does not forget this one: '
        + `stop it (\`commandmate instances ${worktreeId} kill ${instanceId ?? agent ?? '<instance-id>'}\`) and send with --new-conversation.`
    );
  }
}

/** Report a failed send the way this command always has. */
export function handleSendFailure(error: unknown, options: SendOptions, worktreeId: string): void {
  // Issue #4437: the send or its relay refused by the tool policy: exit 33.
  if (isToolPolicyDenied(error)) {
    reportToolPolicyDenial(error, { worktreeId });
    return;
  }
  flushClientWarnings();
  if (reportModelRefusal(error, options)) return;
  handleCommandError(error);
}
