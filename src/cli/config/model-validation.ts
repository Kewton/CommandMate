/**
 * Model Validation (CLI subset copy)
 * Issue #588: Subset of cmate-cli-tool-parser.ts for CLI build (DR2-002)
 *
 * This file duplicates MODEL_NAME_PATTERN, MAX_MODEL_NAME_LENGTH, and
 * validateCopilotModelName from the server-side module to avoid importing
 * server-only dependencies in the CLI build.
 *
 * Cross-validation test: tests/unit/cli/config/model-validation-sync.test.ts
 * ensures these values stay in sync with the canonical source.
 */

/**
 * Copilot model name allowed pattern.
 * Must match copilot-constants.ts MODEL_NAME_PATTERN exactly.
 */
export const MODEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9\-._/:]*$/;

/**
 * Maximum model name length.
 * Must match copilot-constants.ts MAX_MODEL_NAME_LENGTH exactly.
 */
export const MAX_MODEL_NAME_LENGTH = 128;

/**
 * Validate a Copilot model name (reject approach).
 * Must produce identical results to cmate-cli-tool-parser.ts validateCopilotModelName().
 *
 * @param modelName - Model name to validate
 * @returns Validation result
 */
export function validateCopilotModelName(modelName: string): { valid: boolean; reason?: string } {
  if (/[\x00-\x1f\x7f]/.test(modelName)) {
    return { valid: false, reason: 'Model name contains control characters' };
  }
  if (modelName.trim() === '') {
    return { valid: false, reason: 'Model name must not be empty' };
  }
  if (!MODEL_NAME_PATTERN.test(modelName)) {
    return { valid: false, reason: 'Model name contains invalid characters' };
  }
  if (modelName.length > MAX_MODEL_NAME_LENGTH) {
    return { valid: false, reason: `Model name exceeds ${MAX_MODEL_NAME_LENGTH} characters` };
  }
  return { valid: true };
}
