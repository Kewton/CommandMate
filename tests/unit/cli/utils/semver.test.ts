/**
 * Semver Utility Tests
 * Issue #1194: Shared 3-way version comparison (D-14 / S3-005)
 */

import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  isComparableVersion,
} from '../../../../src/cli/utils/semver';

describe('compareVersions', () => {
  it('should return 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('should return 1 when a is greater (major)', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  });

  it('should return 1 when a is greater (minor)', () => {
    expect(compareVersions('1.3.0', '1.2.9')).toBe(1);
  });

  it('should return 1 when a is greater (patch)', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
  });

  it('should return -1 when a is smaller (major)', () => {
    expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
  });

  it('should return -1 when a is smaller (minor)', () => {
    expect(compareVersions('1.2.9', '1.3.0')).toBe(-1);
  });

  it('should return -1 when a is smaller (patch)', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
  });

  it('should treat missing parts as 0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBe(1);
  });

  it('should tolerate a leading v prefix', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('v2.0.0', 'v1.0.0')).toBe(1);
  });

  it('should only ever return -1, 0 or 1', () => {
    const results = [
      compareVersions('10.0.0', '1.0.0'),
      compareVersions('1.0.0', '10.0.0'),
      compareVersions('1.0.0', '1.0.0'),
    ];
    expect(results).toEqual([1, -1, 0]);
  });

  it('should compare numerically, not lexicographically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
  });
});

describe('isComparableVersion', () => {
  it('should accept plain release versions', () => {
    expect(isComparableVersion('1.2.3')).toBe(true);
    expect(isComparableVersion('0.0.0')).toBe(true);
    expect(isComparableVersion('10.20.30')).toBe(true);
  });

  it('should accept a leading v prefix', () => {
    expect(isComparableVersion('v1.2.3')).toBe(true);
  });

  it('should reject prerelease versions (D-3 / S3-005)', () => {
    expect(isComparableVersion('0.9.0-rc.1')).toBe(false);
    expect(isComparableVersion('1.0.0-beta')).toBe(false);
    expect(isComparableVersion('1.0.0-alpha.1+build.5')).toBe(false);
  });

  it('should reject incomplete or non-numeric versions', () => {
    expect(isComparableVersion('1.2')).toBe(false);
    expect(isComparableVersion('abc')).toBe(false);
    expect(isComparableVersion('')).toBe(false);
  });
});
