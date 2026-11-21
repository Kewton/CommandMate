/**
 * `--contract` task creation and target pinning for `send`, split out of `send.ts`
 * (Issue #4128).
 */

import { ExitCode, RoleExitCode } from '../types';
import type { SendOptions } from '../types';
import type { AutoYesContractPolicy, TaskCreateResponse, TaskView } from '../types/api-responses';
import { ApiClient, ApiError, assertResponseShape } from '../utils/api-client';
import { roleFailureFromApi, RoleCliError, roleWrite } from '../utils/agent-roles';
import { resolveInstanceTarget } from './instances';
import type { CommandTarget } from './command-target';
import type {
  InstanceRoleSettingsResponse,
  RoleAssignmentInput,
} from '../../types/agent-roles';
import { writePolicyFields } from './send-write-policy';
import type { RelayEndpointArg } from './relays';

/**
 * The `autoYes` block of a just-created task in the shape `describeContractPolicy`
 * reads (Issue #3723), or null when the response carries none. Read defensively:
 * `contract_json` is replayed verbatim, never re-validated.
 */
export function contractPolicyOf(task: TaskView): AutoYesContractPolicy | null {
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
export async function createContractTask(
  client: ApiClient,
  worktreeId: string,
  options: SendOptions,
  agent: string | undefined,
  instanceId: string | undefined,
  replyTo: RelayEndpointArg | undefined
): Promise<{ task: TaskView; message: string; contractPolicy: AutoYesContractPolicy | null }> {
  const body: Record<string, unknown> = { contractPath: options.contract };
  if (agent) {
    body.cliToolId = agent;
  }
  if (instanceId) {
    body.instanceId = instanceId;
  }
  // Issue #4449: the tool policy judges the target this request writes the row for,
  // and refuses (exit 33) before the row exists — no ask before it that could fail.
  Object.assign(body, writePolicyFields(agent, replyTo, options.autoYes));

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
    if (typeof created.roleWarning === 'string') console.error(`Warning: ${created.roleWarning}`);
    return {
      task: created.task,
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
export async function effectiveTarget(
  client: ApiClient,
  worktreeId: string,
  agent: string | undefined,
  instanceId: string | undefined
): Promise<{ cliToolId: string | undefined; instanceId: string | undefined }> {
  const cliToolId = agent ?? (await resolveInstanceTarget(client, worktreeId, undefined, undefined)).cliToolId;
  return { cliToolId, instanceId: instanceId ?? cliToolId };
}

/**
 * The target of a conditional send that makes several requests about it (Issue #4116),
 * named in all of them. Left to the server, each resolves the default for itself: a
 * default moved from A to B between two of them has a read of A, a grant on B, a save on
 * A and a message to B. So a refusal could then withdraw B's grant on A's evidence.
 */
export async function pinCommandTarget(client: ApiClient, worktreeId: string, target: CommandTarget): Promise<CommandTarget> {
  const pinned = await effectiveTarget(client, worktreeId, target.agent, target.instanceId);
  return { ...target, agent: pinned.cliToolId, instanceId: pinned.instanceId };
}

/**
 * `--contract` with a role (Issue #4116): the task check compares the process with
 * the SETTINGS, so `--role A` to a process running A while the setting says B would be
 * refused for a setting this very command is replacing. A plain `send --role` saves,
 * then checks; refused here, this does the same and checks again. Only then, because
 * the contract is read first: a broken contract saves nothing.
 *
 * The save has what `POST /send` has before its own: the roster and the tool read
 * again, against what this command was resolved to. Anything moved is exit 31 with
 * nothing saved, up to the PUT itself, which carries the revision read (#4132). A change
 * after that is seen only in its answer, which is then told. From the save on, anything
 * that ends this command leaves the setting saved, so it is said right then. A PUT with
 * no usable answer may have saved too, which {@link roleWrite} says.
 */
export async function createContractTaskWithRole(
  client: ApiClient,
  worktreeId: string,
  options: SendOptions,
  agent: string | undefined,
  instanceId: string | undefined,
  role: RoleAssignmentInput | undefined,
  replyTo: RelayEndpointArg | undefined
): ReturnType<typeof createContractTask> {
  if (role === undefined) return createContractTask(client, worktreeId, options, agent, instanceId, replyTo);
  const target = await effectiveTarget(client, worktreeId, agent, instanceId);
  const url = `/api/worktrees/${worktreeId}/instances/roles`;
  const resolved = await client.get<InstanceRoleSettingsResponse>(url);
  const toolOf = (settings: InstanceRoleSettingsResponse): string | undefined =>
    settings.instances.find((instance) => instance.instanceId === target.instanceId)?.cliToolId;
  try {
    return await createContractTask(client, worktreeId, options, agent, instanceId, replyTo);
  } catch (error) {
    if (!(error instanceof RoleCliError) || error.code !== 'ROLE_CONDITION_UNMET') throw error;
  }
  const rosterChanged = (message: string, details: Record<string, unknown> = {}): RoleCliError =>
    new RoleCliError('roster_changed', message, RoleExitCode.CONFLICT, details);
  const now = await client.get<InstanceRoleSettingsResponse>(url);
  const toolThen = toolOf(resolved) ?? target.cliToolId;
  if (now.rosterRevision !== resolved.rosterRevision || (toolOf(now) ?? toolThen) !== target.cliToolId) {
    throw rosterChanged('The roster changed while this contract was being checked; nothing was saved or typed. Send it again.');
  }
  let saved: InstanceRoleSettingsResponse;
  try {
    saved = await roleWrite(`commandmate instances ${worktreeId}`, async () =>
      assertResponseShape<InstanceRoleSettingsResponse>(
        await client.put<unknown>(url, {
          instanceId: target.instanceId,
          role,
          expectedRosterRevision: now.rosterRevision,
          // Issue #4449: refused by the tool policy here, with nothing saved.
          ...writePolicyFields(target.cliToolId, replyTo, options.autoYes),
        }),
        ['instances'],
        'PUT /api/worktrees/:id/instances/roles'
      )
    );
  } catch (error) {
    if (!(error instanceof RoleCliError) || error.code !== 'roster_changed') throw error;
    // Worth a read to say what moved. If it cannot be read, the refusal has said enough.
    const latest = await client.get<InstanceRoleSettingsResponse>(url).catch(() => null);
    const toolNow = latest && toolOf(latest);
    throw rosterChanged(
      latest === null || toolNow === target.cliToolId
        ? 'The roster changed right before the save; nothing was saved or typed. Send it again.'
        : `The role was not saved for ${target.instanceId}, which is now ${toolNow ?? 'not on the roster'}, not ${target.cliToolId}; `
          + 'nothing was typed. Send it again.'
    );
  }
  const savedTool = toolOf(saved);
  if (savedTool !== target.cliToolId) {
    throw rosterChanged(
      `The role was saved for ${target.instanceId}, which is now ${savedTool ?? 'not on the roster'}, not ${target.cliToolId}; `
        + `nothing was typed. Check it with: commandmate instances ${worktreeId}`,
      { roleSettings: { saved: true } }
    );
  }
  console.error(`Role saved for ${target.instanceId} ahead of the contract's check; it stays saved if this send goes no further.`);
  return createContractTask(client, worktreeId, options, agent, instanceId, replyTo);
}
