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
import { ApiClient, ApiError, isValidWorktreeId, isValidInstanceId } from '../utils/api-client';
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
import { resolveSessionTarget, describeSessionTargetConflict } from '../utils/session-target';
// Issue #2404: "the worktree is not on this server" is a different failure from
// "the worktree id is wrong", and only the session's own identity can tell them
// apart.
import { describeServerMismatch, formatServerMismatchHint } from './whoami';
import type { CurrentOutputResponse, OpencodeSessionsResponse } from '../types/api-responses';
// Issue #2317: the tmux session name each instance runs in, so `commandmate
// attach` / `tmux attach` need no hand-assembly of `mcbd-<tool>-<wt>[-<suffix>]`.
import { resolveSessionName } from '../../lib/cli-tools/session-name';
import type { CLIToolType } from '../../lib/cli-tools/types';

type InstanceRow = {
  instanceId: string;
  alias: string;
  cliTool: string;
  running: boolean;
  autoYes: boolean;
  /**
   * Issue #1785: what the server said this instance is running, or null.
   *
   * Verbatim. `cliTool` above answers "which agent", which the roster already
   * knew; this answers "which model inside it", which only the live session
   * knows — and the point of printing it at all is to compare it against what
   * the agent reports about itself, so the CLI must not tidy it up.
   */
  model: string | null;
  /** Issue #1785: reasoning effort, or null. Verbatim, as above. */
  reasoningEffort: string | null;
  /**
   * Issue #2038: the opencode session this instance will resume, or null.
   *
   * Null for every non-opencode instance, and that is the honest answer rather
   * than a gap: no other supported agent's launch command names a conversation,
   * so there is nothing for this column to say about them. Null also for an
   * opencode instance CommandMate has never watched finish a turn.
   */
  sessionId: string | null;
  /** Issue #2038: opencode's own title for {@link sessionId}, or null. */
  sessionTitle: string | null;
  /**
   * Issue #2317: the tmux session this instance runs in, or null.
   *
   * Derived, not fetched — {@link resolveSessionName} is the same function
   * `BaseCLITool.getSessionName()` delegates to, so this cannot name a different
   * session than the server opens. Null only when the roster row would not
   * survive `validateSessionName`, i.e. when there is no name to give rather
   * than a wrong one.
   */
  tmuxSession: string | null;
};

/**
 * The tmux session name for one roster row, or null.
 *
 * @param worktreeId - Worktree ID
 * @param inst - Roster entry
 */
function deriveInstanceSession(worktreeId: string, inst: AgentInstance): string | null {
  try {
    return resolveSessionName(inst.cliTool as CLIToolType, worktreeId, inst.id);
  } catch {
    return null;
  }
}

/**
 * Longest session title printed in the table (Issue #2038).
 *
 * opencode titles the session after the first prompt, so they run to a whole
 * sentence. `--json` carries the full string; the table is a table.
 */
const MAX_SESSION_TITLE_COLUMN = 40;

/**
 * Format instance rows as a table for terminal display.
 * [DR1-08 consistency] Mirrors ls.ts's formatTable().
 *
 * Issue #1785 appends MODEL / EFFORT rather than inserting them, so anything
 * reading this table by column position keeps working.
 */
function formatInstancesTable(rows: InstanceRow[]): string {
  if (rows.length === 0) return 'No agent instances found.';

  const headers = [
    'INSTANCE_ID', 'ALIAS', 'CLI_TOOL', 'RUNNING', 'AUTO_YES', 'MODEL', 'EFFORT',
    // Issue #2038 appends, exactly as #1785 did, so anything reading this table
    // by column position keeps working. Issue #2317 appends for the same reason.
    'SESSION_ID', 'SESSION_TITLE', 'TMUX_SESSION',
  ];
  const dataRows = rows.map(r => [
    r.instanceId,
    r.alias,
    r.cliTool,
    r.running ? 'yes' : 'no',
    r.autoYes ? 'yes' : 'no',
    // Blank, not a placeholder: an unknown model is the ordinary state (the
    // session is stopped, the tool publishes none, the server restarted), and a
    // column of `-` reads like a value the reader has to look up.
    r.model ?? '',
    r.reasoningEffort ?? '',
    r.sessionId ?? '',
    (r.sessionTitle ?? '').slice(0, MAX_SESSION_TITLE_COLUMN),
    r.tmuxSession ?? '',
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
 * How the caller wants a roster contradiction handled (Issue #1925, DR3-015).
 *
 * `strict` is for commands with a side effect: refuse rather than pick one of
 * two contradicting declarations and type into whichever session that names.
 * `read-only` is for `capture`, which resolves in order to *look* — and which
 * `.claude/skills/orchestrate-monitor/scripts/monitor.sh` polls in an
 * unbounded loop, skipping the poll and never advancing its idle streak
 * whenever capture exits non-zero. A worker whose `--agent` disagrees with the
 * roster would leave that loop silently spinning forever.
 */
export type InstanceConflictMode = 'strict' | 'read-only';

/**
 * Resolve which CLI tool backs `instanceId`. Shared by every command that
 * targets an instance: `send`, `respond`, `capture` and `auto-yes`.
 *
 * Issue #1925 turned this into a thin client over the server's resolver
 * (`GET /api/worktrees/:id/resolve-target`). It used to resolve locally, with
 * two of the server's four precedence stages — no primary anchor — so the same
 * `--instance codex` against a roster that never registered `codex` resolved to
 * codex on the server and to the worktree default here. The tool id is half the
 * tmux session name, so two answers meant two sessions.
 *
 * The roster still wins over `--agent`: it is the user-maintained declaration
 * of what a named instance is. What changed is that `capture` no longer dies of
 * the contradiction (see {@link InstanceConflictMode}).
 *
 * @param client - API client aimed at the server
 * @param worktreeId - Worktree ID
 * @param instanceId - The `--instance` value
 * @param requestedAgent - The `--agent` value, if the user gave one
 * @param mode - What a roster contradiction means for this caller
 * @returns the CLI tool to send, or undefined to let an older server decide
 */
export async function resolveInstanceCliTool(
  client: ApiClient,
  worktreeId: string,
  instanceId: string,
  requestedAgent: string | undefined,
  mode: InstanceConflictMode = 'strict'
): Promise<string | undefined> {
  return (await resolveInstanceTarget(client, worktreeId, instanceId, requestedAgent, mode))
    .cliToolId;
}

// ===========================================================================
// Instance selectors: an id OR an alias (Issue #2376)
// ===========================================================================

/**
 * The server's code for an `--instance` two roster rows answer to.
 *
 * Mirrors `AMBIGUOUS_INSTANCE_ALIAS` in
 * `src/app/api/worktrees/[id]/resolve-target/route.ts`; duplicated rather than
 * imported because a route module may export only the names Next.js accepts
 * (`scripts/check-route-exports.mjs`, Issue #1946) — the same arrangement
 * `send.ts` has with `PROMPT_WAITING`.
 */
const AMBIGUOUS_INSTANCE_ALIAS_CODE = 'ambiguous_instance_alias';

/**
 * Whether `value` is something the server could resolve to an instance.
 *
 * An instance id, or an alias. Issue #2376 widened `--instance` to accept the
 * second because it is the only name a human has for `codex-2`: the roster pane
 * shows `Codex 2`, `commandmate instances <id>` prints it in the ALIAS column,
 * and `--instance "Codex 2"` used to be rejected here — before any request —
 * with "must be an alphanumeric identifier".
 *
 * The check is deliberately loose: an alias is free text (`レビュー担当`), and
 * the authority on whether one EXISTS is the roster, which only the server has.
 * All this rules out is a value no alias can be — empty, longer than the alias
 * field allows, or carrying control characters.
 *
 * @param value - The `--instance` value as given
 */
export function isInstanceSelector(value: string): boolean {
  if (isValidInstanceId(value)) return true;
  if (value.length === 0 || value.length > MAX_AGENT_ALIAS_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * The sentence appended to every command's `--instance` help (Issue #2376).
 *
 * Kept beside the validator that accepts the form, not in
 * `config/agent-target-options.ts`, so the help and the check cannot drift: the
 * day the alias stage is removed, both go together.
 */
export const INSTANCE_ALIAS_HELP_SUFFIX =
  'Also accepts a roster alias as shown by `commandmate instances <worktree-id>` '
  + '(e.g. --instance "Codex 2"); an alias two rows answer to is exit 2 with the candidates listed.';

/** The sentence `--instance` is rejected with. One place, five commands. */
export const INSTANCE_SELECTOR_ERROR =
  'Error: Invalid --instance. Give an instance id (alphanumeric/underscore/hyphen, max 64 chars) '
  + `or a roster alias (max ${MAX_AGENT_ALIAS_LENGTH} chars).`;

/** A resolved target: which agent, and which instance id to address it by. */
export interface ResolvedInstanceTarget {
  /** The agent to send as, or undefined to let an older server decide. */
  cliToolId: string | undefined;
  /**
   * The instance id to put in the request, or undefined when the caller named
   * no instance at all.
   *
   * **Not the value the user typed.** `--instance "Codex 2"` resolves here to
   * `codex-2`, and every downstream body/query must carry the resolved id: the
   * alias is a label the roster holds, and no other route knows how to read one.
   *
   * Undefined for a caller that passed no selector, even though the server
   * answers with the worktree's default instance: a request that named no
   * instance must keep not naming one, or `capture <id> --pane` would start
   * pinning a session it was deliberately leaving to the server.
   */
  instanceId: string | undefined;
}

/**
 * Resolve `--instance` — id or alias — to the agent and instance id to address.
 *
 * The one resolution path, as Issue #1925 established: the server answers,
 * `resolveSessionTarget` asks, and this adds only what a CLI caller has to do
 * with the two answers it can get back that a browser does not care about — a
 * roster contradiction ({@link InstanceConflictMode}) and, since Issue #2376, an
 * alias that names more than one row.
 *
 * The ambiguity is exit 2 with every candidate printed, never a pick: two rows
 * called `Codex` are two different tmux sessions, and choosing one for the
 * operator is how a message reaches the wrong agent silently.
 *
 * @param client - API client aimed at the server
 * @param worktreeId - Worktree ID
 * @param selector - The `--instance` value (an instance id or a roster alias),
 *   or undefined for a caller that resolves only to learn the agent
 * @param requestedAgent - The `--agent` value, if the user gave one
 * @param mode - What a roster contradiction means for this caller
 */
export async function resolveInstanceTarget(
  client: ApiClient,
  worktreeId: string,
  selector: string | undefined,
  requestedAgent: string | undefined,
  mode: InstanceConflictMode = 'strict'
): Promise<ResolvedInstanceTarget> {
  let target;
  try {
    target = await resolveSessionTarget(client, worktreeId, {
      instanceId: selector,
      requestedCliTool: requestedAgent,
    });
  } catch (error) {
    if (error instanceof ApiError && error.apiCode === AMBIGUOUS_INSTANCE_ALIAS_CODE) {
      console.error(`Error: ${error.payload?.error ?? `--instance '${selector}' is ambiguous.`}`);
      for (const candidate of error.payload?.issues ?? []) {
        console.error(`  - ${candidate}`);
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }
    throw error;
  }

  if (target.conflict) {
    const detail = describeSessionTargetConflict(target.conflict);
    if (mode === 'strict') {
      console.error(`Error: ${detail}`);
      process.exit(ExitCode.CONFIG_ERROR);
    } else {
      console.error(`Warning: ${detail} Reading ${target.conflict.rosterCliTool}.`);
    }
  }

  return {
    cliToolId: target.cliToolId,
    // The server always echoes the effective instance; the fallback covers the
    // `client-fallback` path against a daemon older than the endpoint, where the
    // value the user typed is the only one there is.
    instanceId: selector === undefined ? undefined : (target.instanceId ?? selector),
  };
}

/**
 * The opencode session each instance will resume, keyed by instance id
 * (Issue #2038).
 *
 * Empty — never an error — when the roster has no opencode instance, when the
 * daemon predates this endpoint (404), or when the request fails for any other
 * reason. `instances` is a listing command: two new columns are worth one extra
 * request, and never worth turning a working listing into a non-zero exit.
 */
async function fetchOpencodeSessions(
  client: ApiClient,
  worktreeId: string,
  instances: AgentInstance[]
): Promise<Map<string, { sessionId: string | null; title: string | null }>> {
  const result = new Map<string, { sessionId: string | null; title: string | null }>();
  if (!instances.some(inst => inst.cliTool === 'opencode')) return result;

  try {
    const response = await client.get<OpencodeSessionsResponse>(
      `/api/worktrees/${worktreeId}/opencode/session`
    );
    for (const entry of response.instances ?? []) {
      result.set(entry.instanceId, { sessionId: entry.sessionId, title: entry.title });
    }
  } catch {
    // An older server has no such route. The rest of the table is still true.
  }
  return result;
}

/**
 * List action: roster + live running/auto-yes status per instance.
 * Probes GET .../current-output?cliTool=&instance= per instance (same
 * endpoint capture.ts uses) since the roster itself carries no session state.
 */
async function listInstances(
  client: ApiClient,
  worktreeId: string,
  options: InstancesOptions
): Promise<void> {
  const instances = await fetchAgentInstances(client, worktreeId);

  // Issue #2038: one extra request for the whole worktree, and only when there
  // is an opencode instance to ask about — the endpoint is opencode-only and a
  // roster without one has nothing to learn from it.
  const opencodeSessions = await fetchOpencodeSessions(client, worktreeId, instances);

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
        // Issue #1785: pass-through. `?? null` collapses "this daemon predates
        // the field" into the same null the server sends for "nothing knows" —
        // the CLI has no way to tell those apart and no reason to.
        //
        // Blanking a stopped instance is the *server's* job (buildCurrentOutput
        // returns null before it ever reads the latch), so there is no
        // `running ? … : null` here: a second rule in a second place is how the
        // two answers get to disagree.
        model: output.model ?? null,
        reasoningEffort: output.reasoningEffort ?? null,
        // Issue #2038: additive, and absent for every tool that is not opencode.
        sessionId: opencodeSessions.get(inst.id)?.sessionId ?? null,
        sessionTitle: opencodeSessions.get(inst.id)?.title ?? null,
        // Issue #2317: additive, and in both the table and `--json` — the table
        // is where somebody who does not know the naming rule will see it.
        tmuxSession: deriveInstanceSession(worktreeId, inst),
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
async function addInstance(
  client: ApiClient,
  worktreeId: string,
  options: InstancesOptions
): Promise<void> {
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
async function removeInstance(
  client: ApiClient,
  worktreeId: string,
  instanceId: string,
  options: InstancesOptions
): Promise<void> {
  if (!isValidInstanceId(instanceId)) {
    console.error('Error: Invalid instance id. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
    process.exit(ExitCode.CONFIG_ERROR);
  }

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
  client: ApiClient,
  worktreeId: string,
  instanceId: string,
  alias: string
): Promise<void> {
  if (!isValidInstanceId(instanceId)) {
    console.error('Error: Invalid instance id. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
    process.exit(ExitCode.CONFIG_ERROR);
  }
  if (alias.length === 0 || alias.length > MAX_AGENT_ALIAS_LENGTH) {
    console.error(`Error: alias must be 1-${MAX_AGENT_ALIAS_LENGTH} characters.`);
    process.exit(ExitCode.CONFIG_ERROR);
  }

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
async function killInstance(
  client: ApiClient,
  worktreeId: string,
  instanceId: string
): Promise<void> {
  if (!isValidInstanceId(instanceId)) {
    console.error('Error: Invalid instance id. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
    process.exit(ExitCode.CONFIG_ERROR);
  }

  await client.post(`/api/worktrees/${worktreeId}/kill-session?instance=${encodeURIComponent(instanceId)}`);
  console.error(`Session killed: ${instanceId}`);
}

/**
 * Print the "you are on another server" hint when that is what a 404 means
 * (Issue #2404).
 *
 * Runs only on a failure path, so the extra `tmux display-message` +
 * `GET /api/worktrees` it costs buys the difference between a correct diagnosis
 * and a wrong one. Never throws: {@link describeServerMismatch} swallows its own
 * failures, and a diagnosis must not replace the error being diagnosed.
 *
 * @param client - The client whose request failed
 * @param error - The caught error, diagnosed only when it is a 404
 */
async function warnIfDifferentServer(client: ApiClient, error: unknown): Promise<void> {
  if (!(error instanceof ApiError) || error.statusCode !== 404) return;
  const mismatch = await describeServerMismatch(client);
  if (mismatch) console.error(formatServerMismatchHint(mismatch));
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
      // One client for the whole invocation (Issue #2404): every action built
      // its own identical one, and the failure path below has to report the URL
      // the request actually went to — a second construction is a second answer.
      const client = new ApiClient({ token: options.token });
      try {
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        switch (action ?? 'list') {
          case 'list':
            await listInstances(client, worktreeId, options);
            break;

          case 'add':
            await addInstance(client, worktreeId, options);
            break;

          case 'remove': {
            const [instanceId] = rest;
            if (!instanceId) {
              console.error('Error: remove requires an <instance-id> argument.');
              process.exit(ExitCode.CONFIG_ERROR);
            }
            await removeInstance(client, worktreeId, instanceId, options);
            break;
          }

          case 'alias': {
            const [instanceId, ...aliasParts] = rest;
            const alias = aliasParts.join(' ');
            if (!instanceId || !alias) {
              console.error('Error: alias requires <instance-id> and <new-alias> arguments.');
              process.exit(ExitCode.CONFIG_ERROR);
            }
            await renameInstance(client, worktreeId, instanceId, alias);
            break;
          }

          case 'kill': {
            const [instanceId] = rest;
            if (!instanceId) {
              console.error('Error: kill requires an <instance-id> argument.');
              process.exit(ExitCode.CONFIG_ERROR);
            }
            await killInstance(client, worktreeId, instanceId);
            break;
          }

          default:
            console.error(`Error: unknown action '${action}'. Valid actions: list, add, remove, alias, kill.`);
            process.exit(ExitCode.CONFIG_ERROR);
        }
      } catch (error) {
        // Issue #2404: a 404 here says "no such worktree ON THIS SERVER", and
        // `Resource not found. Check the worktree ID.` reads as "you typed it
        // wrong". When the caller's own session belongs to a worktree this
        // server does not list, the id was never the problem — say so before
        // handleCommandError() exits, so nobody re-checks a correct id and then
        // delegates to whatever this server does have.
        await warnIfDifferentServer(client, error);
        handleCommandError(error);
      }
    });
  return cmd;
}
