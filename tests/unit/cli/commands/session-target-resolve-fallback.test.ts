/**
 * CLI capability probe and the client-fallback path (Issue #1925, S12 / DR4-007).
 *
 * The CLI is routinely newer than the daemon it talks to, so delegating
 * resolution to a server endpoint needs an answer to "what if the server does
 * not have it?". The tempting answer — "if the call fails, resolve locally" —
 * is the one the design forbids, because the local path is a DEGRADED resolver:
 * it has no primary-anchor stage (design §4 D5 決定 1), so it can send a message
 * to a different instance than the server would have chosen. Letting an
 * unauthenticated 302, a proxy's HTML, or a 500 open that door means the
 * destination of `send` and `respond` changes exactly when something in the
 * path is misbehaving — and a caller who controls the middlebox can arrange it.
 *
 * So the probe classifies, and only one branch degrades:
 *
 *   200 + JSON + capabilities array -> delegate to the server
 *   404 + empty or JSON body        -> old server: resolve locally, warn
 *   401 / 403                       -> auth error; stop
 *   3xx / HTML / unparseable        -> cannot classify; stop
 *
 * The last test pins the other half of DR2-008: the fallback is a compatibility
 * path, not a second implementation to grow. It must stay two stages.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient, ApiError } from '@/cli/utils/api-client';
import { resolveSessionTarget } from '@/cli/utils/session-target';
import { resetServerCapabilityProbe } from '@/cli/utils/server-capabilities';
import { ExitCode } from '@/cli/types';

const originalFetch = global.fetch;
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

interface Reply {
  status: number;
  /** Raw body. Omitted means an empty body, which `json()` then refuses. */
  body?: string;
  /** `null` omits the header entirely — what a bare proxy 404 looks like. */
  contentType?: string | null;
  redirected?: boolean;
}

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

function mockServer(handler: (url: string) => Reply): Recorded[] {
  const calls: Recorded[] = [];
  global.fetch = vi.fn((url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = handler(String(url));
    const headers = new Headers();
    if (reply.contentType !== null) {
      headers.set('content-type', reply.contentType ?? 'application/json');
    }
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      redirected: reply.redirected ?? false,
      headers,
      json: () =>
        reply.body === undefined
          ? Promise.reject(new SyntaxError('Unexpected end of JSON input'))
          : Promise.resolve(JSON.parse(reply.body)),
      text: () => Promise.resolve(reply.body ?? ''),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return calls;
}

const CAPABLE: Reply = {
  status: 200,
  body: JSON.stringify({ serverVersion: '1.2.3', capabilities: ['resolve-session-target'] }),
};

/** Roster shape of GET /api/worktrees/:id, the only call the fallback makes. */
function rosterReply(instances: Array<{ id: string; cliTool: string }>): Reply {
  return {
    status: 200,
    body: JSON.stringify({
      id: 'wt1',
      agentInstances: instances.map((inst, order) => ({ ...inst, alias: inst.id, order })),
    }),
  };
}

function client(): ApiClient {
  return new ApiClient({ baseUrl: 'http://localhost:3000' });
}

beforeEach(() => {
  resetServerCapabilityProbe();
  mockConsoleError.mockClear();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('the capability probe itself', () => {
  it('asks for JSON and refuses to follow a redirect', async () => {
    const calls = mockServer((url) =>
      url.includes('/api/capabilities')
        ? CAPABLE
        : { status: 200, body: JSON.stringify({ cliToolId: 'codex', instanceId: 'codex', resolvedBy: 'roster', conflict: null }) }
    );

    await resolveSessionTarget(client(), 'wt1', { instanceId: 'codex' });

    const probe = calls.find((c) => c.url.includes('/api/capabilities'));
    expect(probe).toBeDefined();
    expect((probe?.init?.headers as Record<string, string>)?.Accept).toBe('application/json');
    expect(probe?.init?.redirect).toBe('manual');
  });

  it('probes once per client, however many targets it resolves', async () => {
    const calls = mockServer((url) =>
      url.includes('/api/capabilities')
        ? CAPABLE
        : { status: 200, body: JSON.stringify({ cliToolId: 'codex', instanceId: 'codex', resolvedBy: 'roster', conflict: null }) }
    );

    const shared = client();
    await resolveSessionTarget(shared, 'wt1', { instanceId: 'codex' });
    await resolveSessionTarget(shared, 'wt1', { instanceId: 'codex' });

    expect(calls.filter((c) => c.url.includes('/api/capabilities'))).toHaveLength(1);
  });
});

describe('a server that declares the capability', () => {
  it('delegates and never reads the roster itself', async () => {
    const calls = mockServer((url) =>
      url.includes('/api/capabilities')
        ? CAPABLE
        : { status: 200, body: JSON.stringify({ cliToolId: 'opencode', instanceId: 'worker-a', resolvedBy: 'roster', conflict: null }) }
    );

    const target = await resolveSessionTarget(client(), 'wt1', { instanceId: 'worker-a' });

    expect(target).toEqual({
      cliToolId: 'opencode',
      instanceId: 'worker-a',
      resolvedBy: 'roster',
      conflict: null,
    });
    expect(calls.map((c) => c.url)).toEqual([
      expect.stringContaining('/api/capabilities'),
      expect.stringContaining('/resolve-target'),
    ]);
    expect(mockConsoleError).not.toHaveBeenCalled();
  });
});

describe('a real 404 — the one branch that degrades', () => {
  const notFoundBodies: Array<[string, Reply]> = [
    ['an empty body', { status: 404, contentType: null }],
    ["Next.js's JSON 404", { status: 404, body: JSON.stringify({ error: 'Not Found' }) }],
  ];

  it.each(notFoundBodies)('treats %s as an old server and resolves locally', async (_name, reply) => {
    mockServer((url) => (url.includes('/api/capabilities') ? reply : rosterReply([{ id: 'codex', cliTool: 'codex' }])));

    const target = await resolveSessionTarget(client(), 'wt1', { instanceId: 'codex' });

    expect(target).toMatchObject({ cliToolId: 'codex', resolvedBy: 'client-fallback' });
  });

  /** §10.6 item 6: a degraded resolution is never silent. */
  it('warns on stderr, naming the degradation and the fix', async () => {
    mockServer((url) =>
      url.includes('/api/capabilities')
        ? { status: 404, contentType: null }
        : rosterReply([{ id: 'codex', cliTool: 'codex' }])
    );

    await resolveSessionTarget(client(), 'wt1', { instanceId: 'codex' });

    const warnings = mockConsoleError.mock.calls.map((c) => String(c[0]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('client-fallback');
    expect(warnings[0]).toContain('commandmate stop && commandmate start');
  });

  /**
   * DR2-008. The compatibility path deliberately lacks the primary-anchor stage
   * — implementing it here would be growing the second authority back, which is
   * the whole reason resolution moved to the server. An unregistered `opencode`
   * therefore resolves to nothing, and the old server applies its own default,
   * exactly as it did before this Issue.
   */
  it('does not grow the primary-anchor stage the server has', async () => {
    mockServer((url) =>
      url.includes('/api/capabilities')
        ? { status: 404, contentType: null }
        : rosterReply([])
    );

    const target = await resolveSessionTarget(client(), 'wt1', { instanceId: 'opencode' });

    expect(target.cliToolId).toBeUndefined();
    expect(target.resolvedBy).toBe('client-fallback');
  });
});

describe('responses that must NOT degrade (S12)', () => {
  const refused: Array<[string, Reply]> = [
    ['401 Unauthorized', { status: 401, body: JSON.stringify({ error: 'Unauthorized' }) }],
    ['403 Forbidden', { status: 403, body: JSON.stringify({ error: 'Forbidden' }) }],
    ['302 to /login', { status: 302, contentType: null }],
    ['a followed redirect carrying a plausible body', { status: 200, body: CAPABLE.body, contentType: 'application/json', redirected: true }],
    ['an HTML 200 from a proxy', { status: 200, body: '<!doctype html>', contentType: 'text/html' }],
    ['a JSON body served as HTML', { status: 200, body: CAPABLE.body, contentType: 'text/html' }],
    ['an HTML 404 from a proxy', { status: 404, body: '<!doctype html><p>nope</p>', contentType: 'text/html' }],
    ['a 200 whose body is not JSON', { status: 200, body: 'not json at all' }],
    ['a 200 with no capabilities array', { status: 200, body: JSON.stringify({ serverVersion: '1.2.3' }) }],
    ['a 500', { status: 500, body: JSON.stringify({ error: 'boom' }) }],
  ];

  it.each(refused)('refuses to resolve after %s', async (_name, reply) => {
    const calls = mockServer((url) => (url.includes('/api/capabilities') ? reply : rosterReply([])));

    await expect(
      resolveSessionTarget(client(), 'wt1', { instanceId: 'codex' })
    ).rejects.toBeInstanceOf(ApiError);

    // The point: nothing after the probe. No roster read, no resolve, and above
    // all no locally-resolved target handed back to a caller about to send.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/capabilities');
  });

  it('refuses after a network error rather than assuming an old server', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed')) as unknown as typeof fetch;

    await expect(
      resolveSessionTarget(client(), 'wt1', { instanceId: 'codex' })
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('reports an auth failure as an auth failure, not as an unknown server', async () => {
    mockServer(() => ({ status: 401, body: JSON.stringify({ error: 'Unauthorized' }) }));

    const error = await resolveSessionTarget(client(), 'wt1', { instanceId: 'codex' }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('CM_AUTH_TOKEN');
    expect((error as ApiError).exitCode).toBe(ExitCode.CONFIG_ERROR);
  });

  it('says it could not determine capabilities when a middlebox answered', async () => {
    mockServer(() => ({ status: 200, body: '<!doctype html>', contentType: 'text/html' }));

    const error = await resolveSessionTarget(client(), 'wt1', { instanceId: 'codex' }).catch((e) => e);

    expect((error as ApiError).message).toContain('Could not determine');
    expect((error as ApiError).message).toContain('/api/capabilities');
  });

  /**
   * The reason each branch is asserted by MESSAGE and not merely by "it threw":
   * a 3xx also fails the `response.ok` check further down, so a test that only
   * demands an ApiError stays green with the redirect branch deleted. Naming
   * the verdict is what makes the branch's absence visible — and the redirect
   * branch is the one that keeps an unauthenticated CLI from reading /login's
   * HTML as a server that has no opinion.
   */
  it.each([
    ['a 3xx', { status: 302, contentType: null } as Reply],
    [
      'a response that was followed to its destination',
      { status: 200, body: CAPABLE.body, contentType: 'application/json', redirected: true } as Reply,
    ],
  ])('classifies %s as undeterminable rather than as any other failure', async (_name, reply) => {
    mockServer(() => reply);

    const error = await resolveSessionTarget(client(), 'wt1', { instanceId: 'codex' }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('Could not determine');
  });

  /**
   * Isolates the content-type check: the body here parses as the exact JSON a
   * capable server sends, so only the declared type separates "the server
   * answered" from "something on the way answered".
   */
  it('does not accept a capable-looking body that was not served as JSON', async () => {
    mockServer(() => ({ status: 200, body: CAPABLE.body, contentType: 'text/html' }));

    const error = await resolveSessionTarget(client(), 'wt1', { instanceId: 'codex' }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('Could not determine');
  });
});
