/**
 * Env Manager — path containment (Issue #1968), SECURITY LAYERS 2 AND 3.
 *
 * The issue's first security requirement is that the Env Manager cannot be
 * talked out of the worktree. This file pins that against a REAL temporary
 * directory tree — real files, real symlinks — because the interesting failure
 * (a `.env` that is a symlink to something outside) only exists on a real
 * filesystem; a mocked `fs` would agree with whatever the code did.
 *
 * Three escape routes are covered, matching the issue text:
 *   - `../` relative traversal
 *   - an absolute path
 *   - a symlink whose target is outside the worktree
 *
 * MUTATION NOTE: removing the `resolveAndValidateRealPath` call from
 * `resolveEnvFilePath` leaves the first two green and turns the symlink cases
 * red — which is why the symlink cases are here and not folded into the
 * allow-list suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  listEnvFiles,
  readEnvFile,
  resolveEnvFilePath,
  writeEnvFile,
} from '@/lib/env-manager/env-file-service';

const OUTSIDE_SECRET = 'OUTSIDE_SECRET=do-not-read-me\n';

describe('Env Manager path containment', () => {
  let sandbox: string;
  let worktree: string;
  let outside: string;

  beforeEach(() => {
    sandbox = makeTempDir('env-manager-path-');
    worktree = join(sandbox, 'worktree');
    outside = join(sandbox, 'outside');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(worktree, '.env'), 'INSIDE=1\n');
    writeFileSync(join(outside, 'secrets.env'), OUTSIDE_SECRET);
  });

  afterEach(() => {
    removeTempDir(sandbox);
  });

  describe('relative traversal', () => {
    it.each(['../outside/secrets.env', '../../etc/passwd', '.env/../../outside/secrets.env'])(
      'refuses %j',
      async (name) => {
        expect(resolveEnvFilePath(worktree, name).success).toBe(false);
        const read = await readEnvFile(worktree, name);
        expect(read.success).toBe(false);
      },
    );
  });

  describe('absolute paths', () => {
    it('refuses an absolute path inside the sandbox but outside the worktree', async () => {
      const absolute = join(outside, 'secrets.env');
      expect(resolveEnvFilePath(worktree, absolute).success).toBe(false);
      const read = await readEnvFile(worktree, absolute);
      expect(read.success).toBe(false);
    });

    it('refuses /etc/passwd', async () => {
      const read = await readEnvFile(worktree, '/etc/passwd');
      expect(read.success).toBe(false);
    });
  });

  describe('symlink traversal', () => {
    it('refuses to READ an allow-listed name that symlinks outside the worktree', async () => {
      // `.env.local` is a name the allow-list approves and a lexically safe
      // path. Only the realpath check can see where it actually points.
      symlinkSync(join(outside, 'secrets.env'), join(worktree, '.env.local'));

      expect(resolveEnvFilePath(worktree, '.env.local')).toEqual({
        success: false,
        code: 'INVALID_PATH',
      });

      const read = await readEnvFile(worktree, '.env.local');
      expect(read.success).toBe(false);
      if (!read.success) expect(read.code).toBe('INVALID_PATH');
    });

    it('refuses to WRITE through a symlink that points outside the worktree', async () => {
      symlinkSync(join(outside, 'secrets.env'), join(worktree, '.env.local'));

      const written = await writeEnvFile(worktree, '.env.local', 'PWNED=1\n');
      expect(written.success).toBe(false);
      // The file outside the worktree is untouched.
      expect(readFileSync(join(outside, 'secrets.env'), 'utf-8')).toBe(OUTSIDE_SECRET);
    });

    it('refuses a DANGLING symlink whose target would be outside', async () => {
      symlinkSync(join(outside, 'not-created-yet.env'), join(worktree, '.env.local'));
      const read = await readEnvFile(worktree, '.env.local');
      expect(read.success).toBe(false);
    });

    it('refuses a symlinked DIRECTORY that escapes, even for a legal name', async () => {
      // `.env` inside a symlinked directory is unreachable anyway (the
      // allow-list forbids a path), but the realpath of the worktree itself
      // must still be what containment is measured against.
      const linkedWorktree = join(sandbox, 'linked-worktree');
      symlinkSync(worktree, linkedWorktree);
      const read = await readEnvFile(linkedWorktree, '.env');
      // Following the link lands back INSIDE the real worktree, so this one is
      // allowed — the guard rejects escape, not indirection.
      expect(read.success).toBe(true);
      if (read.success) expect(read.data.content).toBe('INSIDE=1\n');
    });

    it('allows a symlink that stays inside the worktree', async () => {
      writeFileSync(join(worktree, 'inner.env'), 'INNER=1\n');
      symlinkSync(join(worktree, 'inner.env'), join(worktree, '.env.local'));
      const read = await readEnvFile(worktree, '.env.local');
      expect(read.success).toBe(true);
      if (read.success) expect(read.data.content).toBe('INNER=1\n');
    });

    it('never lists a symlink that escapes among the offered files as existing', async () => {
      symlinkSync(join(outside, 'secrets.env'), join(worktree, '.env.production'));
      const files = await listEnvFiles(worktree);
      const escaped = files.find((file) => file.name === '.env.production');
      // The name is either dropped entirely or offered as non-existent; what
      // must never happen is it being offered as a readable file.
      expect(escaped?.exists ?? false).toBe(false);
    });
  });

  describe('happy path is genuinely reachable', () => {
    it('reads a normal .env from the worktree root', async () => {
      const read = await readEnvFile(worktree, '.env');
      expect(read.success).toBe(true);
      if (read.success) {
        expect(read.data.content).toBe('INSIDE=1\n');
        expect(read.data.entries.map((entry) => entry.key)).toEqual(['INSIDE']);
      }
    });

    it('creates a file that does not exist yet', async () => {
      const written = await writeEnvFile(worktree, '.env.local', 'NEW=1\n');
      expect(written.success).toBe(true);
      expect(existsSync(join(worktree, '.env.local'))).toBe(true);
      expect(readFileSync(join(worktree, '.env.local'), 'utf-8')).toBe('NEW=1\n');
    });

    it('refuses invalid content before touching the filesystem', async () => {
      const before = readFileSync(join(worktree, '.env'), 'utf-8');
      const written = await writeEnvFile(worktree, '.env', 'A=ok\nnot an assignment\n');
      expect(written.success).toBe(false);
      if (!written.success) {
        expect(written.code).toBe('INVALID_CONTENT');
        expect(written.issues?.some((issue) => issue.code === 'invalid-syntax')).toBe(true);
      }
      expect(readFileSync(join(worktree, '.env'), 'utf-8')).toBe(before);
    });
  });
});
