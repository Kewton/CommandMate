/**
 * Agent instances database operations (Issue #868).
 *
 * CRUD for the `agent_instances` table, which holds the explicit per-worktree
 * roster of agent instances. Each instance has a stable `(worktree_id,
 * instance_id)` identity. The PRIMARY instance of a CLI tool uses
 * `instance_id === cli_tool_id`, keeping session names / poller keys / DB rows
 * identical to the pre-#868 single-session behavior.
 *
 * Cap: a worktree may hold at most MAX_AGENT_INSTANCES instances; attempts to
 * exceed it throw AgentInstanceLimitError.
 */

import Database from 'better-sqlite3';
import {
  EMPTY_OPENCODE_INSTANCE_SETTINGS,
  hasOpencodeInstanceSettings,
  normalizeOpencodeInstanceSettings,
  type OpencodeInstanceSettings,
} from '@/types/opencode-instance-settings';
import {
  type AgentInstance,
  type CLIToolType,
  MAX_AGENT_INSTANCES,
  MAX_AGENT_ALIAS_LENGTH,
  isValidInstanceId,
  isCliToolType,
  getCliToolDisplayName,
} from '@/lib/cli-tools/types';

/**
 * Thrown when an operation would exceed MAX_AGENT_INSTANCES for a worktree.
 */
export class AgentInstanceLimitError extends Error {
  constructor(worktreeId: string, limit: number = MAX_AGENT_INSTANCES) {
    super(`Worktree ${worktreeId} cannot have more than ${limit} agent instances`);
    this.name = 'AgentInstanceLimitError';
  }
}

/**
 * Thrown when an instance definition fails validation (bad id, tool, or alias).
 */
export class InvalidAgentInstanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAgentInstanceError';
  }
}

interface AgentInstanceRow {
  worktree_id: string;
  instance_id: string;
  cli_tool_id: string;
  alias: string;
  sort_order: number;
  created_at: number;
}

/**
 * Map a DB row to an AgentInstance. When the stored alias is empty, fall back to
 * the CLI tool's display name so consumers always get a non-empty label.
 */
function mapAgentInstance(row: AgentInstanceRow): AgentInstance {
  const cliTool = row.cli_tool_id as CLIToolType;
  const alias = row.alias && row.alias.length > 0
    ? row.alias
    : (isCliToolType(row.cli_tool_id) ? getCliToolDisplayName(cliTool) : row.cli_tool_id);
  return {
    id: row.instance_id,
    cliTool,
    alias,
    order: row.sort_order,
  };
}

/**
 * Validate a single instance definition before persisting.
 * @throws InvalidAgentInstanceError when the id/tool/alias are not acceptable
 */
function validateInstance(instance: AgentInstance): void {
  if (!isValidInstanceId(instance.id)) {
    throw new InvalidAgentInstanceError(`Invalid instance id: ${String(instance.id)}`);
  }
  if (!isCliToolType(instance.cliTool)) {
    throw new InvalidAgentInstanceError(`Invalid CLI tool: ${String(instance.cliTool)}`);
  }
  if (typeof instance.alias === 'string' && instance.alias.length > MAX_AGENT_ALIAS_LENGTH) {
    throw new InvalidAgentInstanceError(
      `Alias exceeds ${MAX_AGENT_ALIAS_LENGTH} characters`
    );
  }
}

/**
 * Get all agent instances for a worktree, ordered by sort_order.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @returns Ordered list of agent instances (empty when none are configured)
 */
export function getAgentInstances(
  db: Database.Database,
  worktreeId: string
): AgentInstance[] {
  const rows = db.prepare(`
    SELECT worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at
    FROM agent_instances
    WHERE worktree_id = ?
    ORDER BY sort_order ASC, instance_id ASC
  `).all(worktreeId) as AgentInstanceRow[];

  return rows.map(mapAgentInstance);
}

/**
 * Get a single agent instance by id.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param instanceId - Instance ID
 * @returns The instance, or null when it does not exist
 */
export function getAgentInstance(
  db: Database.Database,
  worktreeId: string,
  instanceId: string
): AgentInstance | null {
  const row = db.prepare(`
    SELECT worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at
    FROM agent_instances
    WHERE worktree_id = ? AND instance_id = ?
  `).get(worktreeId, instanceId) as AgentInstanceRow | undefined;

  return row ? mapAgentInstance(row) : null;
}

/**
 * Outcome of {@link resolveInstanceCliTool}.
 *
 * `cliToolId: null` means the request carried no signal about which CLI tool
 * backs the instance; the caller applies its own default (worktree setting,
 * then 'claude').
 */
export type InstanceCliToolResolution =
  | { ok: true; cliToolId: CLIToolType | null }
  | {
      ok: false;
      instanceId: string;
      rosterCliTool: CLIToolType;
      requestedCliTool: CLIToolType;
    };

/**
 * Resolve which CLI tool backs a targeted agent instance (Issue #1629).
 *
 * The CLI tool id is part of the tmux session name, so getting it wrong starts
 * (or looks for) the wrong agent under a session name that claims otherwise:
 * `--instance codex` used to start Claude in `mcbd-claude-<wt>-codex`.
 *
 * Resolution order:
 *   1. the roster entry for `instanceId` — the roster is what declares that
 *      `codex` is a codex instance, so it wins over the worktree default
 *   2. `requestedCliTool`, for an instance the roster does not know about
 *      (the ad-hoc `send --instance <new-id>` / `--register` flow)
 *   3. `instanceId` when it is itself a CLI tool id — that is how the primary
 *      instance is anchored (Issue #868), and holds without a roster row
 *   4. no signal (`cliToolId: null`) — the caller falls back to its default
 *
 * An explicit `requestedCliTool` that contradicts the roster is reported as a
 * conflict rather than silently overriding it: the roster is user-maintained
 * and a mismatch means one of the two is wrong. Callers surface it as an error.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param instanceId - Targeted agent instance ID (omitted for the primary instance)
 * @param requestedCliTool - CLI tool explicitly named by the caller, if any
 */
export function resolveInstanceCliTool(
  db: Database.Database,
  worktreeId: string,
  instanceId: string | undefined,
  requestedCliTool?: CLIToolType
): InstanceCliToolResolution {
  if (!instanceId) {
    return { ok: true, cliToolId: requestedCliTool ?? null };
  }

  const registered = getAgentInstance(db, worktreeId, instanceId);
  if (registered && isCliToolType(registered.cliTool)) {
    if (requestedCliTool && requestedCliTool !== registered.cliTool) {
      return {
        ok: false,
        instanceId,
        rosterCliTool: registered.cliTool,
        requestedCliTool,
      };
    }
    return { ok: true, cliToolId: registered.cliTool };
  }

  // Not registered: an instance id that names a CLI tool is that tool's primary
  // instance by definition, which outranks the worktree default but not an
  // explicit request.
  if (requestedCliTool) {
    return { ok: true, cliToolId: requestedCliTool };
  }
  if (isCliToolType(instanceId)) {
    return { ok: true, cliToolId: instanceId };
  }
  return { ok: true, cliToolId: null };
}

/**
 * Count agent instances for a worktree.
 */
export function countAgentInstances(
  db: Database.Database,
  worktreeId: string
): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM agent_instances WHERE worktree_id = ?
  `).get(worktreeId) as { count: number };
  return row.count;
}

/**
 * Replace the full set of agent instances for a worktree (transactional).
 *
 * Enforces MAX_AGENT_INSTANCES and validates every instance before writing.
 * The empty alias is stored as '' so reads can fall back to the tool display
 * name; sort_order is taken from each instance's `order`.
 *
 * @throws AgentInstanceLimitError when instances.length > MAX_AGENT_INSTANCES
 * @throws InvalidAgentInstanceError when any instance is invalid
 */
export function setAgentInstances(
  db: Database.Database,
  worktreeId: string,
  instances: AgentInstance[]
): void {
  if (instances.length > MAX_AGENT_INSTANCES) {
    throw new AgentInstanceLimitError(worktreeId);
  }

  const seen = new Set<string>();
  for (const instance of instances) {
    validateInstance(instance);
    if (seen.has(instance.id)) {
      throw new InvalidAgentInstanceError(`Duplicate instance id: ${instance.id}`);
    }
    seen.add(instance.id);
  }

  const now = Date.now();
  const replace = db.transaction(() => {
    db.prepare(`DELETE FROM agent_instances WHERE worktree_id = ?`).run(worktreeId);
    // Issue #2048: the settings table is keyed on an instance id and this write
    // is a full replace, so an instance dropped from the roster would otherwise
    // leave its opencode settings behind for whoever next claimed that id.
    pruneOpencodeInstanceSettings(db, worktreeId, instances.map((instance) => instance.id));
    const insertStmt = db.prepare(`
      INSERT INTO agent_instances
        (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    instances.forEach((instance, index) => {
      const alias = instance.alias ?? '';
      const order = Number.isInteger(instance.order) ? instance.order : index;
      insertStmt.run(worktreeId, instance.id, instance.cliTool, alias, order, now);
    });
  });
  replace();
}

/**
 * Add a single agent instance to a worktree.
 *
 * @throws AgentInstanceLimitError when adding would exceed MAX_AGENT_INSTANCES
 * @throws InvalidAgentInstanceError when the instance id already exists or is invalid
 */
export function addAgentInstance(
  db: Database.Database,
  worktreeId: string,
  instance: AgentInstance
): void {
  validateInstance(instance);

  const add = db.transaction(() => {
    const count = countAgentInstances(db, worktreeId);
    if (count >= MAX_AGENT_INSTANCES) {
      throw new AgentInstanceLimitError(worktreeId);
    }

    const existing = getAgentInstance(db, worktreeId, instance.id);
    if (existing) {
      throw new InvalidAgentInstanceError(
        `Instance ${instance.id} already exists for worktree ${worktreeId}`
      );
    }

    const order = Number.isInteger(instance.order) ? instance.order : count;
    db.prepare(`
      INSERT INTO agent_instances
        (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(worktreeId, instance.id, instance.cliTool, instance.alias ?? '', order, Date.now());
  });
  add();
}

/**
 * Remove a single agent instance from a worktree.
 *
 * @returns true when a row was deleted
 */
export function removeAgentInstance(
  db: Database.Database,
  worktreeId: string,
  instanceId: string
): boolean {
  const result = db.prepare(`
    DELETE FROM agent_instances WHERE worktree_id = ? AND instance_id = ?
  `).run(worktreeId, instanceId);
  // Issue #2048: same rule as the replace above — the instance is gone, so what
  // it was configured to launch opencode with is gone with it.
  db.prepare(`
    DELETE FROM opencode_instance_settings WHERE worktree_id = ? AND instance_id = ?
  `).run(worktreeId, instanceId);
  return result.changes > 0;
}

// ============================================================================
// opencode launch settings (Issue #2048). Appended at the end of the file on
// purpose: everything below is additive and touches no export above it, so the
// roster CRUD's behaviour — and the `agentInstances` API contract that rests on
// it — is unchanged.
// ============================================================================

/** One row of `opencode_instance_settings`. */
interface OpencodeInstanceSettingsRow {
  agent: string | null;
  provider_id: string | null;
  model_id: string | null;
  variant: string | null;
}

/**
 * What this instance should launch and prompt opencode with (Issue #2048).
 *
 * Answers the all-unset settings for an instance with no row, which is every
 * instance until the settings pane writes one — and for an instance backed by
 * any other CLI tool, which never gets a row at all. The stored values are
 * re-validated on the way out rather than trusted: the row may have been written
 * by a build with a wider pattern, and the `agent` / `provider_id` / `model_id`
 * columns end up on a **shell command line**.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param instanceId - Instance ID (the primary instance uses the CLI tool id)
 */
export function getOpencodeInstanceSettings(
  db: Database.Database,
  worktreeId: string,
  instanceId: string
): OpencodeInstanceSettings {
  const row = db.prepare(`
    SELECT agent, provider_id, model_id, variant
    FROM opencode_instance_settings
    WHERE worktree_id = ? AND instance_id = ?
  `).get(worktreeId, instanceId) as OpencodeInstanceSettingsRow | undefined;

  if (!row) return { ...EMPTY_OPENCODE_INSTANCE_SETTINGS };
  return normalizeOpencodeInstanceSettings({
    agent: row.agent,
    providerId: row.provider_id,
    modelId: row.model_id,
    variant: row.variant,
  });
}

/**
 * Every opencode setting stored for a worktree, keyed by instance id.
 *
 * One statement rather than one per roster entry: the settings pane asks for the
 * whole worktree at once, and an instance with no row is simply absent from the
 * result — callers fill it with {@link EMPTY_OPENCODE_INSTANCE_SETTINGS}.
 */
export function getOpencodeInstanceSettingsByWorktree(
  db: Database.Database,
  worktreeId: string
): Record<string, OpencodeInstanceSettings> {
  const rows = db.prepare(`
    SELECT instance_id, agent, provider_id, model_id, variant
    FROM opencode_instance_settings
    WHERE worktree_id = ?
  `).all(worktreeId) as Array<OpencodeInstanceSettingsRow & { instance_id: string }>;

  const settings: Record<string, OpencodeInstanceSettings> = {};
  for (const row of rows) {
    settings[row.instance_id] = normalizeOpencodeInstanceSettings({
      agent: row.agent,
      providerId: row.provider_id,
      modelId: row.model_id,
      variant: row.variant,
    });
  }
  return settings;
}

/**
 * Write one instance's opencode settings.
 *
 * Validated before the write as well as after the read — a value that would not
 * survive {@link normalizeOpencodeInstanceSettings} is stored as null rather
 * than kept, so nothing unusable ever reaches the launcher even if a later build
 * loosens the reader.
 *
 * An all-unset write **deletes the row** instead of storing four nulls. The two
 * states are indistinguishable to every reader, and the delete keeps the table
 * to the instances somebody actually configured.
 *
 * @throws InvalidAgentInstanceError when the instance id is not a valid one
 */
export function setOpencodeInstanceSettings(
  db: Database.Database,
  worktreeId: string,
  instanceId: string,
  settings: OpencodeInstanceSettings,
  at: number = Date.now()
): OpencodeInstanceSettings {
  if (!isValidInstanceId(instanceId)) {
    throw new InvalidAgentInstanceError(`Invalid instance id: ${String(instanceId)}`);
  }
  const normalized = normalizeOpencodeInstanceSettings(settings);

  if (!hasOpencodeInstanceSettings(normalized)) {
    db.prepare(`
      DELETE FROM opencode_instance_settings WHERE worktree_id = ? AND instance_id = ?
    `).run(worktreeId, instanceId);
    return normalized;
  }

  db.prepare(`
    INSERT INTO opencode_instance_settings
      (worktree_id, instance_id, agent, provider_id, model_id, variant, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(worktree_id, instance_id) DO UPDATE SET
      agent = excluded.agent,
      provider_id = excluded.provider_id,
      model_id = excluded.model_id,
      variant = excluded.variant,
      updated_at = excluded.updated_at
  `).run(
    worktreeId,
    instanceId,
    normalized.agent,
    normalized.providerId,
    normalized.modelId,
    normalized.variant,
    at
  );
  return normalized;
}

/**
 * Drop the settings of instances that are no longer in the roster.
 *
 * Called by {@link setAgentInstances} and {@link removeAgentInstance}, because
 * `opencode_instance_settings` is keyed on an instance id and nothing else would
 * ever remove a row for an instance the operator deleted. Re-adding an instance
 * under the same id therefore starts from opencode's defaults rather than
 * inheriting a setting from a roster entry that no longer exists.
 *
 * @param keepInstanceIds - The ids that survive; every other row is deleted
 * @returns How many rows were removed
 */
export function pruneOpencodeInstanceSettings(
  db: Database.Database,
  worktreeId: string,
  keepInstanceIds: readonly string[]
): number {
  if (keepInstanceIds.length === 0) {
    return db.prepare(`
      DELETE FROM opencode_instance_settings WHERE worktree_id = ?
    `).run(worktreeId).changes;
  }
  const placeholders = keepInstanceIds.map(() => '?').join(', ');
  return db.prepare(`
    DELETE FROM opencode_instance_settings
    WHERE worktree_id = ? AND instance_id NOT IN (${placeholders})
  `).run(worktreeId, ...keepInstanceIds).changes;
}
