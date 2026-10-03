/**
 * viewLatestVersionAsync tests (Issue #3110)
 *
 * The server-side, non-blocking `npm view` the update check uses. Pins the
 * array-args / no-shell / timeout contract (MF-SEC-1) and that every failure
 * resolves to a classified result instead of rejecting. npm is never run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'child_process';

vi.mock('child_process');

import { NPM_VIEW_TIMEOUT_MS, viewLatestVersionAsync } from '../../../../src/cli/utils/npm-runner';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

/** Make the mocked execFile answer with the given callback arguments */
function execFileAnswers(error: Error | null, stdout = '', stderr = ''): void {
  vi.mocked(childProcess.execFile).mockImplementation(((
    _file: string,
    _args: string[],
    _options: unknown,
    callback: ExecFileCallback
  ) => {
    callback(error, stdout, stderr);
    return {} as childProcess.ChildProcess;
  }) as unknown as typeof childProcess.execFile);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('viewLatestVersionAsync (Issue #3110)', () => {
  it('runs `npm view <pkg> version` with array args and a timeout, and returns the version', async () => {
    execFileAnswers(null, '0.44.0\n');

    await expect(viewLatestVersionAsync('commandmate')).resolves.toEqual({
      success: true,
      version: '0.44.0',
    });
    expect(childProcess.execFile).toHaveBeenCalledWith(
      'npm',
      ['view', 'commandmate', 'version'],
      { encoding: 'utf-8', timeout: NPM_VIEW_TIMEOUT_MS },
      expect.any(Function)
    );
  });

  it('classifies a missing npm', async () => {
    execFileAnswers(Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }));

    const result = await viewLatestVersionAsync('commandmate');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/npm command not found/);
  });

  it('reports stderr on a failed query', async () => {
    execFileAnswers(new Error('Command failed'), '', 'npm ERR! network\n');

    await expect(viewLatestVersionAsync('commandmate')).resolves.toEqual({
      success: false,
      error: 'npm ERR! network',
    });
  });

  it('fails on empty output', async () => {
    execFileAnswers(null, '   \n');

    await expect(viewLatestVersionAsync('commandmate')).resolves.toEqual({
      success: false,
      error: 'npm view returned no version',
    });
  });
});
