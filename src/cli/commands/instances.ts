/**
 * instances Command - Discover and manage a worktree's agent-instance roster
 * Issue #1000: CLI parity for the "1 agent, multiple sessions" feature (#868/#869)
 *
 *   commandmate instances <worktree-id>                                   # list (default)
 *   commandmate instances <worktree-id> add --agent <tool> [--alias <n>]
 *   commandmate instances <worktree-id> remove <instance-id> [--kill]
 *   commandmate instances <worktree-id> alias <instance-id> <new-alias>
 *   commandmate instances <worktree-id> kill <instance-id>
 */

import { Command } from 'commander';
import { ExitCode, getErrorMessage } from '../types';
import type { InstancesOptions } from '../types';
import type { AgentInstance } from '../types/api-responses';
import { ApiClient, isValidWorktreeId, isValidInstanceId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { isCliToolId } from '../config/cli-tool-ids';
import {
  fetchAgentInstances,
  saveAgentInstances,
  nextInstanceId,
  defaultAlias,
  MAX_AGENT_INSTANCES,
  MAX_AGENT_ALIAS_LENGTH,
  MIN_AGENT_INSTANCES,
} from '../utils/agent-instances';
import type { CurrentOutputResponse } from '../types/api-responses';

type InstanceRow = {
  instanceId: string;
  alias: string;
  cliTool: string;
  running: boolean;
  autoYes: boolean;
};

/**
 * Format instance rows as a table for terminal display.
 * [DR1-08 consistency] Mirrors ls.ts's formatTable().
 */
function formatInstancesTable(rows: InstanceRow[]): string {
  if (rows.length === 0) return 'No agent instances found.';

  const headers = ['INSTANCE_ID', 'ALIAS', 'CLI_TOOL', 'RUNNING', 'AUTO_YES'];
  const dataRows = rows.map(r => [
    r.instanceId,
    r.alias,
    r.cliTool,
    r.running ? 'yes' : 'no',
    r.autoYes ? 'yes' : 'no',
  ]);

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...dataRows.map(r => r[i].length))
  );

  const headerLine = headers.map((h, i) => h.padEnd(colWidths[i])).join('  ');
  const separator = colWidths.map(w => '-'.repeat(w)).join('  ');
  const dataLines = dataRows.map(r =>
    r.map((cell, i) => cell.padEnd(colWidths[i])).join('  ')
  );

  return [headerLine, separator, ...dataLines].join('\n');
}

/**
 * List action: roster + live running/auto-yes status per instance.
 * Probes GET .../current-output?cliTool=&instance= per instance (same
 * endpoint capture.ts uses) since the roster itself carries no session state.
 */
async function listInstances(worktreeId: string, options: InstancesOptions): Promise<void> {
  const client = new ApiClient({ token: options.token });
  const instances = await fetchAgentInstances(client, worktreeId);

  const rows: InstanceRow[] = await Promise.all(
    instances.map(async (inst): Promise<InstanceRow> => {
      const query = new URLSearchParams({ cliTool: inst.cliTool, instance: inst.id });
      const output = await client.get<CurrentOutputResponse>(
        `/api/worktrees/${worktreeId}/current-output?${query.toString()}`
      );
      return {
        instanceId: inst.id,
        alias: inst.alias,
        cliTool: inst.cliTool,
        running: output.isRunning,
        autoYes: output.autoYes?.enabled ?? false,
      };
    })
  );

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(formatInstancesTable(rows));
}

/**
 * Add action: append a new instance to the roster (PATCH full replacement).
 */
async function addInstance(worktreeId: string, options: InstancesOptions): Promise<void> {
  if (!options.agent) {
    console.error('Error: add requires --agent <tool>.');
    process.exit(ExitCode.CONFIG_ERROR);
  }
  if (!isCliToolId(options.agent)) {
    console.error('Error: Invalid --agent.');
    process.exit(ExitCode.CONFIG_ERROR);
  }
  if (options.id && !isValidInstanceId(options.id)) {
    console.error('Error: Invalid --id. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
    process.exit(ExitCode.CONFIG_ERROR);
  }
  if (options.alias && options.alias.length > MAX_AGENT_ALIAS_LENGTH) {
    console.error(`Error: --alias exceeds ${MAX_AGENT_ALIAS_LENGTH} characters.`);
    process.exit(ExitCode.CONFIG_ERROR);
  }

  const client = new ApiClient({ token: options.token });
  const existing = await fetchAgentInstances(client, worktreeId);

  if (existing.length >= MAX_AGENT_INSTANCES) {
    console.error(`Error: worktree already has the maximum of ${MAX_AGENT_INSTANCES} agent instances.`);
    process.exit(ExitCode.CONFIG_ERROR);
  }

  const id = options.id ?? nextInstanceId(options.agent, existing);
  if (existing.some(inst => inst.id === id)) {
    console.error(`Error: instance '${id}' already exists.`);
    process.exit(ExitCode.CONFIG_ERROR);
  }
  // Primary-anchor consistency (mirrors validateAgentInstancesInput on the
  // server): an id equal to a CLI tool id must back that exact tool.
  if (isCliToolId(id) && id !== options.agent) {
    console.error(`Error: instance id '${id}' conflicts with --agent '${options.agent}'.`);
    process.exit(ExitCode.CONFIG_ERROR);
  }

  const alias = options.alias ?? defaultAlias(options.agent, id);
  const next: AgentInstance[] = [...existing, { id, cliTool: options.agent, alias, order: existing.length }];
  await saveAgentInstances(client, worktreeId, next);

  console.error(`Instance added: ${id} (${options.agent})`);
  if (options.json) {
    console.log(JSON.stringify(next, null, 2));
  }
}

/**
 * Remove action: drop an instance from the roster. Kills the session first
 * (when --kill) so the server can still resolve its CLI tool from the roster.
 */
async function removeInstance(worktreeId: string, instanceId: string, options: InstancesOptions): Promise<void> {
  if (!isValidInstanceId(instanceId)) {
    console.error('Error: Invalid instance id. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
    process.exit(ExitCode.CONFIG_ERROR);
  }

  const client = new ApiClient({ token: options.token });
  const existing = await fetchAgentInstances(client, worktreeId);

  if (!existing.some(inst => inst.id === instanceId)) {
    console.error(`Error: instance '${instanceId}' not found in roster.`);
    process.exit(ExitCode.UNEXPECTED_ERROR);
  }
  if (existing.length <= MIN_AGENT_INSTANCES) {
    console.error('Error: cannot remove the last remaining agent instance.');
    process.exit(ExitCode.CONFIG_ERROR);
  }

  if (options.kill) {
    try {
      await client.post(`/api/worktrees/${worktreeId}/kill-session?instance=${encodeURIComponent(instanceId)}`);
      console.error(`Session killed: ${instanceId}`);
    } catch (killError) {
      console.error(`Warning: could not kill session for ${instanceId}: ${getErrorMessage(killError)}`);
    }
  }

  const next = existing.filter(inst => inst.id !== instanceId);
  await saveAgentInstances(client, worktreeId, next);
  console.error(`Instance removed from roster: ${instanceId}`);
}

/**
 * Alias action: rename an existing instance's display label.
 */
async function renameInstance(
  worktreeId: string,
  instanceId: string,
  alias: string,
  options: InstancesOptions
): Promise<void> {
  if (!isValidInstanceId(instanceId)) {
    console.error('Error: Invalid instance id. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
    process.exit(ExitCode.CONFIG_ERROR);
  }
  if (alias.length === 0 || alias.length > MAX_AGENT_ALIAS_LENGTH) {
    console.error(`Error: alias must be 1-${MAX_AGENT_ALIAS_LENGTH} characters.`);
    process.exit(ExitCode.CONFIG_ERROR);
  }

  const client = new ApiClient({ token: options.token });
  const existing = await fetchAgentInstances(client, worktreeId);
  const index = existing.findIndex(inst => inst.id === instanceId);
  if (index === -1) {
    console.error(`Error: instance '${instanceId}' not found in roster.`);
    process.exit(ExitCode.UNEXPECTED_ERROR);
  }

  const next = existing.map((inst, i) => (i === index ? { ...inst, alias } : inst));
  await saveAgentInstances(client, worktreeId, next);
  console.error(`Instance alias updated: ${instanceId} -> "${alias}"`);
}

/**
 * Kill action: stop only the targeted instance's session (roster unchanged).
 * The server resolves the backing CLI tool from the roster via the `instance`
 * query param (kill-session/route.ts), so no extra lookup is needed here.
 */
async function killInstance(worktreeId: string, instanceId: string, options: InstancesOptions): Promise<void> {
  if (!isValidInstanceId(instanceId)) {
    console.error('Error: Invalid instance id. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
    process.exit(ExitCode.CONFIG_ERROR);
  }

  const client = new ApiClient({ token: options.token });
  await client.post(`/api/worktrees/${worktreeId}/kill-session?instance=${encodeURIComponent(instanceId)}`);
  console.error(`Session killed: ${instanceId}`);
}

export function createInstancesCommand(): Command {
  const cmd = new Command('instances');
  cmd
    .description('Discover and manage agent instances (roster) for a worktree')
    .argument('<worktree-id>', 'Worktree ID')
    .argument('[action]', 'list (default), add, remove, alias, or kill')
    .argument('[rest...]', 'Action-specific arguments (instance-id, new alias)')
    .option('--json', 'JSON output (list/add)')
    .option('--agent <tool>', 'CLI tool for the add action (claude, codex, gemini, vibe-local, opencode, copilot, antigravity)')
    .option('--alias <name>', 'Display alias for the add action')
    .option('--id <instance-id>', 'Explicit instance ID for the add action (format: <agent> or <agent>-<n>, e.g. claude-2)')
    .option('--kill', 'Also kill the running session when removing an instance')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, action: string | undefined, rest: string[], options: InstancesOptions) => {
      try {
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        switch (action ?? 'list') {
          case 'list':
            await listInstances(worktreeId, options);
            break;

          case 'add':
            await addInstance(worktreeId, options);
            break;

          case 'remove': {
            const [instanceId] = rest;
            if (!instanceId) {
              console.error('Error: remove requires an <instance-id> argument.');
              process.exit(ExitCode.CONFIG_ERROR);
            }
            await removeInstance(worktreeId, instanceId, options);
            break;
          }

          case 'alias': {
            const [instanceId, ...aliasParts] = rest;
            const alias = aliasParts.join(' ');
            if (!instanceId || !alias) {
              console.error('Error: alias requires <instance-id> and <new-alias> arguments.');
              process.exit(ExitCode.CONFIG_ERROR);
            }
            await renameInstance(worktreeId, instanceId, alias, options);
            break;
          }

          case 'kill': {
            const [instanceId] = rest;
            if (!instanceId) {
              console.error('Error: kill requires an <instance-id> argument.');
              process.exit(ExitCode.CONFIG_ERROR);
            }
            await killInstance(worktreeId, instanceId, options);
            break;
          }

          default:
            console.error(`Error: unknown action '${action}'. Valid actions: list, add, remove, alias, kill.`);
            process.exit(ExitCode.CONFIG_ERROR);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
