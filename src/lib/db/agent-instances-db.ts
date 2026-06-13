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
  return result.changes > 0;
}
