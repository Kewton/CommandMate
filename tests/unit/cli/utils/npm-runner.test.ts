/**
 * npm-runner tests
 * Issue #1633: findGlobalInstallation — locating a leftover `npm install -g` install so the npx
 * self-update can warn about it. Every failure mode must degrade to "nothing to report", never
 * throw: the caller only prints a warning and must not be able to abort an update because of it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'child_process';
import * as fs from 'fs';

vi.mock('child_process');
vi.mock('fs');

import { findGlobalInstallation, NPM_ROOT_TIMEOUT_MS } from '../../../../src/cli/utils/npm-runner';

type SpawnResult = childProcess.SpawnSyncReturns<string>;

/** Minimal spawnSync result shaped like a successful `npm root -g` */
const ok = (stdout: string): SpawnResult =>
  ({ status: 0, stdout, stderr: '', pid: 1, output: [], signal: null }) as unknown as SpawnResult;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findGlobalInstallation (Issue #1633)', () => {
  it('asks npm for the global root and reports the package with its version', () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue(ok('/usr/local/lib/node_modules\n'));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ version: '0.2.4' }));

    expect(findGlobalInstallation('commandmate')).toEqual({
      path: '/usr/local/lib/node_modules/commandmate',
      version: '0.2.4',
    });

    // Array args, never a shell string (MF-SEC-1), and bounded by a timeout
    expect(childProcess.spawnSync).toHaveBeenCalledWith('npm', ['root', '-g'], {
      encoding: 'utf-8',
      timeout: NPM_ROOT_TIMEOUT_MS,
    });
    expect(fs.readFileSync).toHaveBeenCalledWith(
      '/usr/local/lib/node_modules/commandmate/package.json',
      'utf-8'
    );
  });

  it('returns null when the package is not in the global root', () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue(ok('/usr/local/lib/node_modules'));
    vi.mocked(fs.existsSync).mockReturnValue(false);

    expect(findGlobalInstallation('commandmate')).toBeNull();
  });

  it('returns null when npm is not installed (ENOENT)', () => {
    const error = new Error('spawn npm ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      ...ok(''),
      error,
    } as unknown as SpawnResult);

    expect(findGlobalInstallation('commandmate')).toBeNull();
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it('returns null when `npm root -g` exits non-zero (permissions, bad config, ...)', () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      ...ok(''),
      status: 1,
      stderr: 'EACCES',
    } as unknown as SpawnResult);

    expect(findGlobalInstallation('commandmate')).toBeNull();
  });

  it('returns null when npm prints no root at all', () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue(ok('   \n'));

    expect(findGlobalInstallation('commandmate')).toBeNull();
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it('reports the install without a version when package.json is unreadable', () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue(ok('/usr/local/lib/node_modules'));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('EACCES');
    });

    expect(findGlobalInstallation('commandmate')).toEqual({
      path: '/usr/local/lib/node_modules/commandmate',
    });
  });

  it('reports the install without a version when package.json has no usable version', () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue(ok('/usr/local/lib/node_modules'));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ name: 'commandmate' }));

    expect(findGlobalInstallation('commandmate')).toEqual({
      path: '/usr/local/lib/node_modules/commandmate',
    });
  });

  it('reports the install without a version when package.json is not valid JSON', () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue(ok('/usr/local/lib/node_modules'));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{ truncated');

    expect(findGlobalInstallation('commandmate')).toEqual({
      path: '/usr/local/lib/node_modules/commandmate',
    });
  });
});
