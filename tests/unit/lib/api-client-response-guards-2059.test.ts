/**
 * api-client response guards (Issue #2059).
 *
 * `detectAuthRedirect` / `detectNonJsonBody` are the two checks `fetchApi` has
 * always applied, extracted so a caller that owns its own `fetch()` call site
 * (useWorktreesCache) rejects exactly the same responses. These tests pin the
 * rules in one place so the two call sites cannot drift.
 */

import { describe, it, expect } from 'vitest';
import { detectAuthRedirect, detectNonJsonBody, ApiError } from '@/lib/api-client';

function response(init: {
  status?: number;
  redirected?: boolean;
  url?: string;
  contentType?: string | null;
  withHeaders?: boolean;
}): Response {
  const {
    status = 200,
    redirected = false,
    url = 'http://localhost/api/worktrees',
    contentType = 'application/json',
    withHeaders = true,
  } = init;
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected,
    url,
    headers: withHeaders
      ? new Headers(contentType === null ? {} : { 'content-type': contentType })
      : undefined,
  } as unknown as Response;
}

describe('detectAuthRedirect (Issue #2059)', () => {
  it('reports 401 for a followed redirect to /login', () => {
    const error = detectAuthRedirect(
      response({ redirected: true, url: 'http://localhost/login?from=%2F', contentType: 'text/html' }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error?.status).toBe(401);
    expect(error?.message).toBe('Authentication required');
  });

  it('passes a normal, non-redirected response', () => {
    expect(detectAuthRedirect(response({}))).toBeNull();
  });

  it('passes a redirect that did not land on /login', () => {
    expect(
      detectAuthRedirect(response({ redirected: true, url: 'http://localhost/api/worktrees/' })),
    ).toBeNull();
  });
});

describe('detectNonJsonBody (Issue #2059)', () => {
  it('rejects an HTML body', () => {
    const error = detectNonJsonBody(response({ contentType: 'text/html; charset=utf-8' }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error?.message).toBe('Unexpected response format');
    expect(error?.status).toBe(200);
  });

  it('rejects a response that declares no content-type at all', () => {
    expect(detectNonJsonBody(response({ contentType: null }))?.message).toBe(
      'Unexpected response format',
    );
  });

  it('accepts application/json, charset and all', () => {
    expect(detectNonJsonBody(response({ contentType: 'application/json; charset=utf-8' }))).toBeNull();
  });

  it('skips the check when the response carries no headers object', () => {
    // A real Response always has one; a stub may not, and guessing "not JSON"
    // there would reject perfectly good payloads.
    expect(detectNonJsonBody(response({ withHeaders: false }))).toBeNull();
  });
});
