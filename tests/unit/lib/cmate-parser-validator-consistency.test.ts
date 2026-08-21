/**
 * Consistency tests for cmate-parser.ts and cmate-validator.ts
 * Issue #584: Verify COPILOT_PERMISSIONS values are accepted by both parser and validator (SEC4-004)
 */

import { describe, it, expect, vi } from 'vitest';

// Mock logger module (required by cmate-parser.ts)
const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  };
  return { mockLogger };
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

import { parseSchedulesSection } from '@/lib/cmate-parser';
import { validateSchedulesSection } from '@/lib/cmate-validator';
import { COPILOT_PERMISSIONS, ANTIGRAVITY_PERMISSIONS, CLAUDE_PERMISSIONS } from '@/config/schedule-config';

describe('cmate-parser / cmate-validator consistency (SEC4-004)', () => {
  for (const permission of COPILOT_PERMISSIONS) {
    it(`should accept copilot permission "${permission}" in both parser and validator`, () => {
      const row = ['copilot-task', '0 9 * * *', 'Do something', 'copilot', 'true', permission];

      // Parser should accept and preserve the permission value
      const entries = parseSchedulesSection([row]);
      expect(entries).toHaveLength(1);
      expect(entries[0].permission).toBe(permission);

      // Validator should return no errors
      const errors = validateSchedulesSection([row]);
      expect(errors).toEqual([]);
    });
  }

  it('should reject the same invalid permission in both parser and validator', () => {
    const row = ['copilot-task', '0 9 * * *', 'Do something', 'copilot', 'true', 'invalid-perm'];

    // Parser should fallback to default
    const entries = parseSchedulesSection([row]);
    expect(entries).toHaveLength(1);
    expect(entries[0].permission).not.toBe('invalid-perm');

    // Validator should return an error
    const errors = validateSchedulesSection([row]);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('permission');
  });

  // Issue #588: copilot --model consistency
  it('should accept "copilot --model gpt-4" in both parser and validator', () => {
    const row = ['copilot-task', '0 9 * * *', 'Do something', 'copilot --model gpt-4', 'true', 'allow-all-tools'];

    // Parser should accept and set model
    const entries = parseSchedulesSection([row]);
    expect(entries).toHaveLength(1);
    expect(entries[0].cliToolId).toBe('copilot');
    expect(entries[0].model).toBe('gpt-4');

    // Validator should return no errors
    const errors = validateSchedulesSection([row]);
    expect(errors).toEqual([]);
  });

  it('should reject "claude --model gpt-4" in both parser and validator', () => {
    const row = ['task', '0 9 * * *', 'Do something', 'claude --model gpt-4', 'true'];

    // Parser should skip (returns empty)
    const entries = parseSchedulesSection([row]);
    expect(entries).toHaveLength(0);

    // Validator should report error
    const errors = validateSchedulesSection([row]);
    expect(errors.length).toBeGreaterThan(0);
  });

  // Issue #989: antigravity permission consistency
  for (const permission of ANTIGRAVITY_PERMISSIONS) {
    it(`should accept antigravity permission "${permission}" in both parser and validator`, () => {
      const row = ['antigravity-task', '0 9 * * *', 'Do something', 'antigravity', 'true', permission];

      const entries = parseSchedulesSection([row]);
      expect(entries).toHaveLength(1);
      expect(entries[0].permission).toBe(permission);

      const errors = validateSchedulesSection([row]);
      expect(errors).toEqual([]);
    });
  }

  it('should reject the same invalid antigravity permission in both parser and validator', () => {
    const row = ['antigravity-task', '0 9 * * *', 'Do something', 'antigravity', 'true', 'invalid-perm'];

    const entries = parseSchedulesSection([row]);
    expect(entries).toHaveLength(1);
    expect(entries[0].permission).not.toBe('invalid-perm');

    const errors = validateSchedulesSection([row]);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('permission');
  });
  /**
   * Issue #1914: `opencode` has no permission flag, and the `default:` branch of
   * both switches used to resolve to CLAUDE_PERMISSIONS.
   *
   * The consequence was not cosmetic: a CMATE.md row reading
   * `| … | opencode | true | acceptEdits |` validated clean and the parser kept
   * `acceptEdits` on the entry, so a value that only means something to
   * `claude --permission-mode` was carried on an opencode schedule.
   *
   * Non-vacuous: revert either switch's fallback to CLAUDE_PERMISSIONS and the
   * first case below fails on the parser (permission is preserved rather than
   * cleared) and the second on the validator (no error is reported).
   */
  describe('opencode has no permission flags (Issue #1914)', () => {
    for (const claudeOnly of CLAUDE_PERMISSIONS) {
      it(`parser clears claude's "${claudeOnly}" instead of keeping it for opencode`, () => {
        const row = ['oc-task', '0 9 * * *', 'Do something', 'opencode', 'true', claudeOnly];

        const entries = parseSchedulesSection([row]);
        expect(entries).toHaveLength(1);
        expect(entries[0].cliToolId).toBe('opencode');
        expect(entries[0].permission).toBe('');
      });

      it(`validator rejects claude's "${claudeOnly}" for opencode`, () => {
        const row = ['oc-task', '0 9 * * *', 'Do something', 'opencode', 'true', claudeOnly];

        const errors = validateSchedulesSection([row]);
        expect(errors).toHaveLength(1);
        expect(errors[0].field).toBe('permission');
        expect(errors[0].message).toContain('opencode');
      });
    }

    it('an empty Permission cell stays valid for opencode', () => {
      const row = ['oc-task', '0 9 * * *', 'Do something', 'opencode', 'true', ''];

      const entries = parseSchedulesSection([row]);
      expect(entries).toHaveLength(1);
      expect(entries[0].permission).toBe('');
      expect(validateSchedulesSection([row])).toEqual([]);
    });

    it('opencode still rejects `--model` in the CLI Tool column', () => {
      // TOOLS_WITH_MODEL_SUPPORT is copilot-only; #1914 does not widen it.
      // Pinned so the "no permission flags" change is not read as "opencode now
      // behaves like copilot".
      const row = ['oc-task', '0 9 * * *', 'Do something', 'opencode --model anthropic/claude-sonnet-4', 'true', ''];

      expect(parseSchedulesSection([row])).toHaveLength(0);
      expect(validateSchedulesSection([row]).length).toBeGreaterThan(0);
    });
  });

  /**
   * Issue #1914: claude keeps its own vocabulary — the fix moved `default:` off
   * CLAUDE_PERMISSIONS, and this is the regression that would catch moving it
   * too far (claude losing its permission set along with everyone else).
   */
  for (const permission of CLAUDE_PERMISSIONS) {
    it(`should accept claude permission "${permission}" in both parser and validator`, () => {
      const row = ['claude-task', '0 9 * * *', 'Do something', 'claude', 'true', permission];

      const entries = parseSchedulesSection([row]);
      expect(entries).toHaveLength(1);
      expect(entries[0].permission).toBe(permission);
      expect(validateSchedulesSection([row])).toEqual([]);
    });
  }
});
