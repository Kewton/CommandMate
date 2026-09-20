/**
 * Cross-validation test: CLI model-validation.ts vs server cmate-cli-tool-parser.ts
 * Issue #588: Ensures the subset copy stays in sync with the canonical source (DR2-002)
 */

import { describe, it, expect } from 'vitest';
import {
  MODEL_NAME_PATTERN as CLI_PATTERN,
  MAX_MODEL_NAME_LENGTH as CLI_MAX_LENGTH,
  validateCopilotModelName as cliValidate,
  ANTIGRAVITY_MODEL_NAME_PATTERN as CLI_ANTIGRAVITY_PATTERN,
  MAX_ANTIGRAVITY_MODEL_NAME_LENGTH as CLI_ANTIGRAVITY_MAX_LENGTH,
  validateAntigravityModelName as cliValidateAntigravity,
  CLAUDE_MODEL_NAME_PATTERN as CLI_CLAUDE_PATTERN,
  MAX_CLAUDE_MODEL_NAME_LENGTH as CLI_CLAUDE_MAX_LENGTH,
  validateClaudeModelName as cliValidateClaude,
} from '@/cli/config/model-validation';
import {
  validateCopilotModelName as serverValidate,
  validateAntigravityModelName as serverValidateAntigravity,
  validateClaudeModelName as serverValidateClaude,
} from '@/lib/cmate-cli-tool-parser';
import {
  MODEL_NAME_PATTERN as SERVER_PATTERN,
  MAX_MODEL_NAME_LENGTH as SERVER_MAX_LENGTH,
} from '@/config/copilot-constants';
import {
  ANTIGRAVITY_MODEL_NAME_PATTERN as SERVER_ANTIGRAVITY_PATTERN,
  MAX_ANTIGRAVITY_MODEL_NAME_LENGTH as SERVER_ANTIGRAVITY_MAX_LENGTH,
} from '@/config/antigravity-constants';
import {
  CLAUDE_MODEL_NAME_PATTERN as SERVER_CLAUDE_PATTERN,
  MAX_CLAUDE_MODEL_NAME_LENGTH as SERVER_CLAUDE_MAX_LENGTH,
} from '@/config/claude-constants';

describe('model-validation cross-validation (DR2-002)', () => {
  it('MODEL_NAME_PATTERN source should match CLI copy', () => {
    expect(CLI_PATTERN.source).toBe(SERVER_PATTERN.source);
    expect(CLI_PATTERN.flags).toBe(SERVER_PATTERN.flags);
  });

  it('MAX_MODEL_NAME_LENGTH should match', () => {
    expect(CLI_MAX_LENGTH).toBe(SERVER_MAX_LENGTH);
  });

  // Test identical validation results for a variety of inputs
  const testCases = [
    'gpt-4',
    'o3-pro',
    'openai/gpt-4',
    'model:latest',
    '-invalid',
    '.dot-start',
    '/slash-start',
    'a'.repeat(128),
    'a'.repeat(129),
    '',
    '   ',
    'model<script>',
    'valid_model.v2',
    'a',
    'model name with spaces',
  ];

  for (const input of testCases) {
    it(`should produce identical results for "${input.length > 30 ? input.substring(0, 30) + '...' : input}"`, () => {
      const cliResult = cliValidate(input);
      const serverResult = serverValidate(input);
      expect(cliResult.valid).toBe(serverResult.valid);
      expect(cliResult.reason).toBe(serverResult.reason);
    });
  }
});

describe('antigravity model-validation cross-validation (Issue #989)', () => {
  it('ANTIGRAVITY_MODEL_NAME_PATTERN source should match CLI copy', () => {
    expect(CLI_ANTIGRAVITY_PATTERN.source).toBe(SERVER_ANTIGRAVITY_PATTERN.source);
    expect(CLI_ANTIGRAVITY_PATTERN.flags).toBe(SERVER_ANTIGRAVITY_PATTERN.flags);
  });

  it('MAX_ANTIGRAVITY_MODEL_NAME_LENGTH should match', () => {
    expect(CLI_ANTIGRAVITY_MAX_LENGTH).toBe(SERVER_ANTIGRAVITY_MAX_LENGTH);
  });

  // agy models display names include spaces and parentheses, unlike Copilot
  const antigravityTestCases = [
    'Gemini 3.5 Flash (Medium)',
    'Gemini 3.1 Pro (High)',
    'Claude Sonnet 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
    '-invalid',
    '.dot-start',
    'a'.repeat(128),
    'a'.repeat(129),
    '',
    '   ',
    "model'; rm -rf ~ #",
    'model`whoami`',
    'model$(whoami)',
    'model|pipe',
    'model;semicolon',
  ];

  for (const input of antigravityTestCases) {
    it(`should produce identical results for "${input.length > 30 ? input.substring(0, 30) + '...' : input}"`, () => {
      const cliResult = cliValidateAntigravity(input);
      const serverResult = serverValidateAntigravity(input);
      expect(cliResult.valid).toBe(serverResult.valid);
      expect(cliResult.reason).toBe(serverResult.reason);
    });
  }
});

describe('claude model-validation cross-validation (Issue #2771)', () => {
  it('CLAUDE_MODEL_NAME_PATTERN source should match CLI copy', () => {
    expect(CLI_CLAUDE_PATTERN.source).toBe(SERVER_CLAUDE_PATTERN.source);
    expect(CLI_CLAUDE_PATTERN.flags).toBe(SERVER_CLAUDE_PATTERN.flags);
  });

  it('MAX_CLAUDE_MODEL_NAME_LENGTH should match', () => {
    expect(CLI_CLAUDE_MAX_LENGTH).toBe(SERVER_CLAUDE_MAX_LENGTH);
  });

  const accepted = [
    'sonnet',
    'opus',
    'haiku',
    'opus[1m]',
    'claude-sonnet-5',
    'claude-opus-5[1m]',
    'claude-haiku-4-5-20251001',
    'us.anthropic.claude-sonnet-5-v1:0',
    'claude-sonnet-5@20260101',
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-5-v1:0',
    'a'.repeat(128),
  ];
  const rejected = [
    'Claude Sonnet 5 (Thinking)',
    'sonnet; rm -rf /',
    'sonnet$(id)',
    'sonnet`id`',
    "sonnet'",
    'sonnet opus',
    '-sonnet',
    '[1m]',
    '',
    '   ',
    'a'.repeat(129),
  ];

  it.each(accepted)('accepts %j on both sides', (input) => {
    expect(serverValidateClaude(input)).toEqual({ valid: true });
    expect(cliValidateClaude(input)).toEqual({ valid: true });
  });

  it.each(rejected)('rejects %j identically on both sides', (input) => {
    const server = serverValidateClaude(input);
    expect(server.valid).toBe(false);
    expect(cliValidateClaude(input)).toEqual(server);
  });

  it('rejects a control character identically on both sides', () => {
    const input = `sonnet${String.fromCharCode(0)}`;
    const server = serverValidateClaude(input);
    expect(server).toEqual({ valid: false, reason: 'Model name contains control characters' });
    expect(cliValidateClaude(input)).toEqual(server);
  });
});
