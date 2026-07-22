/**
 * Tests for src/lib/skills/semver.ts
 * Issue #1228: SemVer 2.0 handling for the Skills distribution contract
 */

import { describe, it, expect } from 'vitest';
import {
  compareSemVer,
  isValidSemVer,
  isValidSkillVersionRange,
  parseSemVer,
  parseSkillVersionRange,
  satisfiesSkillVersionRange,
} from '@/lib/skills/semver';

describe('parseSemVer', () => {
  it('parses a release version', () => {
    expect(parseSemVer('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
      build: [],
    });
  });

  it('parses prerelease and build metadata', () => {
    expect(parseSemVer('1.0.0-rc.1+build.5')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['rc', '1'],
      build: ['build', '5'],
    });
  });

  it.each([
    ['v1.2.3', 'a "v" prefix is not SemVer 2.0'],
    ['1.2', 'a two-component version is incomplete'],
    ['1.2.3.4', 'a four-component version is not SemVer'],
    ['01.2.3', 'leading zeroes are not allowed'],
    ['1.2.3-', 'an empty prerelease is not allowed'],
    ['', 'an empty string is not a version'],
    ['1.2.3 ', 'trailing whitespace is not tolerated'],
  ])('rejects %s (%s)', (input) => {
    expect(parseSemVer(input)).toBeNull();
    expect(isValidSemVer(input)).toBe(false);
  });

  it('rejects an over-long version string before running the pattern', () => {
    expect(parseSemVer(`1.2.3-${'a'.repeat(200)}`)).toBeNull();
  });
});

describe('compareSemVer', () => {
  it.each([
    ['1.0.0', '2.0.0', -1],
    ['2.0.0', '2.1.0', -1],
    ['2.1.0', '2.1.1', -1],
    ['1.0.0', '1.0.0', 0],
    ['2.0.0', '1.9.9', 1],
  ])('orders %s against %s', (a, b, expected) => {
    expect(compareSemVer(a, b)).toBe(expected);
  });

  it('ranks a prerelease below its release', () => {
    expect(compareSemVer('1.0.0-alpha', '1.0.0')).toBe(-1);
  });

  it('applies SemVer 2.0 prerelease precedence', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareSemVer(ordered[i - 1], ordered[i])).toBe(-1);
    }
  });

  it('ignores build metadata for precedence', () => {
    expect(compareSemVer('1.0.0+a', '1.0.0+b')).toBe(0);
  });

  it('returns null when either side is invalid', () => {
    expect(compareSemVer('v1.0.0', '1.0.0')).toBeNull();
  });
});

describe('parseSkillVersionRange', () => {
  it('desugars a caret range into a bounded pair', () => {
    expect(parseSkillVersionRange('^1.2.3')).toEqual([
      { operator: '>=', version: expect.objectContaining({ major: 1, minor: 2, patch: 3 }) },
      { operator: '<', version: expect.objectContaining({ major: 2, minor: 0, patch: 0 }) },
    ]);
  });

  it('treats a leading-zero caret range as a minor-locked range', () => {
    expect(parseSkillVersionRange('^0.2.3')).toEqual([
      { operator: '>=', version: expect.objectContaining({ major: 0, minor: 2, patch: 3 }) },
      { operator: '<', version: expect.objectContaining({ major: 0, minor: 3, patch: 0 }) },
    ]);
  });

  it.each([
    ['^1.0.0 || ^2.0.0', 'alternation has no single reading'],
    ['*', 'wildcards are not supported'],
    ['1.x', 'x-ranges are not supported'],
    ['>=1.0.0 - <2.0.0', 'hyphen ranges are not supported'],
    ['', 'an empty range is not a range'],
  ])('rejects %s (%s)', (range) => {
    expect(parseSkillVersionRange(range)).toBeNull();
    expect(isValidSkillVersionRange(range)).toBe(false);
  });
});

describe('satisfiesSkillVersionRange', () => {
  it.each([
    ['0.11.4', '>=0.11.0 <1.0.0', true],
    ['1.0.0', '>=0.11.0 <1.0.0', false],
    ['0.10.9', '>=0.11.0 <1.0.0', false],
    ['1.2.9', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
  ])('%s against %s', (version, range, expected) => {
    expect(satisfiesSkillVersionRange(version, range)).toBe(expected);
  });

  it('does not let a prerelease slip into an unrelated range', () => {
    expect(satisfiesSkillVersionRange('2.0.0-alpha.1', '>=1.0.0')).toBe(false);
  });

  it('admits a prerelease only when a comparator names the same tuple', () => {
    expect(satisfiesSkillVersionRange('2.0.0-alpha.2', '>=2.0.0-alpha.1 <3.0.0')).toBe(true);
    expect(satisfiesSkillVersionRange('2.0.0-alpha.0', '>=2.0.0-alpha.1 <3.0.0')).toBe(false);
  });

  it('fails closed on an unparsable range', () => {
    expect(satisfiesSkillVersionRange('1.0.0', 'not-a-range')).toBe(false);
  });
});
