/**
 * Issue #1234: service-owned state layout, redaction and the staging split.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SKILL_INSTALL_STAGING_REL_PATH,
  SKILL_STATE_DIR_MODE,
  SKILL_STATE_FILE_MODE,
  ensureSkillStateDir,
  getSkillInstallStagingRoot,
  getSkillPackageStagingRoot,
  isSkillInstallStagingPath,
  readSkillStateFile,
  redactSkillOperationText,
  writeSkillStateFile,
} from '@/lib/skills/operation-store';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cm-skill-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('service-owned state root permissions', () => {
  it('creates state directories as 0700 regardless of umask', () => {
    const dir = ensureSkillStateDir('locks', { root });
    expect(statSync(dir).mode & 0o777).toBe(SKILL_STATE_DIR_MODE);
  });

  it('writes state files as 0600', () => {
    const dir = ensureSkillStateDir('journal', { root });
    const file = join(dir, 'entry.json');
    writeSkillStateFile(file, { hello: 'world' });
    expect(statSync(file).mode & 0o777).toBe(SKILL_STATE_FILE_MODE);
    expect(readSkillStateFile<{ hello: string }>(file)).toEqual({ hello: 'world' });
  });

  it('returns null rather than throwing for a malformed state file', () => {
    const dir = ensureSkillStateDir('journal', { root });
    const file = join(dir, 'broken.json');
    writeFileSync(file, '{ not json');
    expect(readSkillStateFile(file)).toBeNull();
  });

  it('keeps package staging under the service root, never in a repository', () => {
    const staging = getSkillPackageStagingRoot({ root });
    expect(staging.startsWith(root)).toBe(true);
    expect(statSync(staging).mode & 0o777).toBe(SKILL_STATE_DIR_MODE);
  });
});

describe('install commit staging is excluded from payload surfaces', () => {
  it('places install staging inside the worktree so the commit rename stays local', () => {
    expect(getSkillInstallStagingRoot('/srv/wt')).toBe(
      '/srv/wt/.agents/skills/.commandmate-staging'
    );
  });

  it('recognises the reserved staging namespace', () => {
    expect(isSkillInstallStagingPath(SKILL_INSTALL_STAGING_REL_PATH)).toBe(true);
    expect(isSkillInstallStagingPath(`${SKILL_INSTALL_STAGING_REL_PATH}/op-1/SKILL.md`)).toBe(true);
    expect(isSkillInstallStagingPath(`./${SKILL_INSTALL_STAGING_REL_PATH}/op-1`)).toBe(true);
    expect(isSkillInstallStagingPath(`.agents\\skills\\.commandmate-staging\\op-1`)).toBe(true);
  });

  it('does not swallow real installed payload paths', () => {
    // A false positive here would hide an installed Skill from the UI entirely.
    expect(isSkillInstallStagingPath('.agents/skills/my-skill/SKILL.md')).toBe(false);
    expect(isSkillInstallStagingPath('.agents/skills')).toBe(false);
    expect(
      isSkillInstallStagingPath('.agents/skills/.commandmate-staging-lookalike/SKILL.md')
    ).toBe(false);
  });
});

describe('redaction', () => {
  it('drops signed URL query strings but keeps the origin and path', () => {
    const out = redactSkillOperationText(
      'download failed: https://objects.example.com/rel/pkg.tar.gz?X-Amz-Signature=deadbeef'
    );
    expect(out).toContain('https://objects.example.com/rel/pkg.tar.gz');
    expect(out).not.toContain('X-Amz-Signature');
    expect(out).not.toContain('deadbeef');
  });

  it('removes bearer tokens and provider token formats', () => {
    const out = redactSkillOperationText(
      'auth: Bearer abc.def.ghi ghp_0123456789abcdefghijABCDEF github_pat_0123456789abcdefghij'
    );
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('ghp_0123456789abcdefghijABCDEF');
    expect(out).not.toContain('github_pat_0123456789abcdefghij');
  });

  it('removes key=value secrets', () => {
    const out = redactSkillOperationText('token=s3cr3t api_key: another-secret');
    expect(out).not.toContain('s3cr3t');
    expect(out).not.toContain('another-secret');
  });

  it('removes machine-absolute paths', () => {
    const out = redactSkillOperationText('ENOENT at /Users/alice/.commandmate/skills/journal');
    expect(out).not.toContain('/Users/alice');
    expect(out).toContain('[path]');
  });

  it('removes Windows absolute paths', () => {
    const out = redactSkillOperationText('failed on C:\\Users\\alice\\.commandmate\\db.sqlite');
    expect(out).not.toContain('alice');
    expect(out).toContain('[path]');
  });

  it('bounds the stored length', () => {
    const out = redactSkillOperationText('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(501);
  });

  it('leaves an ordinary typed message untouched', () => {
    expect(redactSkillOperationText('artifact digest mismatch')).toBe('artifact digest mismatch');
  });
});
