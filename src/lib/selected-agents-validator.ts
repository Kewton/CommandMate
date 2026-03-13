/**
 * Selected Agents Validator
 * Issue #368: Validation and parsing for worktree selected_agents field
 *
 * Provides:
 * - validateAgentsPair(): Core validation logic (R1-001)
 * - parseSelectedAgents(): DB read with fallback + console.warn (R4-005 log sanitization)
 * - validateSelectedAgentsInput(): API input validation
 */

import { CLI_TOOL_IDS, type CLIToolType } from './cli-tools/types';

/** Minimum number of selected agents */
export const MIN_SELECTED_AGENTS = 2;

/** Maximum number of selected agents (PC can select up to 4) */
export const MAX_SELECTED_AGENTS = 4;

/** Default selected agents when DB value is missing or invalid */
export const DEFAULT_SELECTED_AGENTS: CLIToolType[] = ['claude', 'codex', 'gemini'];

/**
 * Core validation function for CLI tool ID arrays (R1-001)
 * Accepts 2-4 unique valid CLI tool IDs.
 * Shared between parseSelectedAgents() and validateSelectedAgentsInput()
 *
 * @param input - Array of values to validate
 * @returns Validation result with optional typed value or error message
 */
export function validateAgentsPair(input: unknown[]): {
  valid: boolean;
  value?: CLIToolType[];
  error?: string;
} {
  if (input.length < MIN_SELECTED_AGENTS || input.length > MAX_SELECTED_AGENTS) {
    return { valid: false, error: `Must be ${MIN_SELECTED_AGENTS}-${MAX_SELECTED_AGENTS} elements` };
  }
  if (!input.every(id => typeof id === 'string' && (CLI_TOOL_IDS as readonly string[]).includes(id))) {
    return { valid: false, error: 'Invalid CLI tool ID' };
  }
  if (new Set(input).size !== input.length) {
    return { valid: false, error: 'Duplicate tool IDs not allowed' };
  }
  return { valid: true, value: input as CLIToolType[] };
}

/**
 * Parse selected_agents JSON from DB with safe fallback
 * Returns default value for any invalid input (never throws)
 *
 * Logs a warning when fallback is triggered to help detect DB data issues.
 * Log output is sanitized (R4-005): ANSI stripped, newlines removed, truncated.
 *
 * @param raw - Raw JSON string from DB (or null)
 * @returns Validated array of 2-4 CLIToolType values
 */
export function parseSelectedAgents(raw: string | null): CLIToolType[] {
  if (!raw) return DEFAULT_SELECTED_AGENTS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      // invalid format - return default silently
      return DEFAULT_SELECTED_AGENTS;
    }
    const result = validateAgentsPair(parsed);
    if (!result.valid) {
      // validation failed - return default silently
      return DEFAULT_SELECTED_AGENTS;
    }
    return result.value!;
  } catch {
    // JSON parse error - return default silently
    return DEFAULT_SELECTED_AGENTS;
  }
}

/**
 * Validate selectedAgents input from API request body
 * Returns structured error for API error responses (does not fallback)
 *
 * @param input - Raw input from request body (unknown type for safety)
 * @returns Validation result with typed value or error string
 */
export function validateSelectedAgentsInput(input: unknown): {
  valid: boolean;
  value?: CLIToolType[];
  error?: string;
} {
  if (!Array.isArray(input) || input.length < MIN_SELECTED_AGENTS || input.length > MAX_SELECTED_AGENTS) {
    return { valid: false, error: `selected_agents must be an array of ${MIN_SELECTED_AGENTS}-${MAX_SELECTED_AGENTS} elements` };
  }
  return validateAgentsPair(input);
}
