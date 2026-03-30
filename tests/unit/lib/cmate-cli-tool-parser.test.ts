/**
 * Unit tests for cmate-cli-tool-parser.ts
 * Issue #588: Shared CLI Tool column parse/validation module
 */

import { describe, it, expect } from 'vitest';
import {
  parseCliToolColumn,
  validateCopilotModelName,
  parseAndValidateCliToolColumn,
  TOOLS_WITH_MODEL_SUPPORT,
  type ParsedCliToolColumn,
} from '@/lib/cmate-cli-tool-parser';
import { MODEL_NAME_PATTERN, MAX_MODEL_NAME_LENGTH } from '@/config/copilot-constants';

// =============================================================================
// parseCliToolColumn
// =============================================================================

describe('parseCliToolColumn', () => {
  // Default / empty cases
  it('should return claude as default for empty string', () => {
    const result = parseCliToolColumn('');
    expect(result).toEqual({ cliToolId: 'claude', model: undefined });
  });

  it('should return claude as default for whitespace-only string', () => {
    const result = parseCliToolColumn('   ');
    expect(result).toEqual({ cliToolId: 'claude', model: undefined });
  });

  // Single tool ID cases
  it('should parse "claude" correctly', () => {
    expect(parseCliToolColumn('claude')).toEqual({ cliToolId: 'claude', model: undefined });
  });

  it('should parse "copilot" correctly', () => {
    expect(parseCliToolColumn('copilot')).toEqual({ cliToolId: 'copilot', model: undefined });
  });

  it('should parse "codex" correctly', () => {
    expect(parseCliToolColumn('codex')).toEqual({ cliToolId: 'codex', model: undefined });
  });

  it('should parse "gemini" correctly', () => {
    expect(parseCliToolColumn('gemini')).toEqual({ cliToolId: 'gemini', model: undefined });
  });

  it('should parse "vibe-local" correctly', () => {
    expect(parseCliToolColumn('vibe-local')).toEqual({ cliToolId: 'vibe-local', model: undefined });
  });

  it('should parse "opencode" correctly', () => {
    expect(parseCliToolColumn('opencode')).toEqual({ cliToolId: 'opencode', model: undefined });
  });

  // Copilot --model cases
  it('should parse "copilot --model gpt-5.4-mini" correctly', () => {
    const result = parseCliToolColumn('copilot --model gpt-5.4-mini');
    expect(result).toEqual({ cliToolId: 'copilot', model: 'gpt-5.4-mini' });
  });

  it('should parse "copilot --model o3-pro" correctly', () => {
    const result = parseCliToolColumn('copilot --model o3-pro');
    expect(result).toEqual({ cliToolId: 'copilot', model: 'o3-pro' });
  });

  it('should parse copilot with model containing slashes', () => {
    const result = parseCliToolColumn('copilot --model openai/gpt-4');
    expect(result).toEqual({ cliToolId: 'copilot', model: 'openai/gpt-4' });
  });

  it('should parse copilot with model containing colons', () => {
    const result = parseCliToolColumn('copilot --model model:latest');
    expect(result).toEqual({ cliToolId: 'copilot', model: 'model:latest' });
  });

  // Error cases: unsupported tools with extra tokens
  it('should error when claude has --model option', () => {
    const result = parseCliToolColumn('claude --model gpt-4');
    expect(result.error).toBeDefined();
    expect(result.cliToolId).toBe('claude');
    expect(result.error).toContain('does not support additional options');
  });

  it('should error when codex has --model option', () => {
    const result = parseCliToolColumn('codex --model gpt-4');
    expect(result.error).toBeDefined();
    expect(result.cliToolId).toBe('codex');
  });

  it('should error when gemini has --model option', () => {
    const result = parseCliToolColumn('gemini --model test');
    expect(result.error).toBeDefined();
  });

  it('should error when vibe-local has --model option', () => {
    const result = parseCliToolColumn('vibe-local --model test');
    expect(result.error).toBeDefined();
  });

  // Error cases: invalid copilot syntax
  it('should error when copilot has unknown flag', () => {
    const result = parseCliToolColumn('copilot --unknown flag');
    expect(result.error).toBeDefined();
    expect(result.error).toContain('only supports');
  });

  it('should error when copilot has too many tokens', () => {
    const result = parseCliToolColumn('copilot --model gpt-4 --extra');
    expect(result.error).toBeDefined();
  });

  it('should error when copilot --model has no value', () => {
    const result = parseCliToolColumn('copilot --model');
    expect(result.error).toBeDefined();
  });

  // Trimming
  it('should trim leading/trailing whitespace', () => {
    const result = parseCliToolColumn('  copilot  ');
    expect(result).toEqual({ cliToolId: 'copilot', model: undefined });
  });

  it('should handle extra whitespace between tokens', () => {
    const result = parseCliToolColumn('copilot   --model   gpt-4');
    expect(result).toEqual({ cliToolId: 'copilot', model: 'gpt-4' });
  });
});

// =============================================================================
// validateCopilotModelName
// =============================================================================

describe('validateCopilotModelName', () => {
  // Valid model names
  it('should accept simple alphanumeric model name', () => {
    expect(validateCopilotModelName('gpt4')).toEqual({ valid: true });
  });

  it('should accept model name with hyphens', () => {
    expect(validateCopilotModelName('gpt-5.4-mini')).toEqual({ valid: true });
  });

  it('should accept model name with dots', () => {
    expect(validateCopilotModelName('model.v2')).toEqual({ valid: true });
  });

  it('should accept model name with slashes', () => {
    expect(validateCopilotModelName('openai/gpt-4')).toEqual({ valid: true });
  });

  it('should accept model name with colons', () => {
    expect(validateCopilotModelName('model:latest')).toEqual({ valid: true });
  });

  it('should accept model name with underscores', () => {
    expect(validateCopilotModelName('my_model')).toEqual({ valid: true });
  });

  it('should accept single character model name', () => {
    expect(validateCopilotModelName('a')).toEqual({ valid: true });
  });

  it('should accept model name at max length boundary', () => {
    const name = 'a' + 'b'.repeat(MAX_MODEL_NAME_LENGTH - 1);
    expect(validateCopilotModelName(name)).toEqual({ valid: true });
  });

  // Invalid model names
  it('should reject empty string', () => {
    const result = validateCopilotModelName('');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('empty');
  });

  it('should reject whitespace-only string', () => {
    const result = validateCopilotModelName('   ');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('empty');
  });

  it('should reject model name starting with hyphen (DR4-001)', () => {
    const result = validateCopilotModelName('-model');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('invalid characters');
  });

  it('should reject model name starting with dot', () => {
    const result = validateCopilotModelName('.model');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('invalid characters');
  });

  it('should reject model name starting with slash', () => {
    const result = validateCopilotModelName('/model');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('invalid characters');
  });

  it('should reject model name with spaces', () => {
    const result = validateCopilotModelName('model name');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('invalid characters');
  });

  it('should reject model name with control characters', () => {
    const result = validateCopilotModelName('model\x00name');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('control characters');
  });

  it('should reject model name with special characters', () => {
    expect(validateCopilotModelName('model<script>')).toEqual({
      valid: false,
      reason: 'Model name contains invalid characters',
    });
  });

  it('should reject model name exceeding max length', () => {
    const name = 'a'.repeat(MAX_MODEL_NAME_LENGTH + 1);
    const result = validateCopilotModelName(name);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain(`exceeds ${MAX_MODEL_NAME_LENGTH}`);
  });
});

// =============================================================================
// parseAndValidateCliToolColumn (combined pipeline)
// =============================================================================

describe('parseAndValidateCliToolColumn', () => {
  it('should return no errors for valid copilot --model', () => {
    const { result, errors } = parseAndValidateCliToolColumn('copilot --model gpt-4');
    expect(errors).toHaveLength(0);
    expect(result.cliToolId).toBe('copilot');
    expect(result.model).toBe('gpt-4');
  });

  it('should return no errors for plain tool ID', () => {
    const { result, errors } = parseAndValidateCliToolColumn('claude');
    expect(errors).toHaveLength(0);
    expect(result.cliToolId).toBe('claude');
    expect(result.model).toBeUndefined();
  });

  it('should return no errors for empty string (default claude)', () => {
    const { result, errors } = parseAndValidateCliToolColumn('');
    expect(errors).toHaveLength(0);
    expect(result.cliToolId).toBe('claude');
  });

  it('should report syntax error for unsupported tool with --model', () => {
    const { errors } = parseAndValidateCliToolColumn('claude --model gpt-4');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('does not support');
  });

  it('should report model validation error for invalid model name', () => {
    const { errors } = parseAndValidateCliToolColumn('copilot --model -invalid');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('invalid characters'))).toBe(true);
  });

  it('should report both syntax and model errors when applicable', () => {
    // copilot with invalid syntax (too many tokens)
    const { errors } = parseAndValidateCliToolColumn('copilot --model gpt-4 --extra');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should report error for copilot --model with too-long name', () => {
    const longModel = 'a'.repeat(MAX_MODEL_NAME_LENGTH + 1);
    const { errors } = parseAndValidateCliToolColumn(`copilot --model ${longModel}`);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('exceeds'))).toBe(true);
  });

  it('should always return result even when errors exist', () => {
    const { result, errors } = parseAndValidateCliToolColumn('claude --model x');
    expect(result).toBeDefined();
    expect(result.cliToolId).toBe('claude');
    expect(errors.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// TOOLS_WITH_MODEL_SUPPORT
// =============================================================================

describe('TOOLS_WITH_MODEL_SUPPORT', () => {
  it('should contain copilot', () => {
    expect(TOOLS_WITH_MODEL_SUPPORT.has('copilot')).toBe(true);
  });

  it('should not contain claude', () => {
    expect(TOOLS_WITH_MODEL_SUPPORT.has('claude')).toBe(false);
  });

  it('should not contain codex', () => {
    expect(TOOLS_WITH_MODEL_SUPPORT.has('codex')).toBe(false);
  });

  it('should not contain vibe-local', () => {
    expect(TOOLS_WITH_MODEL_SUPPORT.has('vibe-local')).toBe(false);
  });

  it('should have exactly 1 member', () => {
    expect(TOOLS_WITH_MODEL_SUPPORT.size).toBe(1);
  });
});

// =============================================================================
// MODEL_NAME_PATTERN boundary tests (DR3-003)
// =============================================================================

describe('MODEL_NAME_PATTERN (imported from copilot-constants)', () => {
  it('should require leading alphanumeric character', () => {
    expect(MODEL_NAME_PATTERN.test('a')).toBe(true);
    expect(MODEL_NAME_PATTERN.test('0')).toBe(true);
    expect(MODEL_NAME_PATTERN.test('A')).toBe(true);
    expect(MODEL_NAME_PATTERN.test('-a')).toBe(false);
    expect(MODEL_NAME_PATTERN.test('.a')).toBe(false);
    expect(MODEL_NAME_PATTERN.test('/a')).toBe(false);
  });

  it('should allow hyphens, dots, underscores, slashes, colons after first char', () => {
    expect(MODEL_NAME_PATTERN.test('a-b')).toBe(true);
    expect(MODEL_NAME_PATTERN.test('a.b')).toBe(true);
    expect(MODEL_NAME_PATTERN.test('a_b')).toBe(true);
    expect(MODEL_NAME_PATTERN.test('a/b')).toBe(true);
    expect(MODEL_NAME_PATTERN.test('a:b')).toBe(true);
  });

  it('should reject spaces', () => {
    expect(MODEL_NAME_PATTERN.test('a b')).toBe(false);
  });

  it('should reject special characters', () => {
    expect(MODEL_NAME_PATTERN.test('a@b')).toBe(false);
    expect(MODEL_NAME_PATTERN.test('a#b')).toBe(false);
    expect(MODEL_NAME_PATTERN.test('a$b')).toBe(false);
  });
});
