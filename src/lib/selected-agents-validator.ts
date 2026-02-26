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

/**
 * ANSI escape code pattern for log sanitization (R4-005)
 * Duplicated from cli-patterns.ts to avoid importing server-side logger chain
 */
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\[[0-9;]*m/g;

/**
 * Strip ANSI escape codes from a string
 */
function stripAnsi(str: string): string {
  return str.replace(ANSI_PATTERN, '');
}

/**
 * Sanitize raw DB value for safe console.warn output (R4-005)
 * Removes ANSI escapes, newlines, and truncates to 100 chars
 */
function sanitizeRawForLog(raw: string): string {
  return stripAnsi(raw).replace(/[\n\r]/g, ' ').substring(0, 100);
}

/** Default selected agents when DB value is missing or invalid */
export const DEFAULT_SELECTED_AGENTS: [CLIToolType, CLIToolType] = ['claude', 'codex'];

/**
 * Core validation function for a pair of CLI tool IDs (R1-001)
 * Shared between parseSelectedAgents() and validateSelectedAgentsInput()
 *
 * @param input - Array of values to validate
 * @returns Validation result with optional typed value or error message
 */
export function validateAgentsPair(input: unknown[]): {
  valid: boolean;
  value?: [CLIToolType, CLIToolType];
  error?: string;
} {
  if (input.length !== 2) {
    return { valid: false, error: 'Must be 2 elements' };
  }
  if (!input.every(id => typeof id === 'string' && (CLI_TOOL_IDS as readonly string[]).includes(id))) {
    return { valid: false, error: 'Invalid CLI tool ID' };
  }
  if (input[0] === input[1]) {
    return { valid: false, error: 'Duplicate tool IDs not allowed' };
  }
  return { valid: true, value: input as [CLIToolType, CLIToolType] };
}

/**
 * Parse selected_agents JSON from DB with safe fallback
 * Returns default value for any invalid input (never throws)
 *
 * Logs a warning when fallback is triggered to help detect DB data issues.
 * Log output is sanitized (R4-005): ANSI stripped, newlines removed, truncated.
 *
 * @param raw - Raw JSON string from DB (or null)
 * @returns Validated tuple of 2 CLIToolType values
 */
export function parseSelectedAgents(raw: string | null): [CLIToolType, CLIToolType] {
  if (!raw) return DEFAULT_SELECTED_AGENTS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`[selected-agents] Invalid format in DB, falling back to default: ${sanitizeRawForLog(raw)}`);
      return DEFAULT_SELECTED_AGENTS;
    }
    const result = validateAgentsPair(parsed);
    if (!result.valid) {
      console.warn(`[selected-agents] Invalid data in DB (${result.error}), falling back to default: ${sanitizeRawForLog(raw)}`);
      return DEFAULT_SELECTED_AGENTS;
    }
    return result.value!;
  } catch {
    console.warn(`[selected-agents] JSON parse error in DB, falling back to default: ${sanitizeRawForLog(raw)}`);
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
  value?: [CLIToolType, CLIToolType];
  error?: string;
} {
  if (!Array.isArray(input) || input.length !== 2) {
    return { valid: false, error: 'selected_agents must be an array of 2 elements' };
  }
  return validateAgentsPair(input);
}
