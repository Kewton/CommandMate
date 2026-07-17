/**
 * Package Info Tests
 * Issue #1354: read the installed version for the daemon state file and status version check
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

vi.mock('fs');
vi.mock('../../../../src/cli/utils/paths', () => ({
  getPackageJsonPath: () => '/mock/package.json',
}));

import { readPackageVersion } from '../../../../src/cli/utils/package-info';

describe('readPackageVersion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return the version from package.json', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ name: 'commandmate', version: '1.2.3' })
    );

    expect(readPackageVersion()).toBe('1.2.3');
  });

  it('should return undefined when the version field is missing', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ name: 'commandmate' }));

    expect(readPackageVersion()).toBeUndefined();
  });

  it('should return undefined when package.json cannot be read', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(readPackageVersion()).toBeUndefined();
  });

  it('should return undefined for invalid JSON', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('not json');

    expect(readPackageVersion()).toBeUndefined();
  });
});
