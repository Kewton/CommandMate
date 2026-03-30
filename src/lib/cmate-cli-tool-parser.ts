/**
 * CMATE CLI Tool Column Parser (Pure Module)
 * Issue #588: Shared parse/validation for CLI Tool column in CMATE.md
 *
 * This module has NO fs/path/Node.js dependencies and can be safely imported
 * from both server-side (cmate-parser.ts) and client-side (cmate-validator.ts).
 *
 * Exports:
 * - parseCliToolColumn(): tokenize raw CLI Tool column string
 * - validateCopilotModelName(): validate model name (reject approach)
 * - parseAndValidateCliToolColumn(): combined pipeline entry point
 * - TOOLS_WITH_MODEL_SUPPORT: Set of tools supporting --model in CMATE.md
 */

import { MODEL_NAME_PATTERN, MAX_MODEL_NAME_LENGTH } from '@/config/copilot-constants';

// =============================================================================
// Types
// =============================================================================

/** Result of parsing a CLI Tool column value */
export interface ParsedCliToolColumn {
  /** Resolved CLI tool ID (e.g., 'claude', 'copilot') */
  cliToolId: string;
  /** Model name if --model was specified */
  model?: string;
  /** Syntax error reason (DR1-002: integrated into parse result) */
  error?: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * CLI Tools that support --model <name> syntax in CMATE.md CLI Tool column (DR2-005).
 * This Set controls which tools accept the --model option in the CMATE.md schedule table.
 * vibe-local model is managed via DB (worktree.vibe_local_model), not CMATE.md.
 * To add CMATE.md --model support for a new tool, add it here (DR1-006).
 */
export const TOOLS_WITH_MODEL_SUPPORT = new Set(['copilot']);

// =============================================================================
// Parse Functions
// =============================================================================

/**
 * Parse a raw CLI Tool column string into cliToolId and optional model.
 * Syntax errors are reported via the error field (DR1-002).
 *
 * Examples:
 * - "copilot --model gpt-5.4-mini" -> { cliToolId: "copilot", model: "gpt-5.4-mini" }
 * - "claude" -> { cliToolId: "claude", model: undefined }
 * - "" / "  " -> { cliToolId: "claude", model: undefined } (default)
 * - "claude --model x" -> { cliToolId: "claude", error: "..." }
 *
 * Security (DR4-002): Error messages use fixed text + allowed syntax hints,
 * not raw input values, to prevent log injection / UI toast pollution.
 *
 * @param raw - Raw CLI Tool column value from CMATE.md table
 * @returns Parsed result with optional error
 */
export function parseCliToolColumn(raw: string): ParsedCliToolColumn {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { cliToolId: 'claude', model: undefined };
  }

  const tokens = trimmed.split(/\s+/);
  const cliToolId = tokens[0];

  if (tokens.length === 1) {
    return { cliToolId, model: undefined };
  }

  // Tools without --model support must not have additional tokens (DR1-006)
  if (!TOOLS_WITH_MODEL_SUPPORT.has(cliToolId)) {
    return { cliToolId, error: `CLI Tool "${cliToolId}" does not support additional options` };
  }

  // Only accept: <tool> --model <name> (exactly 3 tokens)
  if (tokens.length === 3 && tokens[1] === '--model') {
    return { cliToolId, model: tokens[2] };
  }

  // Invalid additional tokens
  return { cliToolId, error: `${cliToolId} only supports: ${cliToolId} --model <modelName>` };
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate a Copilot model name using the reject approach (no sanitization).
 * Shared between send API, CLI send, parser, and validator (DR1-003).
 *
 * @param modelName - Model name to validate
 * @returns Validation result with optional reason for rejection
 */
export function validateCopilotModelName(modelName: string): { valid: boolean; reason?: string } {
  // Control character rejection
  if (/[\x00-\x1f\x7f]/.test(modelName)) {
    return { valid: false, reason: 'Model name contains control characters' };
  }

  // Empty / whitespace-only rejection
  if (modelName.trim() === '') {
    return { valid: false, reason: 'Model name must not be empty' };
  }

  // Pattern validation (leading alphanumeric required, DR4-001)
  if (!MODEL_NAME_PATTERN.test(modelName)) {
    return { valid: false, reason: 'Model name contains invalid characters' };
  }

  // Length validation
  if (modelName.length > MAX_MODEL_NAME_LENGTH) {
    return { valid: false, reason: `Model name exceeds ${MAX_MODEL_NAME_LENGTH} characters` };
  }

  return { valid: true };
}

// =============================================================================
// Combined Pipeline
// =============================================================================

/**
 * Parse and validate a CLI Tool column value in a single call (DR1-005, DR1-007).
 * Both cmate-parser.ts and cmate-validator.ts use this entry point.
 *
 * Orchestration order:
 * 1. parseCliToolColumn() - tokenize and extract cliToolId + model
 * 2. validateCopilotModelName() - validate model name if present
 *
 * Note: isCliToolType() validation is left to the caller, as parser and
 * validator handle unknown tool IDs differently (skip vs. report error).
 *
 * @param raw - Raw CLI Tool column value
 * @returns result: parsed data, errors: validation error messages
 */
export function parseAndValidateCliToolColumn(
  raw: string
): { result: ParsedCliToolColumn; errors: string[] } {
  const errors: string[] = [];
  const parsed = parseCliToolColumn(raw);

  // Syntax error check
  if (parsed.error) {
    errors.push(parsed.error);
  }

  // Model name validation (only when model is present)
  if (parsed.model) {
    const modelResult = validateCopilotModelName(parsed.model);
    if (!modelResult.valid) {
      errors.push(modelResult.reason!);
    }
  }

  return { result: parsed, errors };
}
