/**
 * Issue #4058: api-client.ts split into api-client-errors.ts and
 * api-client-deadline.ts. Each split-out module has its own unit tests here,
 * and api-client.ts keeps re-exporting every moved name (same identity), so
 * the existing import sites stay unchanged.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as apiClient from '../../../../src/cli/utils/api-client';
import * as errors from '../../../../src/cli/utils/api-client-errors';
import * as deadline from '../../../../src/cli/utils/api-client-deadline';
import { ExitCode, WaitExitCode } from '../../../../src/cli/types';

const REPO_ROOT = join(__dirname, '../../../..');
const UTILS = 'src/cli/utils';

/** Relative module specifiers a source text imports or re-exports. */
function relativeSpecifiers(text: string): string[] {
  return [...text.matchAll(/(?:import|export)[^'";]*?from\s+['"](\.[^'"]+)['"]/g)].map(m => m[1]);
}

/** Whether a split-out module reaches './api-client' (directly or via a sibling split module). */
function reachesApiClient(dir: string, file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const text = readFileSync(join(dir, `${file}.ts`), 'utf-8');
  for (const spec of relativeSpecifiers(text)) {
    const name = spec.replace(/^\.\//, '');
    if (name === 'api-client') return true;
    if (name.startsWith('api-client-') && reachesApiClient(dir, name, seen)) return true;
  }
  return false;
}

describe('[#4058] api-client-errors', () => {
  it('handleApiError classifies statuses as before', () => {
    expect(errors.handleApiError(null, 400).exitCode).toBe(ExitCode.CONFIG_ERROR);
    expect(errors.handleApiError(null, 404, undefined, { serverUrl: 'http://localhost:3999' }).message)
      .toBe('Resource not found. Check the worktree ID. (server: http://localhost:3999)');
    expect(errors.handleApiError(null, 500, { error: 'boom' }).message).toBe('Server error: boom');
    expect(errors.handleApiError(null, 429).exitCode).toBe(ExitCode.DEPENDENCY_ERROR);
    expect(errors.handleApiError(new Error('fetch failed')).message)
      .toBe('Server is not running. Start it with: commandmate start');
  });

  it('a foreign-session 409 gets its own message; any other 409 keeps the default', () => {
    const payload = { code: errors.FOREIGN_SESSION_ERROR_CODE, sessionName: 'mcbd-x' };
    expect(errors.handleApiError(null, 409, payload).message).toBe(errors.foreignSessionMessage(payload));
    expect(errors.handleApiError(null, 409, { code: 'other' }).message).toBe('Unexpected HTTP status: 409');
  });

  it('withServerUrl appends the server only when given', () => {
    expect(errors.withServerUrl('m', { serverUrl: 'http://h' })).toBe('m (server: http://h)');
    expect(errors.withServerUrl('m')).toBe('m');
  });

  it('ApiError carries exit code, status, payload and apiCode', () => {
    const err = new errors.ApiError('x', 2, 409, { code: 'c' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
    expect([err.exitCode, err.statusCode, err.apiCode]).toEqual([2, 409, 'c']);
  });
});

describe('[#4058] api-client-deadline', () => {
  it('DeadlineExceededError is an ApiError with exit 124 naming the server', () => {
    const err = new deadline.DeadlineExceededError('http://h');
    expect(err).toBeInstanceOf(errors.ApiError);
    expect(err.exitCode).toBe(WaitExitCode.TIMEOUT);
    expect(err.name).toBe('DeadlineExceededError');
    expect(err.message).toBe('--timeout reached before the server answered (server: http://h)');
  });

  it('isDeadlineExceeded sees the error itself, as transportError, and as cause', () => {
    const d = new deadline.DeadlineExceededError();
    expect(deadline.isDeadlineExceeded(d)).toBe(true);
    expect(deadline.isDeadlineExceeded(new errors.ApiError('w', 1, undefined, undefined, d))).toBe(true);
    expect(deadline.isDeadlineExceeded(new Error('w', { cause: d }))).toBe(true);
    // negative: other errors are not deadlines
    expect(deadline.isDeadlineExceeded(new errors.ApiError('w', 1))).toBe(false);
    expect(deadline.isDeadlineExceeded('x')).toBe(false);
  });

  it('rethrowIfDeadlineExceeded throws only a deadline', () => {
    const d = new deadline.DeadlineExceededError();
    expect(() => deadline.rethrowIfDeadlineExceeded(d)).toThrow(d);
    expect(() => deadline.rethrowIfDeadlineExceeded(new Error('other'))).not.toThrow();
  });
});

describe('[#4058] api-client.ts re-exports the moved names', () => {
  it('every moved runtime name is the same object through api-client', () => {
    expect(apiClient.ApiError).toBe(errors.ApiError);
    expect(apiClient.handleApiError).toBe(errors.handleApiError);
    expect(apiClient.foreignSessionMessage).toBe(errors.foreignSessionMessage);
    expect(apiClient.FOREIGN_SESSION_ERROR_CODE).toBe(errors.FOREIGN_SESSION_ERROR_CODE);
    expect(apiClient.DeadlineExceededError).toBe(deadline.DeadlineExceededError);
    expect(apiClient.isDeadlineExceeded).toBe(deadline.isDeadlineExceeded);
    expect(apiClient.rethrowIfDeadlineExceeded).toBe(deadline.rethrowIfDeadlineExceeded);
  });

  it('api-client.ts is back to 635 lines or fewer', () => {
    const lines = readFileSync(join(REPO_ROOT, UTILS, 'api-client.ts'), 'utf-8').split('\n').length - 1;
    expect(lines).toBeLessThanOrEqual(635);
  });
});

describe('[#4058] the split modules do not import api-client.ts', () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('negative: neither split module reaches api-client.ts', () => {
    const dir = join(REPO_ROOT, UTILS);
    expect(reachesApiClient(dir, 'api-client-errors')).toBe(false);
    expect(reachesApiClient(dir, 'api-client-deadline')).toBe(false);
  });

  it('positive: the check catches a split module that imports api-client.ts, directly or through a sibling', () => {
    tmp = mkdtempSync(join(tmpdir(), 'api-client-split-4058-'));
    writeFileSync(join(tmp, 'api-client-errors.ts'), "import { ApiClient } from './api-client';\n");
    writeFileSync(join(tmp, 'api-client-deadline.ts'), "import { ApiError } from './api-client-errors';\n");
    expect(reachesApiClient(tmp, 'api-client-errors')).toBe(true);
    expect(reachesApiClient(tmp, 'api-client-deadline')).toBe(true);
  });
});
