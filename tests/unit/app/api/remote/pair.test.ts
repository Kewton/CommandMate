/**
 * POST /api/remote/pair — one-shot pairing code exchange (Issue #1937, R5)
 * Design: docs/design/remote-qr-pairing-1937.md §7.3 / §9.2
 *
 * The design's step order IS the single-use property, so these tests assert the
 * observable consequences of that order rather than the order itself: the
 * handoff file is gone after a 200, a second attempt with the same code is 410,
 * and the long-lived token appears in the cookie and nowhere else.
 *
 * The route is re-imported per test because its rate limiter is module-level
 * state; without a fresh module the sixth assertion in the file would trip the
 * limiter belonging to the first.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NextRequest } from 'next/server';

vi.mock('@/cli/utils/security-logger', () => ({
  logSecurityEvent: vi.fn(),
}));

import { logSecurityEvent } from '@/cli/utils/security-logger';
import { AUTH_COOKIE_NAME } from '@/config/auth-config';
import {
  PAIRING_FILE_ENV_KEY,
  PAIRING_FILE_NAME,
  createPairingHandoff,
} from '@/lib/security/pairing-code';

const PAIR_URL = 'http://localhost/api/remote/pair';

let workDir: string;
let pairingFile: string;
let previousEnv: string | undefined;

/** Fresh module instance -> fresh rate limiter for every test. */
async function postPair(body: unknown, init?: { raw?: string }) {
  vi.resetModules();
  const { POST } = await import('@/app/api/remote/pair/route');
  return POST(
    new NextRequest(PAIR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: init?.raw ?? JSON.stringify(body),
    })
  );
}

/** Same module instance across calls, so the rate limiter accumulates. */
async function postPairRepeatedly(body: unknown, times: number) {
  vi.resetModules();
  const { POST } = await import('@/app/api/remote/pair/route');
  const responses = [];
  for (let i = 0; i < times; i++) {
    responses.push(
      await POST(
        new NextRequest(PAIR_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      )
    );
  }
  return responses;
}

beforeEach(() => {
  vi.clearAllMocks();
  workDir = mkdtempSync(join(tmpdir(), 'cm-pair-route-'));
  pairingFile = join(workDir, PAIRING_FILE_NAME);
  previousEnv = process.env[PAIRING_FILE_ENV_KEY];
  process.env[PAIRING_FILE_ENV_KEY] = pairingFile;
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env[PAIRING_FILE_ENV_KEY];
  else process.env[PAIRING_FILE_ENV_KEY] = previousEnv;
  rmSync(workDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('POST /api/remote/pair', () => {
  it('answers 404 when remote is not running (no CM_REMOTE_PAIRING_FILE)', async () => {
    delete process.env[PAIRING_FILE_ENV_KEY];

    const response = await postPair({ code: 'ANYTHING' });

    expect(response.status).toBe(404);
  });

  it('pairs once: 200, cookie set, handoff file gone', async () => {
    const created = createPairingHandoff({ filePath: pairingFile });
    expect(existsSync(pairingFile)).toBe(true);
    expect(statSync(pairingFile).mode & 0o777).toBe(0o600);

    const response = await postPair({ code: created.code });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true });

    // The consumed flag IS the file's absence (§7.2).
    expect(existsSync(pairingFile)).toBe(false);

    const cookie = response.cookies.get(AUTH_COOKIE_NAME);
    expect(cookie?.value).toBe(created.sessionToken);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('strict');
  });

  it('never puts the session token or the code in the response body', async () => {
    const created = createPairingHandoff({ filePath: pairingFile });

    const response = await postPair({ code: created.code });
    const raw = JSON.stringify(await response.json());

    expect(raw).not.toContain(created.sessionToken);
    expect(raw).not.toContain(created.code);
  });

  it('rejects the same code a second time with 410', async () => {
    const created = createPairingHandoff({ filePath: pairingFile });

    expect((await postPair({ code: created.code })).status).toBe(200);

    const second = await postPair({ code: created.code });
    expect(second.status).toBe(410);
    expect(second.cookies.get(AUTH_COOKIE_NAME)).toBeUndefined();
  });

  it('answers 410 once the TTL has passed, and removes the stale file', async () => {
    const created = createPairingHandoff({
      filePath: pairingFile,
      now: Date.now() - 60 * 60 * 1000,
    });

    const response = await postPair({ code: created.code });

    expect(response.status).toBe(410);
    expect(response.cookies.get(AUTH_COOKIE_NAME)).toBeUndefined();
    expect(existsSync(pairingFile)).toBe(false);
  });

  it('answers 410 when the handoff file is corrupt', async () => {
    writeFileSync(pairingFile, 'not json at all', { mode: 0o600 });

    expect((await postPair({ code: 'ABCDEFGHJKMNPQRSTVWXYZ0123' })).status).toBe(410);
  });

  it('answers 401 for a wrong code and leaves the handoff file in place', async () => {
    const created = createPairingHandoff({ filePath: pairingFile });

    const response = await postPair({ code: 'ABCDEFGHJKMNPQRSTVWXYZ0123' });

    expect(response.status).toBe(401);
    expect(response.cookies.get(AUTH_COOKIE_NAME)).toBeUndefined();
    // A typo must not burn the operator's code.
    expect(existsSync(pairingFile)).toBe(true);
    expect((await postPair({ code: created.code })).status).toBe(200);
  });

  it('answers 400 for a missing, non-string, or over-long code', async () => {
    createPairingHandoff({ filePath: pairingFile });

    expect((await postPair({})).status).toBe(400);
    expect((await postPair({ code: 42 })).status).toBe(400);
    expect((await postPair({ code: '' })).status).toBe(400);
    expect((await postPair({ code: 'A'.repeat(257) })).status).toBe(400);
    expect((await postPair(null, { raw: 'not-json' })).status).toBe(400);

    // None of the above touched the handoff file.
    expect(existsSync(pairingFile)).toBe(true);
  });

  it('rate limits repeated attempts with 429 and a Retry-After header', async () => {
    createPairingHandoff({ filePath: pairingFile });

    const responses = await postPairRepeatedly({ code: 'ABCDEFGHJKMNPQRSTVWXYZ0123' }, 6);

    expect(responses.slice(0, 5).map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    expect(responses[5].status).toBe(429);
    expect(Number(responses[5].headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('logs the outcome without ever logging the code or the token', async () => {
    const created = createPairingHandoff({ filePath: pairingFile });

    await postPair({ code: created.code });

    expect(logSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'remote', action: 'success' })
    );

    const logged = JSON.stringify(vi.mocked(logSecurityEvent).mock.calls);
    expect(logged).not.toContain(created.code);
    expect(logged).not.toContain(created.sessionToken);
  });

  it('logs a failure without the attempted code', async () => {
    createPairingHandoff({ filePath: pairingFile });

    await postPair({ code: 'ABCDEFGHJKMNPQRSTVWXYZ0123' });

    expect(logSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'remote', action: 'failure' })
    );
    expect(JSON.stringify(vi.mocked(logSecurityEvent).mock.calls)).not.toContain(
      'ABCDEFGHJKMNPQRSTVWXYZ0123'
    );
  });
});
