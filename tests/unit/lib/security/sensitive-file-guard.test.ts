/**
 * Sensitive-file guard — Issue #2014
 *
 * The classification itself (which EXCLUDED_PATTERNS entry is "hide only" and
 * which is "hide AND refuse to serve") is the design decision this issue asked
 * for. It is argued in the docblock of `src/lib/security/sensitive-file-guard.ts`
 * and pinned here, tier by tier, in the test names.
 */

import { describe, it, expect } from 'vitest';
import {
  SENSITIVE_PATH_PATTERNS,
  LISTING_ONLY_PATTERNS,
  isSensitivePathName,
  findSensitivePathSegment,
} from '@/lib/security/sensitive-file-guard';
import { EXCLUDED_PATTERNS, isExcludedPattern, matchesNamePattern } from '@/lib/file-tree';

describe('sensitive-file-guard (Issue #2014)', () => {
  describe('the two tiers partition EXCLUDED_PATTERNS, so no pattern is silently un-classified', () => {
    it('every deny-tier pattern is also hidden from the tree (unreadable implies unlisted)', () => {
      for (const pattern of SENSITIVE_PATH_PATTERNS) {
        expect(EXCLUDED_PATTERNS).toContain(pattern);
      }
    });

    it('every hide-only pattern is also in EXCLUDED_PATTERNS', () => {
      for (const pattern of LISTING_ONLY_PATTERNS) {
        expect(EXCLUDED_PATTERNS).toContain(pattern);
      }
    });

    it('the tiers are disjoint', () => {
      const overlap = SENSITIVE_PATH_PATTERNS.filter((p) => LISTING_ONLY_PATTERNS.includes(p));
      expect(overlap).toEqual([]);
    });

    it('the tiers cover EXCLUDED_PATTERNS exactly — a new excluded pattern fails here until classified', () => {
      const classified = [...SENSITIVE_PATH_PATTERNS, ...LISTING_ONLY_PATTERNS].sort();
      expect(classified).toEqual([...EXCLUDED_PATTERNS].sort());
    });

    it('records the measured contents of EXCLUDED_PATTERNS this classification was made against', () => {
      // develop @6696c4bb, 2026-08-24. Kept as a literal so that a future edit
      // to the list is visible in this test's diff, not just in its result.
      expect([...EXCLUDED_PATTERNS].sort()).toEqual(
        [
          '.git',
          '.env',
          '.env.*',
          'node_modules',
          '.DS_Store',
          'Thumbs.db',
          '*.pem',
          '*.key',
          '.env.local',
          '.env.development',
          '.env.production',
          '.env.test',
        ].sort(),
      );
    });
  });

  describe('deny tier: files whose PURPOSE is to hold credentials', () => {
    it.each([
      ['.env', 'the canonical secret file; Issue #1968 built a masked UI for it'],
      ['.env.local', 'developer overrides, same secrecy'],
      ['.env.production', 'production credentials'],
      ['.env.development', 'development credentials'],
      ['.env.test', 'test credentials'],
      ['.env.example', 'matches .env.* — hidden from the tree anyway, so nothing regresses'],
      ['server.pem', 'private key material (*.pem)'],
      ['private.key', 'private key material (*.key)'],
      ['.git', 'its config carries the remote URL, which routinely embeds a token'],
    ])('%s is refused (%s)', (name) => {
      expect(isSensitivePathName(name)).toBe(true);
    });

    it('matches case-insensitively, because .ENV opens .env on macOS/Windows filesystems', () => {
      // Measured on this repo's APFS: readFileSync('.ENV') returned the bytes of
      // `.env`. A case-sensitive deny list is bypassable by one shifted char.
      expect(isSensitivePathName('.ENV')).toBe(true);
      expect(isSensitivePathName('.Env.Production')).toBe(true);
      expect(isSensitivePathName('SERVER.PEM')).toBe(true);
      expect(isSensitivePathName('.GIT')).toBe(true);
    });

    it('matches a percent-encoded segment, in case one reaches the route undecoded', () => {
      expect(isSensitivePathName('%2Eenv')).toBe(true);
    });
  });

  describe('hide-only tier: excluded for volume/noise, NOT for secrecy — reads stay allowed', () => {
    it.each([
      ['node_modules', 'dependency sources; denying reads removes a capability and buys no confidentiality'],
      ['.DS_Store', 'macOS Finder metadata'],
      ['Thumbs.db', 'Windows thumbnail cache'],
    ])('%s is NOT refused (%s)', (name) => {
      expect(isSensitivePathName(name)).toBe(false);
      // ...but it is still hidden from the tree, which is the whole point of
      // there being two tiers rather than one list.
      expect(isExcludedPattern(name)).toBe(true);
    });
  });

  describe('ordinary files are untouched', () => {
    it.each([
      'README.md',
      'package.json',
      'index.ts',
      'envelope.md',
      'keyboard.ts',
      'monkey.md',
      '.environment',
      'env',
      'src',
    ])('%s is neither refused nor hidden', (name) => {
      expect(isSensitivePathName(name)).toBe(false);
      expect(isExcludedPattern(name)).toBe(false);
    });
  });

  describe('findSensitivePathSegment checks every component, not just the basename', () => {
    it('catches a deny-tier directory anywhere in the path', () => {
      expect(findSensitivePathSegment(['.git', 'config'])).toBe('.git');
      expect(findSensitivePathSegment('.git/config')).toBe('.git');
      expect(findSensitivePathSegment('a/b/.env')).toBe('.env');
    });

    it('ignores traversal and empty components so `.` / `..` cannot be mistaken for names', () => {
      expect(findSensitivePathSegment(['a', '..', 'README.md'])).toBeNull();
      expect(findSensitivePathSegment('')).toBeNull();
      expect(findSensitivePathSegment('docs//guide.md')).toBeNull();
    });

    it('returns null for an ordinary nested path', () => {
      expect(findSensitivePathSegment('src/lib/file-tree.ts')).toBeNull();
      expect(findSensitivePathSegment(['node_modules', 'pkg', 'package.json'])).toBeNull();
    });
  });

  describe('the deny matcher reuses the tree matcher, so the two subsets cannot drift', () => {
    it('matchesNamePattern still implements exact / *.ext / prefix.* as the tree filter expects', () => {
      expect(matchesNamePattern('.env', '.env')).toBe(true);
      expect(matchesNamePattern('server.pem', '*.pem')).toBe(true);
      expect(matchesNamePattern('.env.local', '.env.*')).toBe(true);
      expect(matchesNamePattern('.environment', '.env.*')).toBe(false);
      expect(matchesNamePattern('README.md', '*.pem')).toBe(false);
    });
  });
});
