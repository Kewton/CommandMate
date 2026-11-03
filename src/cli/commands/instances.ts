/**
 * instances Command - Discover and manage a worktree's agent-instance roster
 * Issue #1000: CLI parity for the "1 agent, multiple sessions" feature (#868/#869)
 *
 *   commandmate instances <worktree-id>                                   # list (default)
 *   commandmate instances <worktree-id> add --agent <tool> [--alias <n>]
 *   commandmate instances <worktree-id> remove <instance-id> [--kill]
 *   commandmate instances <worktree-id> alias <instance-id> <new-alias>
 *   commandmate instances <worktree-id> kill <instance-id>
 *   commandmate instances <worktree-id> set-role <instance-id> (--role <role> | --none | --inherit)
 */

import { Command } from 'commander';
import { ExitCode, getErrorMessage, RoleExitCode } from '../types';
import type { InstancesOptions } from '../types';
import type { AgentInstance } from '../types/api-responses';
import { ApiClient, ApiError, isValidWorktreeId, isValidInstanceId, rethrowIfDeadlineExceeded } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { isCliToolId, CLI_TOOL_IDS } from '../config/cli-tool-ids';
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
import { describeServerMismatch, formatServerMismatchHint, readTmuxSessionName } from './whoami';
// Issue #3993: each kill is recorded so the env-clean gate can tell a sibling
// session the orchestrator stopped from one a worker killed.
import {
  appendSessionKillRecord,
  SESSION_KILL_LEDGER_VERSION,
} from '../../lib/verification/session-kill-ledger';
import type {
  AutoYesStatesResponse,
  CurrentOutputResponse,
  OpencodeSessionsResponse,
} from '../types/api-responses';
// Issue #2317: the tmux session name each instance runs in, so `commandmate
// attach` / `tmux attach` need no hand-assembly of `mcbd-<tool>-<wt>[-<suffix>]`.
import { resolveSessionName } from '../../lib/cli-tools/session-name';
import { validateSessionName } from '../../lib/cli-tools/validation';
import type { CLIToolType } from '../../lib/cli-tools/types';
import {
  assertRoleTool,
  reportRoleFailure,
  roleWrite,
  resolveRole,
  roleAssignmentFromFlag,
  roleFailureFromApi,
  RoleCliError,
  usageError,
  watchRoleFlagConflict,
} from '../utils/agent-roles';
import type {
  InstanceRoleCreateResponse,
  InstanceRoleEntry,
  InstanceRoleSettingsResponse,
  RoleApplicationState,
  RoleAssignmentInput,
  StoredRoleState,
} from '../../types/agent-roles';

/**
 * What an instance holds, what the next start would use and what the process was
 * started with (Issue #4116). The server's words verbatim: `launched` / `requested`
 * are launch records with their `source`, `effectiveNext` is the next start with its
 * `source`. A null `launched` is "not known" (not started, or a server restart),
 * which is not "no role".
 */
type InstanceRoleView = { stored: StoredRoleState } & RoleApplicationState;

type InstanceRow = {
  instanceId: string;
  alias: string;
  cliTool: string;
  running: boolean;
  autoYes: boolean;
  /**
   * Issue #3723: Auto-Yes is armed but the contract running on this instance
   * sets `autoYes.mode: off`, so nothing is answered. The reason `AUTO_YES`
   * reads `blocked`. Its own key rather than a third value of `autoYes`, which
   * `--json` readers already treat as a boolean — and present only when true,
   * so a row with no such contract prints exactly the JSON it did.
   */
  autoYesBlockedByContract?: true;
  /**
   * Issue #3730: Auto-Yes is off because the last server restart released this
   * instance's grant — `AUTO_YES` reads `no(restart)`, one token, so the table
   * still splits on whitespace. Present only then, for the reason
   * `autoYesBlockedByContract` is: `--json` rows of every other instance stay
   * the JSON they were.
   */
  autoYesStopReason?: 'server-restart';
  /**
   * Issue #3863: the answer mode of the armed grant (`recommended` /
   * `careful`) — how a question on this instance is treated. Present only
   * while Auto-Yes is on and the server names one, so every other row prints
   * the JSON it did. `--json` only: the table's `AUTO_YES` column is unchanged.
   */
  autoYesAnswerMode?: string;
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
   * Issue #2867: the `sessionName` the server published on the roster row —
   * namespaced, or an adopted legacy name — since the namespace lives in the
   * server's DB and cannot be derived here. Only a server older than #2867
   * sends none, and that server names its sessions the legacy way, which
   * {@link resolveSessionName} (namespace unset in the CLI) derives. Null when
   * the name would not survive `validateSessionName`, i.e. when there is no
   * name to give rather than a wrong one.
   */
  tmuxSession: string | null;
  /** Issue #4116: absent when the server has no role layer, so that row prints the JSON it did. */
  role?: InstanceRoleView;
};

/**
 * The tmux session name for one roster row, or null.
 *
 * @param worktreeId - Worktree ID
 * @param inst - Roster entry
 */
function deriveInstanceSession(worktreeId: string, inst: AgentInstance): string | null {
  try {
    if (inst.sessionName) {
      validateSessionName(inst.sessionName);
      return inst.sessionName;
    }
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

function describeNextRole(next: RoleApplicationState['effectiveNext']): string {
  if (next.kind === 'role') return `${next.role.name}(${next.source})`;
  return next.kind === 'none' ? `none(${next.source})` : 'ambiguous';
}

/** The three role columns of one row. `unknown` for a startup role is what the server knows. */
function roleColumns(role: InstanceRoleView | undefined): string[] {
  if (!role) return ['', '', ''];
  const atStart = role.launched === null ? 'unknown' : role.launched.roleName ?? 'none';
  return [atStart, describeNextRole(role.effectiveNext), role.restartPending];
}

/**
 * Format instance rows as a table for terminal display.
 * [DR1-08 consistency] Mirrors ls.ts's formatTable().
 *
 * Issue #1785 appends MODEL / EFFORT rather than inserting them, so anything
 * reading this table by column position keeps working.
 */
function formatInstancesTable(rows: InstanceRow[]): string {
  if (rows.length === 0) return 'No agent instances found.';

  // Issue #4116: appended, as #1785 and #2038 did, and only by a server that knows.
  const showRoles = rows.some((r) => r.role !== undefined);
  const headers = [
    'INSTANCE_ID', 'ALIAS', 'CLI_TOOL', 'RUNNING', 'AUTO_YES', 'MODEL', 'EFFORT',
    // Issue #2038 appends, exactly as #1785 did, so anything reading this table
    // by column position keeps working. Issue #2317 appends for the same reason.
    'SESSION_ID', 'SESSION_TITLE', 'TMUX_SESSION',
    ...(showRoles ? ['ROLE_AT_START', 'ROLE_NEXT', 'RESTART_PENDING'] : []),
  ];
  const dataRows = rows.map(r => [
    r.instanceId,
    r.alias,
    r.cliTool,
    r.running ? 'yes' : 'no',
    r.autoYes
      ? (r.autoYesBlockedByContract ? 'blocked' : 'yes')
      : (r.autoYesStopReason === 'server-restart' ? 'no(restart)' : 'no'),
    // Blank, not a placeholder: an unknown model is the ordinary state (the
    // session is stopped, the tool publishes none, the server restarted), and a
    // column of `-` reads like a value the reader has to look up.
    r.model ?? '',
    r.reasoningEffort ?? '',
    r.sessionId ?? '',
    (r.sessionTitle ?? '').slice(0, MAX_SESSION_TITLE_COLUMN),
    r.tmuxSession ?? '',
    ...(showRoles ? roleColumns(r.role) : []),
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
 * Which instances have Auto-Yes armed, keyed by instance id, or null when the
 * server does not say (Issue #3300).
 *
 * Auto-Yes is armed per worktree x instance and outlives the session it answers
 * for (`auto-yes --enable` needs no session), so `current-output` cannot answer
 * for it: a session that is not running is answered there with no `autoYes` key
 * at all, and an armed, stopped instance was printed as `no`. This asks the
 * state store instead — what `commandmate ls` prints from, for one worktree.
 * An instance the map does not name has no state, which is "not armed".
 *
 * Null — never an error — when the request fails or the answer carries no
 * `instances` map (a daemon older than #896). The caller then keeps each
 * session's own reading, which is what this command printed before.
 */
/** One instance's Auto-Yes as the state store reports it (Issue #3300 / #3723). */
type ArmedAutoYes = { enabled: boolean; blockedByContract: boolean; releasedByRestart: boolean; answerMode?: string };

async function fetchArmedAutoYes(
  client: ApiClient,
  worktreeId: string
): Promise<Map<string, ArmedAutoYes> | null> {
  try {
    const response = await client.get<AutoYesStatesResponse>(
      `/api/worktrees/${worktreeId}/auto-yes`
    );
    const states = response?.instances;
    if (!states || typeof states !== 'object') return null;
    const modes = response?.answerModeByInstance;
    return new Map(
      Object.entries(states).map(([instanceId, state]): [string, ArmedAutoYes] => {
        const enabled = state?.enabled === true;
        return [instanceId, {
          enabled,
          blockedByContract: enabled && state?.blockedByContract === true,
          // Issue #3730: a server older than the field sends none — plain `no`.
          releasedByRestart: !enabled && state?.stopReason === 'server-restart',
          // Issue #3863: an older server sends none — the row then carries none.
          ...(enabled && typeof modes?.[instanceId] === 'string' ? { answerMode: modes[instanceId] } : {}),
        }];
      })
    );
  } catch {
    return null;
  }
}

/**
 * Each instance's role, keyed by instance id, or null when the server does not say.
 * Like the two reads above: a listing is never failed by a column.
 */
async function fetchInstanceRoles(client: ApiClient, worktreeId: string): Promise<Map<string, InstanceRoleView> | null> {
  try {
    const { instances } = await client.get<InstanceRoleSettingsResponse>(`/api/worktrees/${worktreeId}/instances/roles`);
    if (!Array.isArray(instances)) return null;
    return new Map(instances.map(({ instanceId, stored, application }) => [instanceId, { stored, ...application }]));
  } catch (error) {
    rethrowIfDeadlineExceeded(error);
    return null;
  }
}

/**
 * `--require-roles`: for a caller that must not read "the roles could not be read" as
 * "this server has none". Every failure is the command's; the route being missing is
 * `role_api_unavailable`, through {@link reportRoleFailure}.
 */
async function readInstanceRolesStrict(client: ApiClient, worktreeId: string): Promise<Map<string, InstanceRoleView>> {
  const { instances } = await client.get<InstanceRoleSettingsResponse>(`/api/worktrees/${worktreeId}/instances/roles`);
  if (!Array.isArray(instances)) {
    throw new RoleCliError('role_read_failed', 'The server answered the role settings with no instances.', ExitCode.UNEXPECTED_ERROR);
  }
  return new Map(instances.map(({ instanceId, stored, application }) => [instanceId, { stored, ...application }]));
}

/**
 * List action: roster + live running/auto-yes status per instance.
 * Probes GET .../current-output?cliTool=&instance= per instance (same
 * endpoint capture.ts uses) since the roster itself carries no session state.
 * Auto-Yes is not session state, and is read from GET .../auto-yes — see
 * {@link fetchArmedAutoYes}.
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

  const sessionRows: InstanceRow[] = await Promise.all(
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
        // The session's own reading: absent — so `false` — whenever the session
        // is not running. Replaced below when the server names the armed
        // instances itself (Issue #3300).
        autoYes: output.autoYes?.enabled ?? false,
        // Issue #3863: the session's own reading of the mode, replaced below too.
        ...(output.autoYes?.enabled === true && typeof output.autoYesAnswerMode === 'string'
          ? { autoYesAnswerMode: output.autoYesAnswerMode }
          : {}),
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

  // Issue #3300: one request for the whole worktree, whatever the roster's
  // size, and none for an empty one. Asked after the probes above, so the
  // column is the latest of the readings this listing takes.
  const armed = instances.length > 0 ? await fetchArmedAutoYes(client, worktreeId) : null;
  const armedRows: InstanceRow[] = armed === null
    ? sessionRows
    : sessionRows.map(({ autoYesAnswerMode: _sessionMode, ...row }) => {
      const entry = armed.get(row.instanceId);
      return {
        ...row,
        autoYes: entry?.enabled ?? false,
        // Issue #3863: the state store's mode, beside the arming it belongs to.
        ...(entry?.answerMode !== undefined ? { autoYesAnswerMode: entry.answerMode } : {}),
        // Issue #3723: only the state store says this, so only this path sets it.
        ...(entry?.blockedByContract ? { autoYesBlockedByContract: true as const } : {}),
        // Issue #3730: likewise only the state store knows the restart took it.
        ...(entry?.releasedByRestart ? { autoYesStopReason: 'server-restart' as const } : {}),
      };
    });

  // Issue #4116: after the others, and additive.
  const roles = options.requireRoles
    ? await readInstanceRolesStrict(client, worktreeId)
    : instances.length > 0 ? await fetchInstanceRoles(client, worktreeId) : null;
  const rows: InstanceRow[] = armedRows.map((row) => {
    const role = roles?.get(row.instanceId);
    if (options.requireRoles && !role) {
      throw new RoleCliError('role_read_failed', `The server said nothing about the role of ${row.instanceId}.`, ExitCode.UNEXPECTED_ERROR);
    }
    return role ? { ...row, role } : row;
  });

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(formatInstancesTable(rows));
}

/** One instance's entry in a settings answer, or the failure for a server that left it out. */
function roleEntryOf(settings: InstanceRoleSettingsResponse, instanceId: string): InstanceRoleEntry {
  const entry = settings.instances.find((instance) => instance.instanceId === instanceId);
  if (!entry) throw new RoleCliError('roster_changed', `Instance '${instanceId}' is no longer in the roster.`, RoleExitCode.CONFLICT);
  return entry;
}

/** The setting beside the process: what `set-role` and `add --role` answer with. */
function roleChangeResult(settings: InstanceRoleSettingsResponse, entry: InstanceRoleEntry): Record<string, unknown> {
  return {
    success: true,
    instanceId: entry.instanceId,
    cliToolId: entry.cliToolId,
    adapterEnabled: entry.adapterEnabled,
    stored: entry.stored,
    effectiveNext: entry.application.effectiveNext,
    launched: entry.application.launched,
    requested: entry.application.requested,
    restartPending: entry.application.restartPending,
    // Only a difference is pending: `unknown` is not known to be one.
    applyPending: entry.application.restartPending === 'yes',
    ...(entry.application.replacesDefaultInstructions ? { replacesDefaultInstructions: true } : {}),
    rosterRevision: settings.rosterRevision,
  };
}

function printRoleChange(worktreeId: string, entry: InstanceRoleEntry): void {
  const { effectiveNext, launched, restartPending } = entry.application;
  console.error(`Next start: ${describeNextRole(effectiveNext)}`);
  console.error(`Running process started with: ${launched === null ? 'not known' : launched.roleName ?? 'no role'}`);
  if (restartPending === 'yes') {
    console.error(
      `Pending: the running process keeps its role until it is stopped (commandmate instances ${worktreeId} kill ${entry.instanceId}).`
    );
  } else if (restartPending === 'unknown') {
    console.error('Whether a restart is needed is not known: nothing is known about a running process, if there is one.');
  }
  if (!entry.adapterEnabled && effectiveNext.kind === 'role') {
    console.error(`Warning: roles are not enabled for ${entry.cliToolId} yet: a start that resolves to one is refused.`);
  }
}

/**
 * set-role action: save an instance's role for its next start. A running session is
 * not touched, and the answer compares the two.
 */
async function setInstanceRole(
  client: ApiClient,
  worktreeId: string,
  instanceId: string,
  options: InstancesOptions
): Promise<void> {
  if (!isValidInstanceId(instanceId)) {
    throw usageError('Invalid instance id. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
  }
  if (options.role === false) throw usageError('set-role says "no role" with --none.');
  const given = [options.role !== undefined, options.none === true, options.inherit === true].filter(Boolean).length;
  if (given !== 1) throw usageError('set-role needs one of --role <role>, --none or --inherit.');
  const role: RoleAssignmentInput = options.none
    ? { state: 'none' }
    : options.inherit
      ? { state: 'inherit' }
      : { state: 'role', roleId: (await resolveRole(client, options.role as string)).id };

  const settings = await roleWrite(`commandmate instances ${worktreeId}`, () =>
    client.put<InstanceRoleSettingsResponse>(`/api/worktrees/${worktreeId}/instances/roles`, { instanceId, role })
  );
  const entry = roleEntryOf(settings, instanceId);
  if (options.json) {
    console.log(JSON.stringify(roleChangeResult(settings, entry), null, 2));
    return;
  }
  const stored = entry.stored;
  console.log(`Role saved for ${instanceId}: ${stored.state === 'role' ? stored.roleName : stored.state}`);
  printRoleChange(worktreeId, entry);
}

/** The refusals a `--role` flag on another action gets. */
function assertNoRoleFlags(action: string, options: InstancesOptions): void {
  const allowed: Record<string, Array<keyof InstancesOptions>> = {
    add: ['role'],
    'set-role': ['role', 'none', 'inherit'],
  };
  for (const flag of ['role', 'none', 'inherit'] as const) {
    if (options[flag] !== undefined && !(allowed[action] ?? []).includes(flag)) {
      throw usageError(`--${flag} does not apply to '${action}'.`);
    }
  }
}

/**
 * Add action: append a new instance to the roster (PATCH full replacement).
 */
async function addInstance(
  client: ApiClient,
  worktreeId: string,
  options: InstancesOptions
): Promise<void> {
  // Issue #4116: with a role flag this is a role form, whose `--json` answers every
  // failure on stdout. The exit code is the same either way.
  const refuse = (message: string): void => {
    if (options.role !== undefined) throw usageError(message);
    console.error(`Error: ${message}`);
    process.exit(ExitCode.CONFIG_ERROR);
  };
  if (!options.agent) {
    refuse('add requires --agent <tool>.');
    return;
  }
  if (!isCliToolId(options.agent)) {
    refuse(`Invalid --agent. Must be one of: ${CLI_TOOL_IDS.join(', ')}`);
  }
  if (options.id && !isValidInstanceId(options.id)) {
    refuse('Invalid --id. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
  }
  if (options.alias && options.alias.length > MAX_AGENT_ALIAS_LENGTH) {
    refuse(`--alias exceeds ${MAX_AGENT_ALIAS_LENGTH} characters.`);
  }

  // Issue #4116: a role goes in with the instance, through the route that creates both
  // in one transaction and refuses a roster changed since this read.
  if (options.role !== undefined) assertRoleTool(options.agent);
  const roleAssignment = await roleAssignmentFromFlag(client, options.role);
  const roleSettings = roleAssignment === undefined
    ? null
    : await client.get<InstanceRoleSettingsResponse>(`/api/worktrees/${worktreeId}/instances/roles`);
  const existing: Array<AgentInstance> = roleSettings === null
    ? await fetchAgentInstances(client, worktreeId)
    : roleSettings.instances.map((instance, order) => ({
        id: instance.instanceId,
        cliTool: instance.cliToolId,
        alias: instance.alias,
        order,
      }));

  if (existing.length >= MAX_AGENT_INSTANCES) {
    refuse(`worktree already has the maximum of ${MAX_AGENT_INSTANCES} agent instances.`);
  }

  const id = options.id ?? nextInstanceId(options.agent, existing);
  if (existing.some(inst => inst.id === id)) {
    if (roleSettings !== null) {
      throw new RoleCliError('instance_exists', `Instance '${id}' already exists. Set its role with: set-role ${id}`, RoleExitCode.CONFLICT);
    }
    console.error(`Error: instance '${id}' already exists.`);
    process.exit(ExitCode.CONFIG_ERROR);
  }
  // Primary-anchor consistency (mirrors validateAgentInstancesInput on the
  // server): an id equal to a CLI tool id must back that exact tool.
  if (isCliToolId(id) && id !== options.agent) {
    refuse(`instance id '${id}' conflicts with --agent '${options.agent}'.`);
  }

  const alias = options.alias ?? defaultAlias(options.agent, id);
  if (roleAssignment !== undefined && roleSettings !== null) {
    const agent = options.agent;
    const created = await roleWrite(`commandmate instances ${worktreeId}`, () =>
      client.post<InstanceRoleCreateResponse>(`/api/worktrees/${worktreeId}/instances/roles`, {
        instance: { id, cliTool: agent, alias },
        role: roleAssignment,
        expectedRosterRevision: roleSettings.rosterRevision,
      })
    );
    const entry = roleEntryOf(created, created.created.instanceId);
    console.error(`Instance added: ${id} (${options.agent})`);
    if (options.json) {
      console.log(JSON.stringify({ ...roleChangeResult(created, entry), created: created.created }, null, 2));
    } else {
      printRoleChange(worktreeId, entry);
    }
    return;
  }
  const next: AgentInstance[] = [...existing, { id, cliTool: options.agent, alias, order: existing.length }];
  await saveAgentInstances(client, worktreeId, next);

  console.error(`Instance added: ${id} (${options.agent})`);
  if (options.json) {
    console.log(JSON.stringify(next, null, 2));
  }
}

/**
 * Record a successful kill in the session-kill ledger (Issue #3993): which
 * worktree and instance, the tmux sessions the server says it stopped
 * (`killedSessions` of the kill-session response), and who asked — this
 * process's cwd and tmux session. A response without `killedSessions` (an
 * older server) records no session, which excuses nothing.
 * Best effort: the ledger never fails the command, the kill already happened.
 */
function recordSessionKill(worktreeId: string, instanceId: string, response: unknown): void {
  let callerCwd: string | null;
  try {
    callerCwd = process.cwd();
  } catch {
    callerCwd = null;
  }
  const killed = (response as { killedSessions?: unknown } | null)?.killedSessions;
  appendSessionKillRecord({
    version: SESSION_KILL_LEDGER_VERSION,
    at: Date.now(),
    api: 'kill-session',
    origin: 'cli',
    worktreeId,
    instanceId,
    sessionNames: Array.isArray(killed)
      ? killed.filter((name): name is string => typeof name === 'string')
      : [],
    callerCwd,
    callerSession: readTmuxSessionName(),
  });
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
      const killResponse = await client.post<unknown>(`/api/worktrees/${worktreeId}/kill-session?instance=${encodeURIComponent(instanceId)}`);
      recordSessionKill(worktreeId, instanceId, killResponse);
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

  const killResponse = await client.post<unknown>(`/api/worktrees/${worktreeId}/kill-session?instance=${encodeURIComponent(instanceId)}`);
  recordSessionKill(worktreeId, instanceId, killResponse);
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
  const bothRoleFlags = watchRoleFlagConflict(cmd);
  cmd
    .description('Discover and manage agent instances (roster) for a worktree')
    .argument('<worktree-id>', 'Worktree ID')
    .argument('[action]', 'list (default), add, remove, alias, kill, or set-role')
    .argument('[rest...]', 'Action-specific arguments (instance-id, new alias)')
    .option('--json', 'JSON output (list/add/set-role)')
    .option('--agent <tool>', 'CLI tool for the add action (claude, codex, gemini, vibe-local, opencode, copilot, antigravity)')
    .option('--alias <name>', 'Display alias for the add action')
    .option('--id <instance-id>', 'Explicit instance ID for the add action (format: <agent> or <agent>-<n>, e.g. claude-2)')
    .option('--kill', 'Also kill the running session when removing an instance')
    .option('--role <role>', 'add / set-role: role ID or name for this instance')
    .option('--no-role', 'add: explicitly no role')
    .option('--none', 'set-role: explicitly no role')
    .option('--inherit', 'set-role: drop the setting, and follow the defaults')
    .option('--require-roles', 'list --json: fail instead of leaving role out when it cannot be read; failures are JSON')
    .option('--token <token>', TOKEN_WARNING)
    .addHelpText('after', `
set-role saves what this instance's NEXT start uses, running or not. A role is fixed
when the process starts, so a running session is not touched. The answer compares the
two: applyPending (--json) / "Pending:" only when they differ. restartPending: yes, no,
or unknown (nothing known about the process: not started, or the server restarted).
To change what a whole repository or tool gets instead: commandmate roles default.
To change the role's text: commandmate roles edit. See: commandmate roles --help

add --role / --no-role creates the instance and its role together, refused (exit 31)
if the roster changed meanwhile. Without them the instance follows the defaults.

--json, list: every row carries role when the server has roles:
  role: { stored, effectiveNext: { kind, source, role?, injectionFingerprint }, launched,
          requested, restartPending }
  launched / requested are launch records, with roleId, roleName, source and
  injectionFingerprint. launched null means not known, which is not "no role".
--json, set-role and add --role: { success, instanceId, cliToolId, adapterEnabled, stored,
  effectiveNext, launched, requested, restartPending, applyPending, rosterRevision }
--json failure of those two: { success: false, error, message } on stdout, whatever failed.
  A 5xx or no answer may still have saved: it adds saved: "unknown" and check. A 4xx saved nothing.
--require-roles makes list --json fail rather than leave role out, so a script can tell
"could not be read" from a server older than roles (error: role_api_unavailable).

Exit codes for the role forms: 0 done; 2 usage, unknown or ambiguous role, instance not
on the roster, or a tool roles do not apply to; 31 instance_exists or roster_changed.
`)
    .action(async (worktreeId: string, action: string | undefined, rest: string[], options: InstancesOptions) => {
      // One client for the whole invocation (Issue #2404): every action built
      // its own identical one, and the failure path below has to report the URL
      // the request actually went to — a second construction is a second answer.
      let client: ApiClient | undefined;
      // Issue #4116: the forms whose `--json` promises an answer for every failure.
      const roleForm = action === 'set-role' || (action === 'add' && options.role !== undefined) || options.requireRoles === true;
      try {
        // Inside the try, as `roles` has it: the constructor can refuse (CM_UAT_ISOLATION
        // with no CM_PORT), and that is a failure like any other.
        client = new ApiClient({ token: options.token });
        if (!isValidWorktreeId(worktreeId)) {
          if (roleForm) throw usageError('Invalid worktree ID format.');
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        if (bothRoleFlags()) throw usageError('Give --role or --no-role, not both.');
        assertNoRoleFlags(action ?? 'list', options);

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

          case 'set-role': {
            const [instanceId] = rest;
            if (!instanceId) throw usageError('set-role requires an <instance-id> argument.');
            await setInstanceRole(client, worktreeId, instanceId, options);
            break;
          }

          default:
            console.error(`Error: unknown action '${action}'. Valid actions: list, add, remove, alias, kill, set-role.`);
            process.exit(ExitCode.CONFIG_ERROR);
        }
      } catch (error) {
        // Issue #2404: a 404 here says "no such worktree ON THIS SERVER", and
        // `Resource not found. Check the worktree ID.` reads as "you typed it
        // wrong". When the caller's own session belongs to a worktree this
        // server does not list, the id was never the problem — say so before
        // handleCommandError() exits, so nobody re-checks a correct id and then
        // delegates to whatever this server does have.
        if (client) await warnIfDifferentServer(client, error);
        // Issue #4116: a role refusal has its own sentence, code and `--json` answer,
        // and so has any failure of a role form.
        if (roleForm || error instanceof RoleCliError || roleFailureFromApi(error) !== null) {
          reportRoleFailure(error, options.json);
          return;
        }
        handleCommandError(error);
      }
    });
  return cmd;
}
