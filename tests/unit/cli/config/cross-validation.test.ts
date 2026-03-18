/**
 * Cross-Validation Tests: CLI vs Server type/constant consistency
 * Issue #518: [IA3-03] [IA3-04] Ensure CLI-side definitions match server-side
 */

import { describe, it, expect } from 'vitest';
import { DURATION_MAP, parseDurationToMs } from '../../../../src/cli/config/duration-constants';
import { CLI_TOOL_IDS } from '../../../../src/cli/config/cli-tool-ids';

// Import server-side sources of truth
import { ALLOWED_DURATIONS as SERVER_ALLOWED_DURATIONS } from '../../../../src/config/auto-yes-config';
import { CLI_TOOL_IDS as SERVER_CLI_TOOL_IDS } from '../../../../src/lib/cli-tools/types';

describe('[IA3-04] Duration constants cross-validation', () => {
  it('CLI DURATION_MAP values match server ALLOWED_DURATIONS', () => {
    const cliDurationValues = Object.values(DURATION_MAP).sort();
    const serverDurationValues = [...SERVER_ALLOWED_DURATIONS].sort();
    expect(cliDurationValues).toEqual(serverDurationValues);
  });

  it('parseDurationToMs output values are all in server ALLOWED_DURATIONS', () => {
    for (const key of Object.keys(DURATION_MAP)) {
      const ms = parseDurationToMs(key);
      expect(ms).not.toBeNull();
      expect((SERVER_ALLOWED_DURATIONS as readonly number[]).includes(ms!)).toBe(true);
    }
  });

  it('every server ALLOWED_DURATION has a CLI mapping', () => {
    const cliValues = new Set(Object.values(DURATION_MAP));
    for (const serverDuration of SERVER_ALLOWED_DURATIONS) {
      expect(cliValues.has(serverDuration)).toBe(true);
    }
  });
});

describe('[DR2-07] CLI_TOOL_IDS cross-validation', () => {
  it('CLI CLI_TOOL_IDS matches server CLI_TOOL_IDS', () => {
    expect([...CLI_TOOL_IDS].sort()).toEqual([...SERVER_CLI_TOOL_IDS].sort());
  });

  it('CLI CLI_TOOL_IDS has same length as server', () => {
    expect(CLI_TOOL_IDS.length).toBe(SERVER_CLI_TOOL_IDS.length);
  });
});
