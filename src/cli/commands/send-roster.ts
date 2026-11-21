/**
 * `send --register` roster writes, split out of `send.ts` (Issue #4128).
 */

import { ExitCode } from '../types';
import { ApiClient, ApiError } from '../utils/api-client';
import {
  fetchAgentRoster,
  saveRosterChange,
  defaultAlias,
  rosterAdditionRefusal,
  MAX_AGENT_INSTANCES,
  MAX_AGENT_ALIAS_LENGTH,
} from '../utils/agent-instances';
import { RoleCliError, roleWrite } from '../utils/agent-roles';
import type {
  InstanceRoleCreateResponse,
  InstanceRoleSettingsResponse,
  RoleAssignmentInput,
} from '../../types/agent-roles';
import { writePolicyFields } from './send-write-policy';
import type { RelayEndpointArg } from './relays';

/**
 * Register an ad-hoc --instance session into the agent-instance roster
 * (Issue #1000: --register). No-ops when already registered so `send
 * --register` is safe to repeat across multiple messages to the same instance.
 *
 * This runs after the message went out, so whatever fails here (a roster that keeps moving,
 * Issue #4149; anything else, Issue #4159) is a warning and the send stays a success: an
 * error exit reads as "not sent", and a script reading it would send the message twice.
 */
export async function registerInstance(
  client: ApiClient,
  worktreeId: string,
  instanceId: string,
  cliTool: string
): Promise<void> {
  const addCommand = registerCommandFor(worktreeId, cliTool, instanceId);
  try {
    // Issue #4132: the whole list is replaced, so an add landing after this read has to
    // survive it. Built again on a moved roster, where this one may be there by now.
    const roster = await fetchAgentRoster(client, worktreeId);
    const saved = await saveRosterChange(client, worktreeId, roster, (base) => {
      if (base.some((inst) => inst.id === instanceId)) return null;
      const added = { id: instanceId, cliTool, alias: defaultAlias(cliTool, instanceId), order: base.length };
      // Issue #4458: the limit, the room under it and the id rules are the server's
      // validator's, asked here, so this neither refuses a row the save would take nor
      // sends one it would refuse (and then hides why behind a generic 400).
      const refusal = rosterAdditionRefusal(base, added);
      if (refusal?.atLimit) {
        console.error(
          `Warning: the message was sent, but could not register '${instanceId}' in the roster (already at the ${MAX_AGENT_INSTANCES}-instance limit). `
            + `Do not send it again. Make room, then: ${addCommand}`
        );
        return null;
      }
      if (refusal) {
        console.error(
          `Warning: the message was sent, but could not register '${instanceId}' in the roster: the server would refuse it (${refusal.error}). `
            + `Do not send it again. To register it: ${addCommand}`
        );
        return null;
      }
      return [...base, added as (typeof base)[number]];
    });
    if (saved !== null) console.error(`Instance registered in roster: ${instanceId}`);
  } catch (error) {
    if (error instanceof RoleCliError && error.code === 'roster_changed') {
      console.error(`Warning: the message was sent, but '${instanceId}' was not added to the roster: it kept changing. Do not send it again. To register it: ${addCommand}`);
      return;
    }
    // A save answered by a 5xx or not at all may have happened, so this does not say it did not.
    // Issue #4458: the server's own sentence too, which a 400 otherwise hides.
    const serverReason = error instanceof ApiError ? error.payload?.error : undefined;
    const reason = `${error instanceof Error ? error.message : String(error)}`
      + (typeof serverReason === 'string' && serverReason.length > 0 ? ` ${serverReason}` : '');
    console.error(
      `Warning: the message was sent, but registering '${instanceId}' in the roster failed, so it may not be there (${reason}). `
        + `Do not send it again. Check with \`commandmate instances ${worktreeId}\`. To register it: ${addCommand}`
    );
  }
}

/** Whether the alias `--register` gives `instanceId` is longer than the roster takes (Issue #4458). */
export function defaultAliasTooLong(cliTool: string, instanceId: string): boolean {
  return defaultAlias(cliTool, instanceId).length > MAX_AGENT_ALIAS_LENGTH;
}

/**
 * The command that registers the instance by hand, as `--register` would have. When the
 * default alias is longer than the roster takes, it names a short `--alias`, so the
 * command does what it says instead of failing for the same reason (Issue #4458).
 */
export function registerCommandFor(worktreeId: string, cliTool: string, instanceId: string): string {
  const command = `commandmate instances ${worktreeId} add --agent ${cliTool} --id ${instanceId}`;
  if (!defaultAliasTooLong(cliTool, instanceId)) return command;
  const short = defaultAlias(cliTool, instanceId).slice(0, MAX_AGENT_ALIAS_LENGTH).trimEnd();
  return `${command} --alias "${short}"`;
}

/**
 * `--register` before anything is sent (Issue #4458): the candidate row on its own (its
 * default alias above all, which the tool and the id alone decide), refused here with
 * exit 2 rather than warned about after the message went out. The room left is not asked
 * here: the limit of a plain --register stays a warning after the send (I3).
 *
 * J2: a send to an instance already on the roster registers nothing, so it must behave as
 * a send without --register. The roster is read only when the candidate would be refused,
 * and a read that fails does not hold the send up (the registration after it says what it
 * finds).
 */
export async function assertCandidateRowFits(
  client: ApiClient,
  worktreeId: string,
  instanceId: string,
  cliTool: string
): Promise<void> {
  const refusal = rosterAdditionRefusal([], { id: instanceId, cliTool, alias: defaultAlias(cliTool, instanceId) });
  if (refusal === null) return;
  let onRoster: boolean;
  try {
    onRoster = (await fetchAgentRoster(client, worktreeId)).instances.some((inst) => inst.id === instanceId);
  } catch {
    return;
  }
  if (onRoster) return;
  if (defaultAliasTooLong(cliTool, instanceId)) {
    console.error(
      `Error: --register would name '${instanceId}' '${defaultAlias(cliTool, instanceId)}', longer than the `
        + `${MAX_AGENT_ALIAS_LENGTH} characters an alias may have, so the roster would refuse it. Nothing was sent. `
        + `Register it with a shorter alias, then send without --register: ${registerCommandFor(worktreeId, cliTool, instanceId)}`
    );
  } else {
    console.error(
      `Error: --register could not add '${instanceId}' to the roster: the server would refuse it (${refusal.error}). `
        + `Nothing was sent. To register it: ${registerCommandFor(worktreeId, cliTool, instanceId)}`
    );
  }
  process.exit(ExitCode.CONFIG_ERROR);
}

/**
 * `--register` with a role: the instance and its role are created together, before
 * anything goes out, so the first start already has it (Issue #4116). Without a role
 * the order stays as it was: sent, then {@link registerInstance}.
 *
 * Repeating the command creates nothing. The role on the send replaces what the
 * instance holds, and is then a condition like any `--role`.
 *
 * Issue #4449: the server judges the send this registration is for (the tool policy,
 * and the relay of `--reply-to`) and refuses with exit 33 before creating anything.
 *
 * @throws The roster changed since it was read (exit 31), or the server refused
 */
export async function registerInstanceWithRole(
  client: ApiClient,
  worktreeId: string,
  instanceId: string,
  cliTool: string,
  role: RoleAssignmentInput,
  replyTo: RelayEndpointArg | undefined,
  autoYes: boolean | undefined
): Promise<void> {
  const url = `/api/worktrees/${worktreeId}/instances/roles`;
  const { instances, rosterRevision } = await client.get<InstanceRoleSettingsResponse>(url);
  if (instances.some((instance) => instance.instanceId === instanceId)) return;
  // Issue #4458: the server's own judgment of the row, before the POST and before anything
  // is sent, as for a plain --register (the limit, the id, the alias length).
  const alias = defaultAlias(cliTool, instanceId);
  const base = instances.map((instance, order) => ({
    id: instance.instanceId,
    cliTool: instance.cliToolId,
    alias: instance.alias,
    order,
  }));
  const refusal = rosterAdditionRefusal(base, { id: instanceId, cliTool, alias });
  if (refusal) {
    const addCommand = registerCommandFor(worktreeId, cliTool, instanceId);
    console.error(
      refusal.atLimit
        ? `Error: could not register '${instanceId}' in the roster (already at the ${MAX_AGENT_INSTANCES}-instance limit). `
          + `Nothing was written or sent. Make room, then: ${addCommand}`
        : `Error: could not register '${instanceId}' in the roster: the server would refuse it (${refusal.error}). `
          + `Nothing was written or sent. To register it: ${addCommand}`
    );
    process.exit(ExitCode.CONFIG_ERROR);
  }
  try {
    await roleWrite(`commandmate instances ${worktreeId}`, () =>
      client.post<InstanceRoleCreateResponse>(url, {
        instance: { id: instanceId, cliTool, alias },
        role,
        expectedRosterRevision: rosterRevision,
        // Issue #4449: refused by the tool policy here, with nothing created.
        ...writePolicyFields(cliTool, replyTo, autoYes),
      })
    );
  } catch (error) {
    // Another send got there first; what remains is the same as a repeat.
    if (error instanceof ApiError && error.payload?.error === 'instance_exists') return;
    throw error;
  }
  console.error(`Instance registered in roster: ${instanceId}`);
}
