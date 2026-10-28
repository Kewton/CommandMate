/**
 * The CLI half of the bound relay (Issue #3957, PR 2).
 *
 *  - `send --reply-to` / `ask --async` ask for `bind: true` and put the relay
 *    id on the send only when the server answered `bindMode: 'bound'`; an older
 *    server gets one stderr line and the legacy send.
 *  - The relay is withdrawn only on a confirmed `not_sent`. A 409 bind conflict
 *    belongs to another attempt; `unknown` is left open with a notice; a lost
 *    answer is looked up with `GET /api/relays/:id` and the message is never
 *    sent a second time.
 *  - `relays --id` shows one relay, closed or not.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';

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

interface Route {
  match: string;
  method?: string;
  response: { status: number; data: unknown } | 'network-error';
}

function resolveTargetRoute(worktreeId: string, instanceId: string, cliToolId: string): Route {
  return {
    match: `/api/worktrees/${worktreeId}/resolve-target`,
    method: 'GET',
    response: { status: 200, data: { cliToolId, instanceId, resolvedBy: 'server', conflict: null } },
  };
}

const BASE: Route[] = [
  {
    match: '/api/capabilities',
    method: 'GET',
    response: { status: 200, data: { serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] } },
  },
  resolveTargetRoute('wt-a', 'claude', 'claude'),
  resolveTargetRoute('wt-b', 'codex', 'codex'),
];

const RELAY_BOUND: Route = {
  match: '/api/relays',
  method: 'POST',
  response: { status: 201, data: { relay: { id: RELAY_ID, state: 'pending', bindMode: 'bound' }, bindMode: 'bound' } },
};
const RELAY_LEGACY_SERVER: Route = {
  match: '/api/relays',
  method: 'POST',
  response: { status: 201, data: { relay: { id: RELAY_ID, state: 'pending' } } },
};
const CANCEL: Route = {
  match: `/api/relays/${RELAY_ID}/cancel`,
  method: 'POST',
  response: { status: 200, data: { relay: { id: RELAY_ID, state: 'cancelled' } } },
};

function sendRoute(response: Route['response']): Route {
  return { match: '/send', method: 'POST', response };
}

function relayLookup(sendState: string): Route {
  return {
    match: `/api/relays/${RELAY_ID}`,
    method: 'GET',
    response: { status: 200, data: { relay: { id: RELAY_ID, state: 'pending', sendState } } },
  };
}

function mockRoutes(routes: Route[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  // Most specific first: `/api/relays/<id>/cancel` before `/api/relays`.
  const all = [...BASE, ...routes].sort((a, b) => b.match.length - a.match.length);
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!url.includes('/api/capabilities')) {
      calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    }
    const route = all.find(
      (candidate) => url.includes(candidate.match) && (candidate.method ?? 'POST').toUpperCase() === method
    );
    if (!route) return Promise.reject(new Error(`unexpected request: ${method} ${url}`));
    if (route.response === 'network-error') {
      return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
    }
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

const stderr = (): string => mockConsoleError.mock.calls.flat().join('\n');
const sends = (calls: ReturnType<typeof mockRoutes>) => calls.filter((c) => c.url.includes('/send'));
const cancelled = (calls: ReturnType<typeof mockRoutes>) => calls.some((c) => c.url.includes('/cancel'));

describe('bind negotiation (Issue #3957)', () => {
  it('asks for bind: true and puts the relay id on the send when the server confirms it', async () => {
    const calls = mockRoutes([
      RELAY_BOUND,
      sendRoute({ status: 201, data: { id: 'm1', role: 'user', content: 'x', sendOutcome: 'sent' } }),
    ]);
    await runSend(['wt-b', 'do it', '--reply-to', 'wt-a@claude']);

    expect(calls.find((c) => c.url.endsWith('/api/relays'))?.body).toMatchObject({ bind: true });
    expect(sends(calls)[0].body).toMatchObject({ content: 'do it', relayId: RELAY_ID });
    expect(stderr()).not.toContain('legacy handling');
  });

  it('an older server (no bindMode in the answer): one stderr line, no relay id on the send', async () => {
    const calls = mockRoutes([RELAY_LEGACY_SERVER, sendRoute({ status: 201, data: { id: 'm1', role: 'user', content: 'x' } })]);
    await runUntilExit(() => runAsk(['wt-b', 'do it', '--async', '--reply-to', 'wt-a@claude']));

    expect(sends(calls)[0].body).not.toHaveProperty('relayId');
    expect(mockConsoleError.mock.calls.filter((c) => String(c[0]).includes('legacy handling'))).toHaveLength(1);
  });
});

describe('what a failed send does to a bound relay', () => {
  it('negative control — a legacy relay is withdrawn on any failure, as before', async () => {
    const calls = mockRoutes([
      RELAY_LEGACY_SERVER,
      sendRoute({ status: 500, data: { error: 'boom' } }),
      CANCEL,
    ]);
    await runUntilExit(() => runSend(['wt-b', 'x', '--reply-to', 'wt-a@claude']));
    expect(cancelled(calls)).toBe(true);
  });

  it('not_sent: withdrawn', async () => {
    const calls = mockRoutes([
      RELAY_BOUND,
      sendRoute({ status: 409, data: { error: 'waiting', code: 'PROMPT_WAITING', sendOutcome: 'not_sent' } }),
      CANCEL,
    ]);
    await runUntilExit(() => runSend(['wt-b', 'x', '--reply-to', 'wt-a@claude']));
    expect(cancelled(calls)).toBe(true);
  });

  it('409 RELAY_BIND_CONFLICT: another attempt owns it — NOT withdrawn', async () => {
    const calls = mockRoutes([
      RELAY_BOUND,
      sendRoute({ status: 409, data: { error: 'already bound', code: 'RELAY_BIND_CONFLICT' } }),
      CANCEL,
    ]);
    await runUntilExit(() => runSend(['wt-b', 'x', '--reply-to', 'wt-a@claude']));
    expect(cancelled(calls)).toBe(false);
  });

  it('unknown: left open, the relay id and the lookup command on stderr', async () => {
    const calls = mockRoutes([
      RELAY_BOUND,
      sendRoute({ status: 500, data: { error: 'tmux went away', sendOutcome: 'unknown' } }),
      CANCEL,
    ]);
    await runUntilExit(() => runSend(['wt-b', 'x', '--reply-to', 'wt-a@claude']));
    expect(cancelled(calls)).toBe(false);
    expect(stderr()).toContain(`commandmate relays --id ${RELAY_ID}`);
  });

  it('a 201 that says unknown (opencode dispatch) also prints the notice', async () => {
    mockRoutes([RELAY_BOUND, sendRoute({ status: 201, data: { id: 'm', role: 'user', content: 'x', sendOutcome: 'unknown' } })]);
    await runUntilExit(() => runAsk(['wt-b', 'x', '--async', '--reply-to', 'wt-a@claude']));
    expect(stderr()).toContain(`commandmate relays --id ${RELAY_ID}`);
    expect(mockConsoleLog).toHaveBeenCalledWith(RELAY_ID);
  });

  describe('the answer to the send was lost (no HTTP response)', () => {
    it('the lookup says input_started: not withdrawn, not resent, notice printed', async () => {
      const calls = mockRoutes([RELAY_BOUND, sendRoute('network-error'), relayLookup('input_started'), CANCEL]);
      await runUntilExit(() => runSend(['wt-b', 'x', '--reply-to', 'wt-a@claude']));
      expect(sends(calls)).toHaveLength(1);
      expect(calls.some((c) => c.method === 'GET' && c.url.endsWith(`/api/relays/${RELAY_ID}`))).toBe(true);
      expect(cancelled(calls)).toBe(false);
      expect(stderr()).toContain(`commandmate relays --id ${RELAY_ID}`);
    });

    it('the lookup says awaiting: still not withdrawn (the send may be waiting for the lock)', async () => {
      const calls = mockRoutes([RELAY_BOUND, sendRoute('network-error'), relayLookup('awaiting'), CANCEL]);
      await runUntilExit(() => runSend(['wt-b', 'x', '--reply-to', 'wt-a@claude']));
      expect(cancelled(calls)).toBe(false);
    });

    it('the lookup says sent: treated as sent, nothing resent', async () => {
      const calls = mockRoutes([RELAY_BOUND, sendRoute('network-error'), relayLookup('sent'), CANCEL]);
      const code = await runUntilExit(() => runAsk(['wt-b', 'x', '--async', '--reply-to', 'wt-a@claude']));
      expect(code).toBe(0);
      expect(sends(calls)).toHaveLength(1);
      expect(cancelled(calls)).toBe(false);
      expect(mockConsoleLog).toHaveBeenCalledWith(RELAY_ID);
    });

    it('the lookup says failed: withdrawn', async () => {
      const calls = mockRoutes([RELAY_BOUND, sendRoute('network-error'), relayLookup('failed'), CANCEL]);
      await runUntilExit(() => runSend(['wt-b', 'x', '--reply-to', 'wt-a@claude']));
      expect(cancelled(calls)).toBe(true);
    });

    it('the lookup fails too: not withdrawn, notice printed', async () => {
      const calls = mockRoutes([RELAY_BOUND, sendRoute('network-error'), CANCEL]);
      await runUntilExit(() => runSend(['wt-b', 'x', '--reply-to', 'wt-a@claude']));
      expect(cancelled(calls)).toBe(false);
      expect(stderr()).toContain(RELAY_ID);
    });
  });
});

describe('relays --id (Issue #3957)', () => {
  it('prints one closed relay with its send state, overlap and hold reason', async () => {
    mockRoutes([
      {
        match: `/api/relays/${RELAY_ID}`,
        method: 'GET',
        response: {
          status: 200,
          data: {
            relay: {
              id: RELAY_ID,
              state: 'delivered',
              from: { worktreeId: 'wt-a', instanceId: 'claude' },
              to: { worktreeId: 'wt-b', instanceId: 'codex' },
              hops: 1,
              expiresAt: 1_800_000_000_000,
              sendState: 'sent',
              overlap: 'later',
              holdReason: null,
            },
          },
        },
      },
    ]);
    await runRelays(['--id', RELAY_ID]);
    const line = String(mockConsoleLog.mock.calls[0][0]);
    expect(line).toContain('delivered');
    expect(line).toContain('send=sent');
    expect(line).toContain('overlap=later');
    expect(line).not.toContain('hold=');
  });

  it('rejects an id that was never a relay id', async () => {
    mockRoutes([]);
    const code = await runUntilExit(() => runRelays(['--id', 'nope']));
    expect(code).toBe(2);
  });
});
