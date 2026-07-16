/**
 * Issue #1263: better-sqlite3 ABI mismatch detection and automatic rebuild.
 *
 * The error fixtures below are copied verbatim from real failures observed by
 * loading an ABI-115 better-sqlite3 build under Node 24 (and the reverse under
 * Node 20), so the detection logic is tested against Node's actual output.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';
import path from 'path';
import Database from 'better-sqlite3';
import {
  isAbiMismatchError,
  rebuildBetterSqlite3,
  openDatabaseWithAbiRecovery,
  resetAbiRecoveryStateForTests,
} from '../../../../src/lib/db/abi-recovery';

vi.mock('child_process');
vi.mock('better-sqlite3', () => ({ default: vi.fn() }));

/** Real Node output: ABI-115 addon loaded under Node 24 (ABI 137). */
function abiMismatchError(): NodeJS.ErrnoException {
  const error = new Error(
    "The module '/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
      'was compiled against a different Node.js version using\n' +
      'NODE_MODULE_VERSION 115. This version of Node.js requires\n' +
      'NODE_MODULE_VERSION 137. Please try re-compiling or re-installing\n' +
      'the module (for instance, using `npm rebuild` or `npm install`).'
  ) as NodeJS.ErrnoException;
  error.code = 'ERR_DLOPEN_FAILED';
  return error;
}

/** Real Node output: dlopen of a missing/corrupt .node — same code, different cause. */
function dlopenMissingFileError(): NodeJS.ErrnoException {
  const error = new Error(
    "dlopen(/app/build/Release/better_sqlite3.node, 0x0001): tried: '/app/build/Release/better_sqlite3.node' (no such file)"
  ) as NodeJS.ErrnoException;
  error.code = 'ERR_DLOPEN_FAILED';
  return error;
}

/** Real output from the `bindings` package when the addon was never built. */
function bindingsNotFoundError(): Error {
  return new Error('Could not locate the bindings file. Tried:\n → /app/build/better_sqlite3.node');
}

/** `new Database()` needs a constructor-shaped mock; arrow fns cannot be `new`ed. */
function opens(db: unknown) {
  return function () {
    return db;
  } as never;
}

function failsWith(error: Error) {
  return function (): never {
    throw error;
  } as never;
}

function spawnResult(
  over: Partial<childProcess.SpawnSyncReturns<string>> = {}
): childProcess.SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null, ...over };
}

describe('isAbiMismatchError', () => {
  it('detects a real NODE_MODULE_VERSION mismatch', () => {
    expect(isAbiMismatchError(abiMismatchError())).toBe(true);
  });

  it('does not treat other ERR_DLOPEN_FAILED causes as an ABI mismatch', () => {
    // Node reuses ERR_DLOPEN_FAILED for missing/corrupt binaries; rebuilding
    // would not fix those, so the code alone must not be the signal.
    expect(isAbiMismatchError(dlopenMissingFileError())).toBe(false);
  });

  it('does not treat a missing binding file as an ABI mismatch', () => {
    expect(isAbiMismatchError(bindingsNotFoundError())).toBe(false);
  });

  it('ignores non-Error values', () => {
    expect(isAbiMismatchError('NODE_MODULE_VERSION 115')).toBe(false);
    expect(isAbiMismatchError(null)).toBe(false);
    expect(isAbiMismatchError(undefined)).toBe(false);
  });
});

describe('rebuildBetterSqlite3', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('runs npm rebuild with array args and a timeout, never a shell string', () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue(spawnResult());

    expect(rebuildBetterSqlite3().success).toBe(true);

    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      'npm',
      ['rebuild', 'better-sqlite3'],
      expect.objectContaining({ cwd: process.cwd(), timeout: expect.any(Number) })
    );
    const options = vi.mocked(childProcess.spawnSync).mock.calls[0][2] as { shell?: boolean };
    expect(options.shell).toBeUndefined();
  });

  it('pins the rebuild to the running Node.js binary, not whatever npm finds on PATH', () => {
    // Regression: npm resolves `node` from PATH. When that differs from the
    // running interpreter the rebuild targets the wrong ABI and the recovery
    // loops back into the same mismatch.
    vi.mocked(childProcess.spawnSync).mockReturnValue(spawnResult());

    rebuildBetterSqlite3();

    const options = vi.mocked(childProcess.spawnSync).mock.calls[0][2] as {
      env?: NodeJS.ProcessEnv;
    };
    const pathEntries = (options.env?.PATH ?? '').split(path.delimiter);
    expect(pathEntries[0]).toBe(path.dirname(process.execPath));
  });

  it('reports permissionDenied when npm hits EACCES', () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue(
      spawnResult({ status: 1, stderr: 'npm ERR! Error: EACCES: permission denied, access ...' })
    );

    expect(rebuildBetterSqlite3()).toMatchObject({ success: false, permissionDenied: true });
  });

  it('reports a plain failure when npm fails for another reason', () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue(
      spawnResult({ status: 1, stderr: 'npm ERR! gyp ERR! build error' })
    );

    expect(rebuildBetterSqlite3()).toMatchObject({ success: false, permissionDenied: false });
  });
});

describe('openDatabaseWithAbiRecovery', () => {
  const fakeDb = { name: 'db' };

  beforeEach(() => {
    vi.resetAllMocks();
    resetAbiRecoveryStateForTests();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens normally without any rebuild overhead on a healthy install', () => {
    vi.mocked(Database).mockImplementation(opens(fakeDb));

    expect(openDatabaseWithAbiRecovery('/tmp/x.db')).toBe(fakeDb);

    // The whole point of the try/catch design: healthy startup must not spawn npm.
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('rebuilds and retries once on an ABI mismatch', () => {
    vi.mocked(Database)
      .mockImplementationOnce(failsWith(abiMismatchError()))
      .mockImplementationOnce(opens(fakeDb));
    vi.mocked(childProcess.spawnSync).mockReturnValue(spawnResult());

    expect(openDatabaseWithAbiRecovery('/tmp/x.db')).toBe(fakeDb);

    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      'npm',
      ['rebuild', 'better-sqlite3'],
      expect.anything()
    );
    expect(vi.mocked(Database)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/Rebuilding it automatically/);
  });

  it('rethrows a non-ABI error untouched and does not rebuild', () => {
    const failure = new Error('SQLITE_CANTOPEN: unable to open database file');
    vi.mocked(Database).mockImplementation(failsWith(failure));

    expect(() => openDatabaseWithAbiRecovery('/tmp/x.db')).toThrow(failure);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('explains the manual fix when the rebuild fails, without suggesting sudo', () => {
    vi.mocked(Database).mockImplementation(failsWith(abiMismatchError()));
    vi.mocked(childProcess.spawnSync).mockReturnValue(
      spawnResult({ status: 1, stderr: 'gyp ERR! build error' })
    );

    let message = '';
    try {
      openDatabaseWithAbiRecovery('/tmp/x.db');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/different Node\.js version/);
    expect(message).toContain('npm rebuild better-sqlite3');
    expect(message).not.toMatch(/sudo/i);
  });

  it('gives a non-sudo remedy when the install directory is not writable', () => {
    vi.mocked(Database).mockImplementation(failsWith(abiMismatchError()));
    vi.mocked(childProcess.spawnSync).mockReturnValue(
      spawnResult({ status: 1, stderr: 'npm ERR! Error: EACCES: permission denied' })
    );

    let message = '';
    try {
      openDatabaseWithAbiRecovery('/tmp/x.db');
    } catch (error) {
      message = (error as Error).message;
    }

    // Warning against sudo is wanted; instructing the user to run it is not.
    expect(message).not.toMatch(/sudo\s+(npm|node|chown|chmod)/i);
    expect(message).toMatch(/Do not re-run this with sudo/);
    expect(message).toMatch(/not writable/);
    expect(message).toMatch(/npm install -g commandmate/);
  });

  it('fails clearly when the addon is still mismatched after a successful rebuild', () => {
    vi.mocked(Database).mockImplementation(failsWith(abiMismatchError()));
    vi.mocked(childProcess.spawnSync).mockReturnValue(spawnResult());

    expect(() => openDatabaseWithAbiRecovery('/tmp/x.db')).toThrow(/still reports a version mismatch/);
  });

  it('does not retry the rebuild once it has already failed in this process', () => {
    vi.mocked(Database).mockImplementation(failsWith(abiMismatchError()));
    vi.mocked(childProcess.spawnSync).mockReturnValue(spawnResult({ status: 1 }));

    expect(() => openDatabaseWithAbiRecovery('/tmp/x.db')).toThrow();
    expect(() => openDatabaseWithAbiRecovery('/tmp/x.db')).toThrow();

    expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
  });
});
