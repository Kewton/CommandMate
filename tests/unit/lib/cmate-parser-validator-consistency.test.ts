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
import { COPILOT_PERMISSIONS } from '@/config/schedule-config';

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
});
