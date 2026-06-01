/**
 * Unit tests for External Apps configuration constants.
 * Issue #760: Validates that the consolidated polling interval matches the
 * original hardcoded literal (behavior-preserving refactor).
 */

import { describe, it, expect } from 'vitest';
import { EXTERNAL_APPS_POLL_INTERVAL_MS } from '@/config/external-apps-config';

describe('external-apps-config', () => {
  it('EXTERNAL_APPS_POLL_INTERVAL_MS should be 60000 (60 seconds)', () => {
    expect(EXTERNAL_APPS_POLL_INTERVAL_MS).toBe(60000);
  });

  it('EXTERNAL_APPS_POLL_INTERVAL_MS should be a positive number', () => {
    expect(typeof EXTERNAL_APPS_POLL_INTERVAL_MS).toBe('number');
    expect(EXTERNAL_APPS_POLL_INTERVAL_MS).toBeGreaterThan(0);
  });
});
