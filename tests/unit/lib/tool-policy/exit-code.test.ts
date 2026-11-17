/**
 * Issue #4436 L0: ToolPolicyExitCode.DENIED is 33 and no other CLI exit code uses 33.
 */
import { describe, expect, it } from 'vitest';
import * as cliTypes from '../../../../src/cli/types';

describe('ToolPolicyExitCode (#4436)', () => {
  it('DENIED is 33', () => {
    expect(cliTypes.ToolPolicyExitCode.DENIED).toBe(33);
  });

  it('33 is not used by any other exit-code namespace in src/cli/types', () => {
    const others: Array<[string, number]> = [];
    for (const [name, value] of Object.entries(cliTypes)) {
      if (!/ExitCode$/.test(name) || name === 'ToolPolicyExitCode') continue;
      if (value === null || typeof value !== 'object') continue;
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'number') others.push([`${name}.${key}`, v]);
      }
    }
    // control: the scan sees the namespaces it is meant to check
    expect(others.map(([k]) => k)).toEqual(
      expect.arrayContaining(['ExitCode.CONFIG_ERROR', 'RoleExitCode.NOT_SENT', 'InterruptExitCode.NO_ACTIVE_SESSIONS']),
    );
    expect(others.filter(([, v]) => v === 33)).toEqual([]);
  });
});
