/**
 * Process Inspector Tests
 * Issue #1358: process-identity signature used to detect PID reuse
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';

vi.mock('child_process');

import { getProcessStartTime } from '../../../../src/cli/utils/process-inspector';

describe('getProcessStartTime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return the trimmed ps start-time output', () => {
    vi.mocked(childProcess.execFileSync).mockReturnValue(
      '  Sat Jul 18 01:03:24 2026\n' as unknown as string
    );

    expect(getProcessStartTime(12345)).toBe('Sat Jul 18 01:03:24 2026');
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      'ps',
      ['-o', 'lstart=', '-p', '12345'],
      expect.any(Object)
    );
  });

  it('should return null when ps produces no output', () => {
    vi.mocked(childProcess.execFileSync).mockReturnValue('   \n' as unknown as string);

    expect(getProcessStartTime(12345)).toBeNull();
  });

  it('should return null when ps fails (unknown PID / no ps binary)', () => {
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error('No such process');
    });

    expect(getProcessStartTime(999999999)).toBeNull();
  });
});
