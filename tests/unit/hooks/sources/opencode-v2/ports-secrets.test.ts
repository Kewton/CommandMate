/**
 * OpenCode V2's port range, password files and launch line
 * (Issue #2934, decisions D3 / D4).
 *
 * Everything on disk goes to a sandbox through `CM_OPENCODE_V2_DIR`, so the
 * user's `~/.commandmate` is never read or written.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { OPENCODE_PORT_RANGE } from '@/lib/hooks/sources/opencode/ports';
import {
  OPENCODE_V2_PORT_RANGE,
  allocateOpencodeV2Port,
  forgetOpencodeV2Port,
  getAssignedOpencodeV2Port,
  opencodeV2PortCandidates,
  readPersistedOpencodeV2Ports,
  recoverOpencodeV2Port,
  resetOpencodeV2PortAssignments,
} from '@/lib/hooks/sources/opencode-v2/ports';
import {
  OPENCODE_V2_DIR_ENV,
  generateOpencodeV2Password,
  getOpencodeV2PasswordFilePath,
  listOpencodeV2PasswordKeys,
  opencodeV2FileStem,
  opencodeV2KeyOfFileStem,
  readOpencodeV2Password,
  removeOpencodeV2Password,
  writeOpencodeV2Password,
} from '@/lib/hooks/sources/opencode-v2/secrets';
import {
  prepareOpencodeV2Launch,
  resolveOpencodeV2LaunchScriptPath,
} from '@/lib/hooks/sources/opencode-v2/source';
import { renderAgentLaunchCommand, resolveAgentLaunchEnv } from '@/lib/hooks/sources/launch-command';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

let dir: string;
const target: AgentInstanceRef = {
  worktreeId: 'wt-2934',
  cliToolId: 'opencode-v2',
  instanceId: 'opencode-v2',
};
const alias: AgentInstanceRef = {
  worktreeId: 'wt-2934',
  cliToolId: 'opencode-v2',
  instanceId: 'opencode-v2-2',
};

beforeEach(() => {
  dir = join(makeTempDir('cm-2934-state-'), 'opencode-v2');
  vi.stubEnv(OPENCODE_V2_DIR_ENV, dir);
  resetOpencodeV2PortAssignments();
});

afterEach(() => {
  resetOpencodeV2PortAssignments();
  vi.unstubAllEnvs();
  removeTempDir(join(dir, '..'));
});

describe('D4: the port range', () => {
  it('does not overlap v1’s', () => {
    expect(OPENCODE_V2_PORT_RANGE.min).toBeGreaterThan(OPENCODE_PORT_RANGE.max);
    expect(OPENCODE_PORT_RANGE).toEqual({ min: 4200, max: 4299 });
    expect(OPENCODE_V2_PORT_RANGE).toEqual({ min: 4300, max: 4399 });
  });

  it('offers every port of its own range, and only those', () => {
    const candidates = opencodeV2PortCandidates(target);
    expect(candidates).toHaveLength(100);
    expect(new Set(candidates).size).toBe(100);
    for (const port of candidates) {
      expect(port).toBeGreaterThanOrEqual(OPENCODE_V2_PORT_RANGE.min);
      expect(port).toBeLessThanOrEqual(OPENCODE_V2_PORT_RANGE.max);
    }
  });

  it('allocates the first free candidate and persists it (0600)', async () => {
    const taken = new Set(opencodeV2PortCandidates(target).slice(0, 2));
    const port = await allocateOpencodeV2Port(target, '/wt', async (p) => !taken.has(p));

    expect(port).toBe(opencodeV2PortCandidates(target)[2]);
    expect(getAssignedOpencodeV2Port(target)).toBe(port);
    expect(readPersistedOpencodeV2Ports()['wt-2934:opencode-v2']).toMatchObject({
      port,
      worktreePath: '/wt',
    });
    expect(statSync(join(dir, 'ports.json')).mode & 0o777).toBe(0o600);
  });

  it('answers null when the whole range is taken', async () => {
    expect(await allocateOpencodeV2Port(target, '/wt', async () => false)).toBeNull();
  });

  it('forgets an assignment in memory and on disk', async () => {
    await allocateOpencodeV2Port(target, '/wt', async () => true);
    forgetOpencodeV2Port(target);
    expect(getAssignedOpencodeV2Port(target)).toBeNull();
    expect(readPersistedOpencodeV2Ports()).toEqual({});
  });

  it('recovers a persisted port only for the same path and a verified server', async () => {
    const port = await allocateOpencodeV2Port(target, '/wt', async () => true);
    resetOpencodeV2PortAssignments(); // a CommandMate restart

    expect(await recoverOpencodeV2Port(target, '/elsewhere', async () => true)).toBeNull();
    expect(await recoverOpencodeV2Port(target, '/wt', async () => false)).toBeNull();
    expect(await recoverOpencodeV2Port(target, '/wt', async () => true)).toBe(port);
    expect(getAssignedOpencodeV2Port(target)).toBe(port);
  });

  it('ignores a persisted entry outside its range (e.g. a v1 port)', () => {
    writeFileSync(
      join(makeStateDir(), 'ports.json'),
      JSON.stringify({ 'wt-2934:opencode-v2': { port: 4242, worktreePath: '/wt', updatedAt: 1 } })
    );
    expect(readPersistedOpencodeV2Ports()).toEqual({});
  });
});

function makeStateDir(): string {
  writeOpencodeV2Password(target);
  return dir;
}

describe('D3: the password file', () => {
  it('generates at least 32 bytes, URL-safe, fresh every time', () => {
    const a = generateOpencodeV2Password();
    const b = generateOpencodeV2Password();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(Buffer.from(a, 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(b);
  });

  it('writes `<dir>/<composite key>.pw`, file 0600 in a 0700 directory', () => {
    const path = writeOpencodeV2Password(target);
    expect(path).toBe(join(dir, 'wt-2934:opencode-v2.pw'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readOpencodeV2Password(target)).toBe(readFileSync(path, 'utf8').trim());
  });

  it('replaces the value on every launch', () => {
    writeOpencodeV2Password(target);
    const first = readOpencodeV2Password(target);
    writeOpencodeV2Password(target);
    expect(readOpencodeV2Password(target)).not.toBe(first);
  });

  it('keeps instances apart and lists them by key', () => {
    writeOpencodeV2Password(target);
    writeOpencodeV2Password(alias);
    expect(listOpencodeV2PasswordKeys().sort()).toEqual([
      'wt-2934:opencode-v2',
      'wt-2934:opencode-v2:opencode-v2-2',
    ]);
    removeOpencodeV2Password(target);
    expect(existsSync(getOpencodeV2PasswordFilePath(target))).toBe(false);
    expect(readOpencodeV2Password(alias)).not.toBeNull();
  });

  it('cannot be steered out of the directory by a key', () => {
    const stem = opencodeV2FileStem('../x/..:opencode-v2');
    expect(stem).not.toContain('/');
    expect(stem).not.toContain('..');
    expect(opencodeV2KeyOfFileStem(stem)).toBe('../x/..:opencode-v2');
  });
});

describe('D3: the launch line carries a path, never the password', () => {
  it('runs the wrapper with --port / --password-file / --directory and an empty env', async () => {
    const port = await allocateOpencodeV2Port(target, '/wt 2934', async () => true);
    const passwordFile = writeOpencodeV2Password(target);
    const password = readOpencodeV2Password(target) as string;

    const plan = prepareOpencodeV2Launch({
      target,
      executablePath: 'opencode2',
      worktreePath: '/wt 2934',
    });

    expect(resolveOpencodeV2LaunchScriptPath()).not.toBeNull();
    expect(plan.env).toEqual({});
    expect(plan.command).toBe(
      `bash '${resolveOpencodeV2LaunchScriptPath()}' --port ${port} ` +
        `--password-file '${passwordFile}' --directory '/wt 2934'`
    );
    const rendered = renderAgentLaunchCommand(plan);
    expect(rendered).not.toContain(password);
    expect(Object.values(resolveAgentLaunchEnv(plan))).not.toContain(password);
    expect(rendered).not.toContain('OPENCODE_SERVER_PASSWORD');
  });

  it('falls back to a private --standalone server, never the shared background service', () => {
    const plan = prepareOpencodeV2Launch({
      target,
      executablePath: 'opencode2',
      worktreePath: '/wt',
    });
    expect(plan.command).toBe(`'opencode2' --standalone '/wt'`);
    expect(plan.env).toEqual({});
  });

  it('falls back the same way when the password file is missing', async () => {
    await allocateOpencodeV2Port(target, '/wt', async () => true);
    const plan = prepareOpencodeV2Launch({
      target,
      executablePath: 'opencode2',
      worktreePath: '/wt',
    });
    expect(plan.command).toContain('--standalone');
  });
});
