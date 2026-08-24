/**
 * Env Manager — file-name allow-list (Issue #1968).
 *
 * This is SECURITY LAYER 1 of 3 (the other two are `isPathSafe` and
 * `resolveAndValidateRealPath`, exercised in `env-path-safety.test.ts`).
 *
 * The property being pinned is not "these names are nice" — it is that an
 * accepted name can only ever be ONE path component, so `path.join(root, name)`
 * cannot leave the worktree no matter what the client sends.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ENV_FILE_NAME,
  ENV_EXAMPLE_FILE_NAMES,
  MAX_ENV_FILE_NAME_LENGTH,
  compareEnvFileNames,
  isAllowedEnvFileName,
  isEnvExampleFileName,
} from '@/lib/env-manager/env-file-allowlist';

describe('isAllowedEnvFileName', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
    '.env.test',
    '.env.example',
    '.env.sample',
    '.env.development.local',
    '.env.production.local',
    '.env.staging-1',
    '.env.my_env',
  ])('accepts %s', (name) => {
    expect(isAllowedEnvFileName(name)).toBe(true);
  });

  describe('path traversal', () => {
    it.each([
      '../.env',
      '../../.env',
      '.env/../../../etc/passwd',
      'sub/.env',
      'sub\\.env',
      '/etc/passwd',
      '/.env',
      './.env',
      '..',
      '.',
    ])('rejects %j', (name) => {
      expect(isAllowedEnvFileName(name)).toBe(false);
    });

    it('rejects a URL-encoded traversal', () => {
      expect(isAllowedEnvFileName('..%2F.env')).toBe(false);
      expect(isAllowedEnvFileName('%2e%2e%2f.env')).toBe(false);
    });

    it('rejects a NUL-byte truncation attempt', () => {
      expect(isAllowedEnvFileName('.env\x00.png')).toBe(false);
    });
  });

  describe('names that merely look like env files', () => {
    it.each([
      '.envrc',
      '.environment',
      'env',
      '.eng',
      '.gitignore',
      'package.json',
      '.env.',
      '.env..local',
      '.env.a.b',
      '.ENV',
      '.Env.local',
    ])('rejects %j', (name) => {
      expect(isAllowedEnvFileName(name)).toBe(false);
    });

    it('rejects a third segment that is not `local`', () => {
      expect(isAllowedEnvFileName('.env.development.local')).toBe(true);
      expect(isAllowedEnvFileName('.env.development.remote')).toBe(false);
    });
  });

  describe('shape', () => {
    it('rejects a non-string', () => {
      expect(isAllowedEnvFileName(undefined)).toBe(false);
      expect(isAllowedEnvFileName(null)).toBe(false);
      expect(isAllowedEnvFileName(42)).toBe(false);
      expect(isAllowedEnvFileName(['.env'])).toBe(false);
      expect(isAllowedEnvFileName({ toString: () => '.env' })).toBe(false);
    });

    it('rejects the empty string', () => {
      expect(isAllowedEnvFileName('')).toBe(false);
    });

    it('rejects a name longer than the cap', () => {
      const long = `.env.${'a'.repeat(MAX_ENV_FILE_NAME_LENGTH)}`;
      expect(long.length).toBeGreaterThan(MAX_ENV_FILE_NAME_LENGTH);
      expect(isAllowedEnvFileName(long)).toBe(false);
    });

    it('rejects a segment longer than 32 characters', () => {
      expect(isAllowedEnvFileName(`.env.${'a'.repeat(32)}`)).toBe(true);
      expect(isAllowedEnvFileName(`.env.${'a'.repeat(33)}`)).toBe(false);
    });

    it('every accepted name is a single path component', () => {
      const candidates = [
        '.env',
        '.env.local',
        '.env.development.local',
        '../.env',
        'a/.env',
        '/etc/passwd',
      ];
      for (const name of candidates) {
        if (!isAllowedEnvFileName(name)) continue;
        expect(name).not.toContain('/');
        expect(name).not.toContain('\\');
        expect(name.split('/').length).toBe(1);
      }
    });
  });
});

describe('isEnvExampleFileName', () => {
  it('recognises the template names', () => {
    for (const name of ENV_EXAMPLE_FILE_NAMES) {
      expect(isEnvExampleFileName(name)).toBe(true);
    }
  });

  it('does not treat a real env file as a template', () => {
    expect(isEnvExampleFileName(DEFAULT_ENV_FILE_NAME)).toBe(false);
    expect(isEnvExampleFileName('.env.local')).toBe(false);
  });
});

describe('compareEnvFileNames', () => {
  it('puts .env first and templates last', () => {
    const sorted = ['.env.sample', '.env.local', '.env', '.env.production', '.env.example'].sort(
      compareEnvFileNames,
    );
    expect(sorted).toEqual([
      '.env',
      '.env.local',
      '.env.production',
      '.env.example',
      '.env.sample',
    ]);
  });
});
