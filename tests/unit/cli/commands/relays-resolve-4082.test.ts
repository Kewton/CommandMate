/**
 * `commandmate relays resolve` and the attempt id on the relay line (Issue #4082).
 *
 *  - `relays resolve <id> --payload <p> --attempt <t> --confirm|--retry|--discard`
 *    posts `{ payloadId, attemptId, action }` to `/api/relays/:id/resolve`;
 *    exactly one action is required (exit 2 otherwise, nothing sent).
 *  - A 409 refusal (stale / attempting / not allowed / no hold) exits 2 and says
 *    nothing changed. `--retry` says "queued", never "delivered".
 *  - The relay line (`relays --id`, the listing) and `--json` carry the same
 *    `attempt=` / `attemptId` as the server sent; an older server sends none.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  vi.unstubAllEnvs();
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const RELAY_ID = '11111111-2222-4333-8444-555555555555';
const PAYLOAD_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const ATTEMPT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

const HELD_RELAY = {
  id: RELAY_ID,
  state: 'pending',
  from: { worktreeId: 'wt-a', instanceId: 'claude' },
  to: { worktreeId: 'wt-b', instanceId: 'codex' },
  hops: 1,
  expiresAt: 1_800_000_000_000,
  deliveryHold: {
    state: 'uncertain',
    payloadId: PAYLOAD_ID,
    attemptId: ATTEMPT_ID,
    kind: 'reply',
    reason: 'submit-unconfirmed',
    at: 1_800_000_000_000,
    checkCommand: 'commandmate capture wt-a --instance claude --pane',
  },
};

interface Route {
  match: string;
  method: string;
  response: { status: number; data: unknown };
}

function mockRoutes(routes: Route[]) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const all = [...routes].sort((a, b) => b.match.length - a.match.length);
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      method,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
    const route = all.find((candidate) => url.includes(candidate.match) && candidate.method === method);
    if (!route) return Promise.reject(new Error(`unexpected request: ${method} ${url}`));
    const { status, data } = route.response;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      redirected: false,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }) as unknown as typeof fetch;
  return calls;
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

async function runUntilExit(run: () => Promise<void>): Promise<number | undefined> {
  let firstCode: number | undefined;
  mockExit.mockImplementation(((code?: number) => {
    const resolved = typeof code === 'number' ? code : 0;
    if (firstCode === undefined) firstCode = resolved;
    throw new ExitSignal(resolved);
  }) as never);
  try {
    await run();
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    mockExit.mockImplementation((() => {}) as never);
  }
  return firstCode;
}

async function runRelays(argv: string[]): Promise<void> {
  const { createRelaysCommand } = await import('../../../../src/cli/commands/relays');
  const cmd = createRelaysCommand();
  cmd.exitOverride();
  for (const sub of cmd.commands) sub.exitOverride();
  await cmd.parseAsync(['node', 'relays', ...argv]);
}

const stderr = (): string => mockConsoleError.mock.calls.flat().join('\n');
const resolveCalls = (calls: ReturnType<typeof mockRoutes>) => calls.filter((c) => c.url.includes('/resolve'));

function resolveRoute(status: number, data: unknown): Route {
  return { match: `/api/relays/${RELAY_ID}/resolve`, method: 'POST', response: { status, data } };
}

describe('relays resolve (Issue #4082)', () => {
  for (const action of ['confirm', 'retry', 'discard'] as const) {
    it(`--${action} posts the payload, the attempt and the action`, async () => {
      const calls = mockRoutes([
        resolveRoute(200, { relay: { ...HELD_RELAY, deliveryHold: null, state: action === 'confirm' ? 'delivered' : 'pending' }, action, requeued: action === 'retry', promoted: false }),
      ]);
      await runRelays(['resolve', RELAY_ID, '--payload', PAYLOAD_ID, '--attempt', ATTEMPT_ID, `--${action}`]);
      expect(resolveCalls(calls)).toHaveLength(1);
      expect(resolveCalls(calls)[0].body).toEqual({ payloadId: PAYLOAD_ID, attemptId: ATTEMPT_ID, action });
      expect(mockExit).not.toHaveBeenCalled();
    });
  }

  it('--retry says queued, not delivered', async () => {
    mockRoutes([resolveRoute(200, { relay: { ...HELD_RELAY, deliveryHold: null }, action: 'retry', requeued: true, promoted: false })]);
    await runRelays(['resolve', RELAY_ID, '--payload', PAYLOAD_ID, '--attempt', ATTEMPT_ID, '--retry']);
    expect(stderr()).toContain('queued for delivery again (not delivered yet)');
  });

  it('--json prints the server answer as is', async () => {
    const answer = { relay: { ...HELD_RELAY, deliveryHold: null }, action: 'discard', requeued: false, promoted: false };
    mockRoutes([resolveRoute(200, answer)]);
    await runRelays(['resolve', RELAY_ID, '--payload', PAYLOAD_ID, '--attempt', ATTEMPT_ID, '--discard', '--json']);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0][0]))).toEqual(answer);
  });

  it('no action, or two: exit 2 and nothing is sent', async () => {
    for (const actions of [[], ['--confirm', '--retry'], ['--confirm', '--retry', '--discard']]) {
      const calls = mockRoutes([]);
      const code = await runUntilExit(() =>
        runRelays(['resolve', RELAY_ID, '--payload', PAYLOAD_ID, '--attempt', ATTEMPT_ID, ...actions])
      );
      expect(code).toBe(2);
      expect(resolveCalls(calls)).toHaveLength(0);
    }
  });

  it('a malformed relay id: exit 2, nothing sent', async () => {
    const calls = mockRoutes([]);
    expect(await runUntilExit(() => runRelays(['resolve', 'nope', '--payload', PAYLOAD_ID, '--attempt', ATTEMPT_ID, '--confirm']))).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('--payload and --attempt are required', async () => {
    const calls = mockRoutes([]);
    await expect(runRelays(['resolve', RELAY_ID, '--attempt', ATTEMPT_ID, '--confirm'])).rejects.toThrow();
    await expect(runRelays(['resolve', RELAY_ID, '--payload', PAYLOAD_ID, '--confirm'])).rejects.toThrow();
    expect(resolveCalls(calls)).toHaveLength(0);
  });

  for (const code of ['RELAY_HOLD_STALE', 'RELAY_HOLD_ATTEMPTING', 'RELAY_HOLD_NOT_ALLOWED', 'RELAY_HOLD_NOT_FOUND']) {
    it(`409 ${code}: exit 2, says nothing changed and how to read it again`, async () => {
      mockRoutes([resolveRoute(409, { error: 'refused for a reason', code })]);
      const exit = await runUntilExit(() =>
        runRelays(['resolve', RELAY_ID, '--payload', PAYLOAD_ID, '--attempt', ATTEMPT_ID, '--confirm'])
      );
      expect(exit).toBe(2);
      expect(stderr()).toContain('refused for a reason');
      expect(stderr()).toContain(`commandmate relays --id ${RELAY_ID}`);
    });
  }
});

describe('the attempt id on the relay line (Issue #4082)', () => {
  it('relays --id prints attempt=<id>, and --json carries attemptId unchanged', async () => {
    mockRoutes([{ match: `/api/relays/${RELAY_ID}`, method: 'GET', response: { status: 200, data: { relay: HELD_RELAY } } }]);
    await runRelays(['--id', RELAY_ID]);
    const line = String(mockConsoleLog.mock.calls[0][0]);
    expect(line).toContain(`payload=reply:${PAYLOAD_ID}`);
    expect(line).toContain(`attempt=${ATTEMPT_ID}`);

    mockConsoleLog.mockClear();
    await runRelays(['--id', RELAY_ID, '--json']);
    const json = JSON.parse(String(mockConsoleLog.mock.calls[0][0])) as { relay: { deliveryHold: { attemptId: string } } };
    expect(json.relay.deliveryHold.attemptId).toBe(ATTEMPT_ID);
  });

  it('the listing\'s held section prints the same attempt', async () => {
    mockRoutes([
      {
        match: '/api/capabilities',
        method: 'GET',
        response: { status: 200, data: { serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] } },
      },
      {
        match: '/api/worktrees/wt-a/resolve-target',
        method: 'GET',
        response: { status: 200, data: { cliToolId: 'claude', instanceId: 'claude', resolvedBy: 'server', conflict: null } },
      },
      {
      match: '/api/relays?',
      method: 'GET',
      response: {
        status: 200,
        data: {
          owed: [], awaiting: [], open: [], held: [HELD_RELAY],
          counts: { pending: 1, delivered: 0, prompt: 0, expired: 0, cancelled: 0 },
        },
      },
    }]);
    await runRelays(['--worktree', 'wt-a']);
    const lines = mockConsoleLog.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes(`attempt=${ATTEMPT_ID}`))).toBe(true);
  });

  it('negative control: an older server without attemptId prints no attempt= field', async () => {
    const { attemptId: _omitted, ...olderHold } = HELD_RELAY.deliveryHold;
    void _omitted;
    mockRoutes([{
      match: `/api/relays/${RELAY_ID}`,
      method: 'GET',
      response: { status: 200, data: { relay: { ...HELD_RELAY, deliveryHold: olderHold } } },
    }]);
    await runRelays(['--id', RELAY_ID]);
    const line = String(mockConsoleLog.mock.calls[0][0]);
    expect(line).toContain('delivery=uncertain');
    expect(line).not.toContain('attempt=');
  });
});

describe('--token / --json given to the parent `relays` reach resolve and cancel (Issue #4082)', () => {
  const ok = resolveRoute(200, { relay: { ...HELD_RELAY, deliveryHold: null }, action: 'confirm', requeued: false, promoted: false });
  const cancelRoute: Route = {
    match: `/api/relays/${RELAY_ID}/cancel`,
    method: 'POST',
    response: { status: 200, data: { relay: { ...HELD_RELAY, state: 'cancelled' } } },
  };
  const args = ['resolve', RELAY_ID, '--payload', PAYLOAD_ID, '--attempt', ATTEMPT_ID, '--confirm'];
  const authOf = (call: { headers: Record<string, string> } | undefined) => call?.headers.Authorization;

  it('relays --token T resolve …: the request carries T, not CM_AUTH_TOKEN', async () => {
    vi.stubEnv('CM_AUTH_TOKEN', 'from-env');
    const calls = mockRoutes([ok]);
    await runRelays(['--token', 'from-flag', ...args]);
    expect(resolveCalls(calls)).toHaveLength(1);
    expect(authOf(resolveCalls(calls)[0])).toBe('Bearer from-flag');
  });

  it('relays resolve … --token T: the request carries T', async () => {
    vi.stubEnv('CM_AUTH_TOKEN', 'from-env');
    const calls = mockRoutes([ok]);
    await runRelays([...args, '--token', 'from-flag']);
    expect(authOf(resolveCalls(calls)[0])).toBe('Bearer from-flag');
  });

  it('relays --token T cancel <id>: the request carries T', async () => {
    vi.stubEnv('CM_AUTH_TOKEN', 'from-env');
    const calls = mockRoutes([cancelRoute]);
    await runRelays(['--token', 'from-flag', 'cancel', RELAY_ID]);
    const cancel = calls.filter((c) => c.url.includes('/cancel'));
    expect(cancel).toHaveLength(1);
    expect(authOf(cancel[0])).toBe('Bearer from-flag');
  });

  it('relays cancel <id> --json prints the server answer as JSON', async () => {
    mockRoutes([cancelRoute]);
    await runRelays(['cancel', RELAY_ID, '--json']);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toEqual(cancelRoute.response.data);
    expect(stderr()).not.toContain(`Relay ${RELAY_ID} cancelled.`);
  });

  it('negative control: no --token anywhere falls back to CM_AUTH_TOKEN, and cancel without --json prints the line', async () => {
    vi.stubEnv('CM_AUTH_TOKEN', 'from-env');
    const calls = mockRoutes([ok, cancelRoute]);
    await runRelays(args);
    expect(authOf(resolveCalls(calls)[0])).toBe('Bearer from-env');
    await runRelays(['cancel', RELAY_ID]);
    expect(authOf(calls.find((c) => c.url.includes('/cancel')))).toBe('Bearer from-env');
    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(stderr()).toContain(`Relay ${RELAY_ID} cancelled.`);
  });
});
