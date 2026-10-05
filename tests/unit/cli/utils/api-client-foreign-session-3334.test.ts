/**
 * Issue #3334 — the CLI says what the ownership 409 means.
 *
 * Every session route answers a tmux session another CommandMate server
 * created with 409 `session_owned_by_other_server` (#2865 / #3290). The CLI
 * classified it through the default branch as "Unexpected HTTP status: 409",
 * which says neither that nothing was done nor why. The exit code is kept: a
 * script branching on it sees no change.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  ApiClient,
  ApiError,
  FOREIGN_SESSION_ERROR_CODE,
  handleApiError,
} from '@/cli/utils/api-client';
import { ExitCode } from '@/cli/types';
import { FOREIGN_SESSION_ERROR_CODE as SERVER_CODE, foreignSessionErrorBody } from '@/lib/tmux/session-ownership';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

const BODY = foreignSessionErrorBody('mcbd-claude-wt1', '/other-server/wt1');

afterEach(() => {
  restoreFetch();
});

describe('[#3334] handleApiError and the foreign-session 409', () => {
  it('reads the same code the server sends', () => {
    expect(FOREIGN_SESSION_ERROR_CODE).toBe(SERVER_CODE);
  });

  it('says the session is another server\'s and that nothing was done to it', () => {
    const result = handleApiError(null, 409, BODY);

    expect(result.message).toContain('"mcbd-claude-wt1" belongs to another CommandMate server');
    expect(result.message).toContain('/other-server/wt1');
    expect(result.message).toContain('nothing was sent to it, read from it or stopped');
    expect(result.message).not.toContain('Unexpected HTTP status');
  });

  it('keeps the exit code a 409 always had', () => {
    expect(handleApiError(null, 409, BODY).exitCode).toBe(handleApiError(null, 409).exitCode);
    expect(handleApiError(null, 409, BODY).exitCode).toBe(ExitCode.UNEXPECTED_ERROR);
  });

  it('still reads without a session path', () => {
    const result = handleApiError(null, 409, { ...BODY, sessionPath: null });

    expect(result.message).toContain('belongs to another CommandMate server');
    expect(result.message).not.toContain('started in');
  });

  it('leaves every other 409 as it was (control)', () => {
    expect(handleApiError(null, 409, { code: 'PROMPT_WAITING', error: 'x' }).message).toBe(
      'Unexpected HTTP status: 409'
    );
    expect(handleApiError(null, 409).message).toBe('Unexpected HTTP status: 409');
  });

  it('reaches the ApiError a command prints', async () => {
    mockFetchResponse(BODY, 409);
    const client = new ApiClient({ baseUrl: 'http://localhost:3999' });

    const error = await client
      .post('/api/worktrees/wt1/send', { content: 'hi' })
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).apiCode).toBe(FOREIGN_SESSION_ERROR_CODE);
    expect((error as ApiError).message).toContain('belongs to another CommandMate server');
    expect((error as ApiError).exitCode).toBe(ExitCode.UNEXPECTED_ERROR);
  });
});
