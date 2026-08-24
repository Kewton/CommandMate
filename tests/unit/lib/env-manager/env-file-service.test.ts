/**
 * Env Manager — file listing and template suggestions (Issue #1968).
 *
 * Covers the ".env.example / .env.sample があれば、未定義キーの補完サジェストが
 * 出る" acceptance criterion at the layer that computes it, against a real
 * temporary worktree.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  collectKeySuggestions,
  listEnvFiles,
  readEnvFile,
  writeEnvFile,
} from '@/lib/env-manager/env-file-service';

describe('Env Manager file service', () => {
  let sandbox: string;
  let worktree: string;

  beforeEach(() => {
    sandbox = makeTempDir('env-manager-service-');
    worktree = join(sandbox, 'worktree');
    mkdirSync(worktree, { recursive: true });
  });

  afterEach(() => {
    removeTempDir(sandbox);
  });

  describe('listEnvFiles', () => {
    it('always offers .env and .env.local even in an empty worktree', async () => {
      const files = await listEnvFiles(worktree);
      expect(files.map((file) => file.name)).toEqual(['.env', '.env.local']);
      expect(files.every((file) => file.exists === false)).toBe(true);
    });

    it('reports files that do exist with size and mtime', async () => {
      writeFileSync(join(worktree, '.env'), 'A=1\n');
      const files = await listEnvFiles(worktree);
      const dotEnv = files.find((file) => file.name === '.env');
      expect(dotEnv).toMatchObject({ exists: true, size: 4, isExample: false });
      expect(dotEnv?.mtime).toBe(statSync(join(worktree, '.env')).mtime.toISOString());
    });

    it('picks up allow-listed variants found on disk and flags templates', async () => {
      writeFileSync(join(worktree, '.env.production'), 'A=1\n');
      writeFileSync(join(worktree, '.env.example'), 'A=\n');
      const files = await listEnvFiles(worktree);
      expect(files.map((file) => file.name)).toEqual([
        '.env',
        '.env.local',
        '.env.production',
        '.env.example',
      ]);
      expect(files.find((file) => file.name === '.env.example')?.isExample).toBe(true);
    });

    it('ignores files that are not env files, and never recurses', async () => {
      writeFileSync(join(worktree, '.envrc'), 'export A=1\n');
      writeFileSync(join(worktree, 'package.json'), '{}');
      mkdirSync(join(worktree, 'nested'));
      writeFileSync(join(worktree, 'nested', '.env'), 'NESTED=1\n');

      const files = await listEnvFiles(worktree);
      expect(files.map((file) => file.name)).toEqual(['.env', '.env.local']);
    });

    it('does not list a directory that happens to be named .env.local', async () => {
      mkdirSync(join(worktree, '.env.local'));
      const files = await listEnvFiles(worktree);
      expect(files.find((file) => file.name === '.env.local')?.exists).toBe(false);
    });

    it('fails closed on a worktree root that does not exist', async () => {
      // Path validation cannot resolve the realpath of a missing root, so every
      // candidate is refused and the list comes back empty rather than
      // pretending files are available under an unverified root.
      const files = await listEnvFiles(join(sandbox, 'does-not-exist'));
      expect(files).toEqual([]);
    });
  });

  describe('collectKeySuggestions', () => {
    it('suggests template keys that are not defined yet', async () => {
      writeFileSync(join(worktree, '.env.example'), 'API_KEY=your-key\nDB_URL=postgres://\n');
      const suggestions = await collectKeySuggestions(worktree, new Set(['DB_URL']), '.env');
      expect(suggestions).toEqual([
        { key: 'API_KEY', source: '.env.example', value: 'your-key' },
      ]);
    });

    it('merges both template files, first definition winning', async () => {
      writeFileSync(join(worktree, '.env.example'), 'A=from-example\n');
      writeFileSync(join(worktree, '.env.sample'), 'A=from-sample\nB=only-in-sample\n');
      const suggestions = await collectKeySuggestions(worktree, new Set(), '.env');
      expect(suggestions).toEqual([
        { key: 'A', source: '.env.example', value: 'from-example' },
        { key: 'B', source: '.env.sample', value: 'only-in-sample' },
      ]);
    });

    it('returns nothing when no template exists', async () => {
      expect(await collectKeySuggestions(worktree, new Set(), '.env')).toEqual([]);
    });

    it('does not suggest a template file its own keys', async () => {
      writeFileSync(join(worktree, '.env.example'), 'A=1\n');
      expect(await collectKeySuggestions(worktree, new Set(), '.env.example')).toEqual([]);
    });
  });

  describe('readEnvFile', () => {
    it('reports a missing file as exists:false rather than an error', async () => {
      const result = await readEnvFile(worktree, '.env');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toMatchObject({ name: '.env', exists: false, content: '' });
      }
    });

    it('carries the suggestions alongside the content', async () => {
      writeFileSync(join(worktree, '.env'), 'DEFINED=1\n');
      writeFileSync(join(worktree, '.env.example'), 'DEFINED=\nMISSING=\n');
      const result = await readEnvFile(worktree, '.env');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.suggestions.map((s) => s.key)).toEqual(['MISSING']);
      }
    });

    it('surfaces validation issues without refusing the read', async () => {
      writeFileSync(join(worktree, '.env'), 'GOOD=1\nnot-an-assignment\n');
      const result = await readEnvFile(worktree, '.env');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.issues.some((issue) => issue.code === 'invalid-syntax')).toBe(true);
        expect(result.data.entries.map((entry) => entry.key)).toEqual(['GOOD']);
      }
    });
  });

  describe('writeEnvFile', () => {
    it('creates the file private to the owner', async () => {
      const result = await writeEnvFile(worktree, '.env', 'A=1\n');
      expect(result.success).toBe(true);
      // 0o600 — an env file holds credentials.
      expect(statSync(join(worktree, '.env')).mode & 0o777).toBe(0o600);
    });

    it('returns warnings with an accepted save', async () => {
      const result = await writeEnvFile(worktree, '.env', 'A=1\nA=2\n');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.issues).toEqual([
          { line: 2, code: 'duplicate-key', severity: 'warning', key: 'A' },
        ]);
      }
    });

    it('refuses a non-string body', async () => {
      const result = await writeEnvFile(worktree, '.env', { nope: true });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.code).toBe('INVALID_CONTENT');
    });

    it('refuses to write over a directory', async () => {
      mkdirSync(join(worktree, '.env.local'));
      const result = await writeEnvFile(worktree, '.env.local', 'A=1\n');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.code).toBe('NOT_A_FILE');
    });
  });
});
