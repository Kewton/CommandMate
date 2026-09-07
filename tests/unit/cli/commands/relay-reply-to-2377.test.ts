/**
 * `send --reply-to` / `ask --async` / `relays` (Issue #2377).
 *
 * Three properties the delegation depends on, and each is written so a plausible
 * wrong implementation fails it:
 *
 *  1. **The ledger row exists before the message does.** A worker that answers
 *     instantly must not finish its turn in the window between the send and the
 *     relay, because the completion trigger reads the ledger and a row that is
 *     not there yet is a reply nobody collects. Asserted on request ORDER.
 *  2. **A refused relay sends nothing** and exits 2 — the Issue's own acceptance
 *     condition for the loop guard.
 *  3. **A send that failed withdraws the relay**, so nobody waits 24h for a turn
 *     that was never started.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const RELAY_ID = '11111111-2222-4333-8444-555555555555';

interface RouteResponse {
  status: number;
  data: unknown;
}

interface Route {
  match: string;
  method?: string;
  response: RouteResponse;
}

const CAPABILITIES_ROUTE: Route = {
  match: '/api/capabilities',
  method: 'GET',
  response: {
    status: 200,
    data: { serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] },
  },
};

/**
 * `resolve-target` for ONE worktree.
 *
 * Per-worktree rather than one catch-all route, because both ends of a relay
 * resolve through this endpoint and a shared answer would let a command that
 * resolved the wrong end pass — which is precisely the mistake #1925 was about.
 */
function resolveTargetRoute(worktreeId: string, instanceId: string, cliToolId: string): Route {
  return {
    match: `/api/worktrees/${worktreeId}/resolve-target`,
    method: 'GET',
    response: {
      status: 200,
      data: { cliToolId, instanceId, resolvedBy: 'server', conflict: null },
    },
  };
}

/** The pair a `wt-a@claude` ← `wt-b` delegation resolves. */
const RESOLVE_BOTH_ENDS: Route[] = [
  resolveTargetRoute('wt-a', 'claude', 'claude'),
  resolveTargetRoute('wt-b', 'codex', 'codex'),
];

const RELAY_CREATED: Route = {
  match: '/api/relays',
  method: 'POST',
  response: { status: 201, data: { relay: { id: RELAY_ID, state: 'pending' } } },
};

const SEND_OK: Route = {
  match: '/send',
  method: 'POST',
  response: { status: 201, data: { id: 'm1', role: 'user', content: 'hi' } },
};

function mockRoutes(routes: Route[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const all = [CAPABILITIES_ROUTE, ...routes];
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!url.includes('/api/capabilities')) {
      calls.push({
        url,
        method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
    }
    const route = all.find(
      (candidate) =>
        url.includes(candidate.match) && (candidate.method ?? 'POST').toUpperCase() === method
    );
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

async function runUntilExit(
  run: () => Promise<void>
): Promise<number | undefined> {
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

async function runSend(argv: string[]): Promise<void> {
  const { createSendCommand } = await import('../../../../src/cli/commands/send');
  await createSendCommand().parseAsync(['node', 'send', ...argv]);
}

async function runAsk(argv: string[]): Promise<void> {
  const { createAskCommand } = await import('../../../../src/cli/commands/ask');
  await createAskCommand().parseAsync(['node', 'ask', ...argv]);
}

async function runRelays(argv: string[]): Promise<void> {
  const { createRelaysCommand } = await import('../../../../src/cli/commands/relays');
  await createRelaysCommand().parseAsync(['node', 'relays', ...argv]);
}

describe('send --reply-to', () => {
  it('registers the relay BEFORE the message goes out', async () => {
    const calls = mockRoutes([...RESOLVE_BOTH_ENDS, RELAY_CREATED, SEND_OK]);

    await runSend(['wt-b', 'do the thing', '--reply-to', 'wt-a@claude']);

    const relayIndex = calls.findIndex((c) => c.url.includes('/api/relays'));
    const sendIndex = calls.findIndex((c) => c.url.includes('/send'));
    expect(relayIndex).toBeGreaterThanOrEqual(0);
    expect(sendIndex).toBeGreaterThanOrEqual(0);
    expect(relayIndex).toBeLessThan(sendIndex);
  });

  it('names the requester as `from` and the worker as `to`, both resolved', async () => {
    const calls = mockRoutes([...RESOLVE_BOTH_ENDS, RELAY_CREATED, SEND_OK]);

    await runSend(['wt-b', 'do the thing', '--reply-to', 'wt-a@claude']);

    const relayCall = calls.find((c) => c.url.includes('/api/relays'));
    expect(relayCall?.body).toEqual({
      from: { worktreeId: 'wt-a', instanceId: 'claude' },
      to: { worktreeId: 'wt-b', instanceId: 'codex' },
      allowRelayChain: false,
    });
  });

  it('passes --allow-relay-chain through', async () => {
    const calls = mockRoutes([...RESOLVE_BOTH_ENDS, RELAY_CREATED, SEND_OK]);

    await runSend([
      'wt-b',
      'do the thing',
      '--reply-to',
      'wt-a@claude',
      '--allow-relay-chain',
    ]);

    const relayCall = calls.find((c) => c.url.includes('/api/relays'));
    expect((relayCall?.body as { allowRelayChain: boolean }).allowRelayChain).toBe(true);
  });

  it('exits 2 and sends nothing when the chain is refused', async () => {
    const calls = mockRoutes([
      ...RESOLVE_BOTH_ENDS,
      {
        match: '/api/relays',
        method: 'POST',
        response: {
          status: 409,
          data: {
            error: 'The last message this session was given arrived over a relay',
            code: 'RELAY_CHAIN_BLOCKED',
          },
        },
      },
      SEND_OK,
    ]);

    const code = await runUntilExit(() =>
      runSend(['wt-b', 'do the thing', '--reply-to', 'wt-a@claude'])
    );

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(calls.some((c) => c.url.includes('/send'))).toBe(false);
    expect(mockConsoleError.mock.calls.flat().join('\n')).toContain('arrived over a relay');
  });

  it('exits 2 when the hop limit is refused', async () => {
    mockRoutes([
      ...RESOLVE_BOTH_ENDS,
      {
        match: '/api/relays',
        method: 'POST',
        response: {
          status: 409,
          data: { error: 'Relay chains stop at 3 hops', code: 'RELAY_HOPS_EXCEEDED' },
        },
      },
    ]);

    const code = await runUntilExit(() =>
      runSend(['wt-b', 'x', '--reply-to', 'wt-a@claude', '--allow-relay-chain'])
    );

    expect(code).toBe(ExitCode.CONFIG_ERROR);
  });

  it('withdraws the relay when the message could not be sent', async () => {
    const calls = mockRoutes([
      ...RESOLVE_BOTH_ENDS,
      RELAY_CREATED,
      {
        match: '/send',
        method: 'POST',
        response: {
          status: 409,
          data: { error: 'wt-b is waiting on a prompt', code: 'PROMPT_WAITING' },
        },
      },
      {
        match: `/api/relays/${RELAY_ID}/cancel`,
        method: 'POST',
        response: { status: 200, data: { relay: { id: RELAY_ID, state: 'cancelled' } } },
      },
    ]);

    await runUntilExit(() => runSend(['wt-b', 'x', '--reply-to', 'wt-a@claude']));

    expect(calls.some((c) => c.url.includes(`/api/relays/${RELAY_ID}/cancel`))).toBe(true);
  });

  it('opens no relay at all without --reply-to', async () => {
    const calls = mockRoutes([SEND_OK]);

    await runSend(['wt-b', 'do the thing']);

    expect(calls.some((c) => c.url.includes('/api/relays'))).toBe(false);
  });

  it('keeps the relay id off stdout, which --contract owns', async () => {
    mockRoutes([...RESOLVE_BOTH_ENDS, RELAY_CREATED, SEND_OK]);

    await runSend(['wt-b', 'do the thing', '--reply-to', 'wt-a@claude']);

    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockConsoleError.mock.calls.flat().join('\n')).toContain(RELAY_ID);
  });
});

describe('ask --async', () => {
  it('prints the relay id on stdout and never waits', async () => {
    const calls = mockRoutes([...RESOLVE_BOTH_ENDS, RELAY_CREATED, SEND_OK]);

    await runUntilExit(() =>
      runAsk(['wt-b', 'do the thing', '--async', '--reply-to', 'wt-a@claude'])
    );

    expect(mockConsoleLog).toHaveBeenCalledWith(RELAY_ID);
    // `wait`'s poller reads the worktree list; an async ask must not.
    expect(calls.some((c) => c.url.includes('/api/worktrees?'))).toBe(false);
  });

  it('exits 0', async () => {
    mockRoutes([...RESOLVE_BOTH_ENDS, RELAY_CREATED, SEND_OK]);

    const code = await runUntilExit(() =>
      runAsk(['wt-b', 'x', '--async', '--reply-to', 'wt-a@claude'])
    );

    expect(code).toBe(ExitCode.SUCCESS);
  });

  it('refuses --reply-to without --async', async () => {
    mockRoutes([]);

    const code = await runUntilExit(() => runAsk(['wt-b', 'x', '--reply-to', 'wt-a@claude']));

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(mockConsoleError.mock.calls.flat().join('\n')).toContain('require --async');
  });
});

describe('relays cancel', () => {
  it('rejects an id that was never a relay id', async () => {
    mockRoutes([]);

    const code = await runUntilExit(() => runRelays(['cancel', 'not-a-uuid']));

    expect(code).toBe(ExitCode.CONFIG_ERROR);
  });

  it('reports an already-closed relay as an error rather than a success', async () => {
    mockRoutes([
      {
        match: `/api/relays/${RELAY_ID}/cancel`,
        method: 'POST',
        response: {
          status: 409,
          data: { error: 'Relay is already delivered', code: 'RELAY_ALREADY_CLOSED' },
        },
      },
    ]);

    const code = await runUntilExit(() => runRelays(['cancel', RELAY_ID]));

    expect(code).toBe(ExitCode.CONFIG_ERROR);
    expect(mockConsoleError.mock.calls.flat().join('\n')).toContain('already delivered');
  });

  it('cancels a live relay', async () => {
    const calls = mockRoutes([
      {
        match: `/api/relays/${RELAY_ID}/cancel`,
        method: 'POST',
        response: { status: 200, data: { relay: { id: RELAY_ID, state: 'cancelled' } } },
      },
    ]);

    await runRelays(['cancel', RELAY_ID]);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
  });
});
