/**
 * Agent Instances Validator (Issue #869).
 *
 * Validates the `agentInstances` payload accepted by
 * `PATCH /api/worktrees/[id]`. Mirrors selected-agents-validator: returns a
 * structured `{ valid, value?, error? }` result instead of throwing, so the API
 * layer can map failures to 400 responses.
 *
 * Rules:
 * - 1..MAX_AGENT_INSTANCES entries (a worktree always keeps at least one).
 * - Each entry: valid instance id, valid CLI tool, alias string within length.
 * - Instance ids must be unique within the payload.
 * - When an instance id equals a CLI tool id (the primary anchor), its
 *   `cliTool` must match that id, keeping `id === cliTool` consistent.
 * - `order` is normalized to the array position so drag-and-drop reordering
 *   only needs to send the array in the desired order.
 */

import {
  type AgentInstance,
  type CLIToolType,
  MAX_AGENT_INSTANCES,
  MAX_AGENT_ALIAS_LENGTH,
  isValidInstanceId,
  isCliToolType,
} from './cli-tools/types';

/** Minimum number of agent instances a worktree must retain (Issue #869). */
export const MIN_AGENT_INSTANCES = 1;

/**
 * Validate the `agentInstances` input from an API request body.
 *
 * @param input - Raw value from the request body (unknown for safety)
 * @returns Validation result with a normalized AgentInstance[] or an error
 */
export function validateAgentInstancesInput(input: unknown): {
  valid: boolean;
  value?: AgentInstance[];
  error?: string;
} {
  if (!Array.isArray(input)) {
    return { valid: false, error: 'agentInstances must be an array' };
  }
  if (input.length < MIN_AGENT_INSTANCES) {
    return { valid: false, error: `agentInstances must have at least ${MIN_AGENT_INSTANCES} entry` };
  }
  if (input.length > MAX_AGENT_INSTANCES) {
    return { valid: false, error: `agentInstances must have at most ${MAX_AGENT_INSTANCES} entries` };
  }

  const seen = new Set<string>();
  const normalized: AgentInstance[] = [];

  for (let index = 0; index < input.length; index++) {
    const raw = input[index];
    if (typeof raw !== 'object' || raw === null) {
      return { valid: false, error: `agentInstances[${index}] must be an object` };
    }
    const candidate = raw as Record<string, unknown>;

    const id = candidate.id;
    if (typeof id !== 'string' || !isValidInstanceId(id)) {
      return { valid: false, error: `agentInstances[${index}].id is invalid` };
    }
    if (seen.has(id)) {
      return { valid: false, error: `agentInstances[${index}].id is duplicated: ${id}` };
    }

    const cliTool = candidate.cliTool;
    if (typeof cliTool !== 'string' || !isCliToolType(cliTool)) {
      return { valid: false, error: `agentInstances[${index}].cliTool is invalid` };
    }

    // Primary-anchor consistency: an id that equals a CLI tool id must back that
    // exact tool (id === cliTool keeps session names / poller keys stable).
    if (isCliToolType(id) && id !== cliTool) {
      return {
        valid: false,
        error: `agentInstances[${index}].id "${id}" conflicts with cliTool "${cliTool}"`,
      };
    }

    let alias = '';
    if (candidate.alias !== undefined && candidate.alias !== null) {
      if (typeof candidate.alias !== 'string') {
        return { valid: false, error: `agentInstances[${index}].alias must be a string` };
      }
      if (candidate.alias.length > MAX_AGENT_ALIAS_LENGTH) {
        return {
          valid: false,
          error: `agentInstances[${index}].alias exceeds ${MAX_AGENT_ALIAS_LENGTH} characters`,
        };
      }
      alias = candidate.alias;
    }

    seen.add(id);
    normalized.push({
      id,
      cliTool: cliTool as CLIToolType,
      alias,
      order: index,
    });
  }

  return { valid: true, value: normalized };
}
