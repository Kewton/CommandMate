/**
 * ApiClient Tests
 * Issue #518: [DR1-01] Individual tests for resolveAuthToken, handleApiError, get/post
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveAuthToken,
  handleApiError,
  isValidWorktreeId,
  ApiClient,
  ApiError,
  MAX_STOP_PATTERN_LENGTH,
  assertResponseShape,
  fetchDaemonVersion,
  warnIfVersionSkew,
} from '../../../../src/cli/utils/api-client';
import { readPackageVersion } from '../../../../src/cli/utils/package-info';
import { ExitCode } from '../../../../src/cli/types';
import { mockFetchResponse, mockFetchError, restoreFetch } from '../../../helpers/mock-api';

/**
 * Issue #1743: ApiClient resolves its port through ~/.commandmate/.env, so the .env read is
 * mocked here. The suite must not depend on the developer's own .env — nor on one existing at
 * all — and every precedence case below has to be expressible without touching the disk.
 */
const dotenvMock = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock('dotenv', () => ({
  config: dotenvMock.config,
  default: { config: dotenvMock.config },
}));

vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getEnvPath: vi.fn(() => '/mock/.commandmate/.env'),
}));

/**
 * Stand in for ~/.commandmate/.env.
 * @param parsed - The file's contents; undefined reproduces "no .env on disk", where dotenv
 *   returns an error result carrying no `parsed` at all.
 */
function stubEnvFile(parsed?: Record<string, string>): void {
  dotenvMock.config.mockReturnValue({ parsed });
}

// Nothing in the .env unless a test says otherwise
beforeEach(() => {
  stubEnvFile({});
});

/** Every variable resolveServerEndpoint() reads (Issue #1743). */
const ENDPOINT_ENV_KEYS = ['CM_PORT', 'CM_BIND', 'CM_HTTPS_CERT', 'CM_HTTPS_KEY'] as const;

/**
 * Give the enclosing describe a clean slate for those variables, restoring the shell's own
 * values afterwards. `commandmate init` writes CM_PORT and CM_BIND, and a developer shell
 * commonly exports them; they correctly outrank the .env, so leaving them set would let the
 * machine — not the test — decide the URL.
 */
function useCleanEndpointEnv(): void {
  const exported = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENDPOINT_ENV_KEYS) {
      exported.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENDPOINT_ENV_KEYS) {
      const value = exported.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

describe('resolveAuthToken', () => {
  const originalEnv = process.env.CM_AUTH_TOKEN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CM_AUTH_TOKEN;
    } else {
      process.env.CM_AUTH_TOKEN = originalEnv;
    }
  });

  it('returns --token option value when provided', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = resolveAuthToken({ token: 'my-token' });
    expect(result).toBe('my-token');
    // [SEC4-01] Should warn about token exposure
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('--token flag exposes token')
    );
    consoleSpy.mockRestore();
  });

  it('returns CM_AUTH_TOKEN env var when no --token', () => {
    process.env.CM_AUTH_TOKEN = 'env-token';
    const result = resolveAuthToken({});
    expect(result).toBe('env-token');
  });

  it('returns undefined when no token available', () => {
    delete process.env.CM_AUTH_TOKEN;
    const result = resolveAuthToken({});
    expect(result).toBeUndefined();
  });

  it('prefers --token over CM_AUTH_TOKEN', () => {
    process.env.CM_AUTH_TOKEN = 'env-token';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = resolveAuthToken({ token: 'cli-token' });
    expect(result).toBe('cli-token');
    consoleSpy.mockRestore();
  });
});

describe('handleApiError', () => {
  it('maps ECONNREFUSED to DEPENDENCY_ERROR', () => {
    const result = handleApiError(new Error('connect ECONNREFUSED 127.0.0.1:3000'));
    expect(result.exitCode).toBe(ExitCode.DEPENDENCY_ERROR);
    expect(result.message).toContain('commandmate start');
  });

  it('maps 400 to CONFIG_ERROR', () => {
    const result = handleApiError(null, 400);
    expect(result.exitCode).toBe(ExitCode.CONFIG_ERROR);
  });

  it('maps 401 to CONFIG_ERROR', () => {
    const result = handleApiError(null, 401);
    expect(result.exitCode).toBe(ExitCode.CONFIG_ERROR);
    expect(result.message).toContain('Authentication failed');
  });

  it('maps 403 to CONFIG_ERROR', () => {
    const result = handleApiError(null, 403);
    expect(result.exitCode).toBe(ExitCode.CONFIG_ERROR);
  });

  it('maps 404 to UNEXPECTED_ERROR', () => {
    const result = handleApiError(null, 404);
    expect(result.exitCode).toBe(ExitCode.UNEXPECTED_ERROR);
    expect(result.message).toContain('not found');
  });

  it('maps 429 to DEPENDENCY_ERROR with retry message', () => {
    const result = handleApiError(null, 429);
    expect(result.exitCode).toBe(ExitCode.DEPENDENCY_ERROR);
    expect(result.message).toContain('Rate limited');
  });

  it('maps 500 to UNEXPECTED_ERROR', () => {
    const result = handleApiError(null, 500);
    expect(result.exitCode).toBe(ExitCode.UNEXPECTED_ERROR);
    expect(result.message).toContain('Server error');
  });

  it('maps AbortError to DEPENDENCY_ERROR', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const result = handleApiError(err);
    expect(result.exitCode).toBe(ExitCode.DEPENDENCY_ERROR);
    expect(result.message).toContain('did not respond in time');
  });

  it('maps TypeError to DEPENDENCY_ERROR', () => {
    const err = new TypeError('fetch failed');
    const result = handleApiError(err);
    expect(result.exitCode).toBe(ExitCode.DEPENDENCY_ERROR);
  });

  it('maps unknown error to UNEXPECTED_ERROR', () => {
    const result = handleApiError('some string error');
    expect(result.exitCode).toBe(ExitCode.UNEXPECTED_ERROR);
  });
});

describe('isValidWorktreeId', () => {
  it('accepts valid IDs', () => {
    expect(isValidWorktreeId('abc123')).toBe(true);
    expect(isValidWorktreeId('my-worktree')).toBe(true);
    expect(isValidWorktreeId('feature_123')).toBe(true);
  });

  it('rejects invalid IDs', () => {
    expect(isValidWorktreeId('')).toBe(false);
    expect(isValidWorktreeId('../etc/passwd')).toBe(false);
    expect(isValidWorktreeId('-starts-with-dash')).toBe(false);
  });
});

describe('MAX_STOP_PATTERN_LENGTH', () => {
  it('is 500', () => {
    expect(MAX_STOP_PATTERN_LENGTH).toBe(500);
  });
});

describe('ApiClient', () => {
  useCleanEndpointEnv();

  afterEach(() => {
    restoreFetch();
    delete process.env.CM_AUTH_TOKEN;
  });

  // Issue #1743: the host is 127.0.0.1, not localhost — resolveServerEndpoint() decides it now,
  // so the CLI dials exactly the address `status` reports (and never a localhost that resolves
  // to ::1 while the server listens on 127.0.0.1).
  it('uses default base URL with CM_PORT', () => {
    process.env.CM_PORT = '4000';
    mockFetchResponse({ data: 'test' });
    const client = new ApiClient();
    client.get('/api/test');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/api/test',
      expect.any(Object)
    );
  });

  it('uses default port 3000 when CM_PORT not set', () => {
    delete process.env.CM_PORT;
    mockFetchResponse({ data: 'test' });
    const client = new ApiClient();
    client.get('/api/test');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/test',
      expect.any(Object)
    );
  });

  it('includes Bearer token in headers', async () => {
    process.env.CM_AUTH_TOKEN = 'test-token';
    mockFetchResponse({ ok: true });
    const client = new ApiClient();
    await client.get('/api/test');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      })
    );
  });

  it('get returns parsed JSON on success', async () => {
    const data = { worktrees: [{ id: 'abc', name: 'main' }] };
    mockFetchResponse(data);
    const client = new ApiClient();
    const result = await client.get<typeof data>('/api/worktrees');
    expect(result).toEqual(data);
  });

  it('get throws ApiError on HTTP error', async () => {
    mockFetchResponse({ error: 'Not Found' }, 404);
    const client = new ApiClient();
    await expect(client.get('/api/worktrees/xyz')).rejects.toThrow(ApiError);
  });

  it('get throws ApiError on network error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const client = new ApiClient();
    await expect(client.get('/api/test')).rejects.toThrow(ApiError);
  });

  it('post sends JSON body', async () => {
    mockFetchResponse({ success: true }, 201);
    const client = new ApiClient();
    const body = { content: 'hello', cliToolId: 'claude' };
    await client.post('/api/worktrees/abc/send', body);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
      })
    );
  });

  it('post throws ApiError on HTTP error', async () => {
    mockFetchResponse({ error: 'Unauthorized' }, 401);
    const client = new ApiClient();
    await expect(client.post('/api/test', {})).rejects.toThrow(ApiError);
  });

  // Issue #1000: PATCH support for agent-instance roster mutations
  it('patch sends JSON body with method PATCH', async () => {
    mockFetchResponse({ success: true }, 200);
    const client = new ApiClient();
    const body = { agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }] };
    await client.patch('/api/worktrees/abc', body);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify(body),
      })
    );
  });

  it('patch returns parsed JSON on success', async () => {
    mockFetchResponse({ id: 'abc', agentInstances: [] });
    const client = new ApiClient();
    const result = await client.patch<{ id: string }>('/api/worktrees/abc', {});
    expect(result).toEqual({ id: 'abc', agentInstances: [] });
  });

  it('patch throws ApiError on HTTP error', async () => {
    mockFetchResponse({ error: 'Bad Request' }, 400);
    const client = new ApiClient();
    await expect(client.patch('/api/worktrees/abc', {})).rejects.toThrow(ApiError);
  });

  it('patch throws ApiError on network error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const client = new ApiClient();
    await expect(client.patch('/api/worktrees/abc', {})).rejects.toThrow(ApiError);
  });

  it('[SEC4-02] warns about HTTP to non-localhost', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CM_AUTH_TOKEN = 'test-token';
    new ApiClient({ baseUrl: 'http://192.168.1.100:3000' });
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Auth token will be sent in plaintext')
    );
    consoleSpy.mockRestore();
  });

  it('[SEC4-02] does not warn for localhost', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CM_AUTH_TOKEN = 'test-token';
    new ApiClient({ baseUrl: 'http://localhost:3000' });
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('plaintext')
    );
    consoleSpy.mockRestore();
  });

  it('[SEC4-02] does not warn for HTTPS', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CM_AUTH_TOKEN = 'test-token';
    new ApiClient({ baseUrl: 'https://remote.example.com:3000' });
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('plaintext')
    );
    consoleSpy.mockRestore();
  });
});

/**
 * Issue #1743: `commandmate status` read ~/.commandmate/.env, but ApiClient resolved from
 * process.env alone. With two servers running, `ls` (and every other ApiClient-based
 * subcommand) silently listed the worktrees of the default-port server while `status` reported
 * the .env one — enough to make cmate-orchestrate's dispatch runner conclude a freshly created
 * worktree did not exist.
 *
 * Resolution order asserted here: options.baseUrl > process.env > .env > 3000.
 */
describe('ApiClient port resolution (Issue #1743)', () => {
  // "The shell exports nothing" is the case the bug hid in, so it is the baseline here
  useCleanEndpointEnv();

  afterEach(() => {
    restoreFetch();
  });

  /** URL the client actually dialled. */
  function dialled(): string {
    return vi.mocked(global.fetch).mock.calls[0][0] as string;
  }

  it('dials the CM_PORT from ~/.commandmate/.env when the shell exports none', async () => {
    stubEnvFile({ CM_PORT: '60301' });
    mockFetchResponse({ ok: true });

    await new ApiClient().get('/api/worktrees');

    expect(dialled()).toBe('http://127.0.0.1:60301/api/worktrees');
  });

  it('lets an exported CM_PORT win over the .env value', async () => {
    // `CM_PORT=3011 commandmate ls` is documented usage: the caller is naming the target for
    // this one invocation, so the file must not override it.
    process.env.CM_PORT = '3011';
    stubEnvFile({ CM_PORT: '3000' });
    mockFetchResponse({ ok: true });

    await new ApiClient().get('/api/worktrees');

    expect(dialled()).toBe('http://127.0.0.1:3011/api/worktrees');
  });

  it('lets options.baseUrl win over both the shell and the .env', async () => {
    process.env.CM_PORT = '3011';
    stubEnvFile({ CM_PORT: '60301' });
    mockFetchResponse({ ok: true });

    await new ApiClient({ baseUrl: 'http://127.0.0.1:9999' }).get('/api/worktrees');

    expect(dialled()).toBe('http://127.0.0.1:9999/api/worktrees');
  });

  it('falls back to port 3000 when no .env exists (dotenv returns no parsed object)', async () => {
    stubEnvFile(undefined);
    mockFetchResponse({ ok: true });

    await new ApiClient().get('/api/worktrees');

    expect(dialled()).toBe('http://127.0.0.1:3000/api/worktrees');
  });

  // The old `http://localhost:${port}` ignored CM_BIND and the HTTPS pair outright; the
  // endpoint must follow the same rules `status` applies.
  describe('honours the rest of the .env endpoint configuration', () => {
    it('dials a configured CM_BIND host', async () => {
      stubEnvFile({ CM_BIND: '192.168.1.5', CM_PORT: '60301' });
      mockFetchResponse({ ok: true });

      await new ApiClient().get('/api/worktrees');

      expect(dialled()).toBe('http://192.168.1.5:60301/api/worktrees');
    });

    it('rewrites a 0.0.0.0 bind to a dialable 127.0.0.1', async () => {
      stubEnvFile({ CM_BIND: '0.0.0.0', CM_PORT: '60301' });
      mockFetchResponse({ ok: true });

      await new ApiClient().get('/api/worktrees');

      expect(dialled()).toBe('http://127.0.0.1:60301/api/worktrees');
    });

    it('uses https when both cert and key are configured', async () => {
      stubEnvFile({
        CM_PORT: '60301',
        CM_HTTPS_CERT: '/certs/localhost.pem',
        CM_HTTPS_KEY: '/certs/localhost-key.pem',
      });
      mockFetchResponse({ ok: true });

      await new ApiClient().get('/api/worktrees');

      expect(dialled()).toBe('https://127.0.0.1:60301/api/worktrees');
    });

    // server.ts serves HTTPS only when both are present, so a lone cert must stay http
    it('stays http when a cert is configured without a key', async () => {
      stubEnvFile({ CM_PORT: '60301', CM_HTTPS_CERT: '/certs/localhost.pem' });
      mockFetchResponse({ ok: true });

      await new ApiClient().get('/api/worktrees');

      expect(dialled()).toBe('http://127.0.0.1:60301/api/worktrees');
    });
  });
});

// Issue #1357: shape validation + version-skew detection
describe('assertResponseShape', () => {
  it('returns the value when all required fields are present', () => {
    const value = { agentInstances: [], id: 'wt1' };
    const result = assertResponseShape<{ agentInstances: unknown[] }>(
      value,
      ['agentInstances'],
      'GET /api/worktrees/:id'
    );
    expect(result).toBe(value);
  });

  it('treats a present-but-empty field as valid (not missing)', () => {
    // Distinguishes "field absent" (stale daemon) from "field is []" (no data).
    const value = { agentInstances: [] };
    expect(() =>
      assertResponseShape<{ agentInstances: unknown[] }>(value, ['agentInstances'], 'ctx')
    ).not.toThrow();
  });

  it('throws a version-skew ApiError when a required field is absent', () => {
    expect(() =>
      assertResponseShape<{ agentInstances: unknown[] }>({ id: 'wt1' }, ['agentInstances'], 'ctx')
    ).toThrow(/older version/);
    try {
      assertResponseShape<{ agentInstances: unknown[] }>({ id: 'wt1' }, ['agentInstances'], 'ctx');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).exitCode).toBe(ExitCode.UNEXPECTED_ERROR);
      expect((err as ApiError).message).toContain('agentInstances');
    }
  });

  it('throws when the value is not an object', () => {
    expect(() => assertResponseShape<object>(null, [], 'ctx')).toThrow(ApiError);
    expect(() => assertResponseShape<object>('nope', [], 'ctx')).toThrow(/older version/);
  });
});

describe('fetchDaemonVersion', () => {
  afterEach(() => {
    restoreFetch();
  });

  it('returns currentVersion from GET /api/app/update-check', async () => {
    mockFetchResponse({ currentVersion: '9.9.9', status: 'success' });
    const client = new ApiClient();
    await expect(fetchDaemonVersion(client)).resolves.toBe('9.9.9');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/app/update-check'),
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('returns undefined when currentVersion is absent (older daemon)', async () => {
    mockFetchResponse({ status: 'degraded' });
    const client = new ApiClient();
    await expect(fetchDaemonVersion(client)).resolves.toBeUndefined();
  });

  it('returns undefined (never throws) when the request fails', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const client = new ApiClient();
    await expect(fetchDaemonVersion(client)).resolves.toBeUndefined();
  });
});

describe('warnIfVersionSkew', () => {
  afterEach(() => {
    restoreFetch();
  });

  it('warns on stderr when the daemon version differs from the CLI', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchResponse({ currentVersion: '0.0.0-different', status: 'success' });
    const client = new ApiClient();
    await warnIfVersionSkew(client);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('0.0.0-different'));
    consoleSpy.mockRestore();
  });

  it('stays silent when the daemon version matches the CLI', async () => {
    const cliVersion = readPackageVersion();
    expect(cliVersion).toBeTruthy();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchResponse({ currentVersion: cliVersion, status: 'success' });
    const client = new ApiClient();
    await warnIfVersionSkew(client);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('stays silent when the daemon version is unknown', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchResponse({ status: 'degraded' });
    const client = new ApiClient();
    await warnIfVersionSkew(client);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

/**
 * Issue #1637: a 5xx used to reach the operator as
 * `Server error. Check server logs for details.` and nothing else.
 *
 * The cause was always in the response body — every route in this codebase
 * answers `{ error }` — and the client already read that body for its `code`.
 * It just never used the `error` field, so an initialization timeout, a failed
 * model switch and an unhandled exception all printed the same sentence. Four
 * consecutive orchestration runs hit the timeout and filed it as a session
 * race, because "check the logs" was the only thing on screen.
 */
describe('handleApiError — 5xx carries the server\'s reason (Issue #1637)', () => {
  it('surfaces the error field the server sent', () => {
    const result = handleApiError(null, 500, {
      error: 'Claude Code did not reach its input prompt within 60s (initialization timeout).',
    });

    expect(result.message).toContain('initialization timeout');
    // Still identifiable as server-side rather than a CLI-local failure.
    expect(result.message).toContain('Server error');
  });

  it('keeps the log pointer when the body explains nothing', () => {
    expect(handleApiError(null, 500).message).toBe(
      'Server error. Check server logs for details.'
    );
    expect(handleApiError(null, 500, {}).message).toBe(
      'Server error. Check server logs for details.'
    );
    expect(handleApiError(null, 500, { error: '   ' }).message).toBe(
      'Server error. Check server logs for details.'
    );
  });

  it('applies to every 5xx, including the 503 a still-starting session returns', () => {
    const result = handleApiError(null, 503, {
      error: 'Claude Code did not reach its input prompt within 60s (initialization timeout).',
      code: 'SESSION_STARTING',
    });

    expect(result.message).toContain('initialization timeout');
    expect(result.exitCode).toBe(ExitCode.UNEXPECTED_ERROR);
  });

  it('leaves the 4xx wording alone', () => {
    // These are the CLI's own, more specific messages; a server string must not
    // displace "Check the worktree ID".
    expect(handleApiError(null, 404, { error: "Worktree 'x' not found" }).message).toBe(
      'Resource not found. Check the worktree ID.'
    );
    expect(handleApiError(null, 400, { error: 'contractPath is required' }).message).toBe(
      'Bad request. Check your input parameters.'
    );
  });

  it('caps a pathological server string instead of pasting it to the terminal', () => {
    const result = handleApiError(null, 500, { error: 'x'.repeat(5000) });

    expect(result.message.length).toBeLessThan(2100);
    expect(result.message).toContain('…');
  });
});

describe('ApiClient — the reason reaches the caller (Issue #1637)', () => {
  afterEach(() => {
    restoreFetch();
    delete process.env.CM_PORT;
  });

  const TIMEOUT_BODY = {
    error:
      "Claude Code did not reach its input prompt within 60s (initialization timeout). " +
      "The tmux session 'mcbd-claude-issue-1637' and its process are still running, so " +
      'this is a slow start, not a failed one — retry the send in a few seconds.',
    code: 'SESSION_STARTING',
  };

  it('post surfaces a still-starting session end to end', async () => {
    mockFetchResponse(TIMEOUT_BODY, 503);
    const client = new ApiClient();

    const error = await client
      .post('/api/worktrees/issue-1637/send', { content: 'hello' })
      .then(() => null)
      .catch((caught: unknown) => caught as ApiError);

    // This is the string `commandmate send` prints. Before this Issue it read
    // "Server error. Check server logs for details." for the same response.
    expect(error).toBeInstanceOf(ApiError);
    expect(error?.message).toContain('initialization timeout');
    expect(error?.message).toMatch(/retry/i);
    expect(error?.statusCode).toBe(503);
    expect(error?.apiCode).toBe('SESSION_STARTING');
  });

  it('get and patch surface it too', async () => {
    mockFetchResponse({ error: 'boom: the database is locked' }, 500);
    const client = new ApiClient();
    const getError = await client
      .get('/api/worktrees')
      .then(() => null)
      .catch((caught: unknown) => caught as ApiError);
    expect(getError?.message).toContain('the database is locked');

    mockFetchResponse({ error: 'boom: the database is locked' }, 500);
    const patchError = await client
      .patch('/api/worktrees/abc', {})
      .then(() => null)
      .catch((caught: unknown) => caught as ApiError);
    expect(patchError?.message).toContain('the database is locked');
  });

  it('still reports a bodiless 5xx without inventing a cause', async () => {
    mockFetchResponse(null, 502);
    const client = new ApiClient();

    const error = await client
      .get('/api/worktrees')
      .then(() => null)
      .catch((caught: unknown) => caught as ApiError);

    expect(error?.message).toBe('Server error. Check server logs for details.');
  });
});
