/**
 * Cross-validation test: CLI model-validation.ts vs server cmate-cli-tool-parser.ts
 * Issue #588: Ensures the subset copy stays in sync with the canonical source (DR2-002)
 */

import { describe, it, expect } from 'vitest';
import {
  MODEL_NAME_PATTERN as CLI_PATTERN,
  MAX_MODEL_NAME_LENGTH as CLI_MAX_LENGTH,
  validateCopilotModelName as cliValidate,
} from '@/cli/config/model-validation';
import {
  validateCopilotModelName as serverValidate,
} from '@/lib/cmate-cli-tool-parser';
import {
  MODEL_NAME_PATTERN as SERVER_PATTERN,
  MAX_MODEL_NAME_LENGTH as SERVER_MAX_LENGTH,
} from '@/config/copilot-constants';

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
