/**
 * Issue #4437 PR2: `send`, `ask` and `respond` (the strict one too) say who is
 * sending, and the server's tool-policy 409 is exit 33 with its reason.
 *
 * The CLI makes its real requests; `fetch` answers them as PR1's server does. No
 * server, no tmux (`TMUX` is emptied), no agy, no file under $HOME.
 *
 * I5  a session / agent / no-terminal caller puts `origin` on the body; unknown is sent as `unknown`
 * I7  409 TOOL_POLICY_DENIED / RELAY_TOOL_POLICY_DENIED → exit 33 from every command
 *     (send, send --reply-to, ask, ask --async, ask --json, respond, respond via
 *     /respond, strict, strict --json), stderr line 1 is the reason, before the strict
 *     respond's 40 / 41. Other 409s and failures keep their exits.
 * I8  the output says nothing was typed (`sent: false`)
 * I4 / I9  a terminal, and a server that takes it (201), go on as before
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { keepOffTheRealServer, restoreFetch } from '../../../helpers/mock-api';
import { ANTIGRAVITY_FAQ_URL, ANTIGRAVITY_TERMS_URL, TOOL_POLICY_DENIED_MESSAGE } from '../../../../src/lib/tool-policy/policy';

keepOffTheRealServer();

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
function setStdinTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true, writable: true });
}

const ORIGIN_ENV = [
  'TMUX', 'CLAUDECODE', 'CM_RUN_ORIGIN', 'CM_WORKTREE_ID', 'CM_AGENT_WORKTREE_ID',
  'CM_INSTANCE_ID', 'CM_AGENT_INSTANCE_ID', 'CM_CLI_TOOL', 'CM_AGENT_TOOL',
];

beforeEach(() => {
  vi.stubEnv('CM_PORT', '3999');
  // A deterministic caller: no tmux (so tmux is never run), no session, no agent marker.
  for (const name of ORIGIN_ENV) vi.stubEnv(name, '');
  setStdinTTY(undefined);
});

afterEach(() => {
  restoreFetch();
  vi.unstubAllEnvs();
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const TASK_ID = '99999999-2222-4333-8444-555555555555';
const UNLOCK = 'Set CM_ANTIGRAVITY_USAGE=api-key (or CM_ANTIGRAVITY_USAGE=enterprise) on the server and restart it, if you use Antigravity with an API key or an enterprise plan.';

function policy(operation: string, origin: string, extra: Record<string, unknown> = {}) {
  return {
    tool: 'antigravity',
    operation,
    origin,
    reason: 'ANTIGRAVITY_CONSUMER_TERMS',
    declaration: 'personal',
    links: { terms: ANTIGRAVITY_TERMS_URL, faq: ANTIGRAVITY_FAQ_URL },
    unlock: UNLOCK,
    ...extra,
  };
}

/** PR1's 409 for a send / ask / respond. */
function denied(operation = 'send', origin = 'unknown', extra: Record<string, unknown> = {}) {
  return {
    status: 409,
    data: { ...extra, error: TOOL_POLICY_DENIED_MESSAGE, code: 'TOOL_POLICY_DENIED', policy: policy(operation, origin), sendOutcome: 'not_sent' },
  };
}

/** PR1's 409 for `POST /api/relays`. */
const RELAY_DENIED = {
  status: 409,
  data: {
    error: TOOL_POLICY_DENIED_MESSAGE,
    code: 'RELAY_TOOL_POLICY_DENIED',
    policy: policy('relay', 'relay', { endpoint: 'to' }),
  },
};

interface Route {
  match: string;
  method?: string;
  response: { status: number; data: unknown };
}

function resolveTarget(worktreeId: string, instanceId: string, cliToolId: string): Route {
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
  resolveTarget('wt-a', 'claude', 'claude'),
  resolveTarget('wt-g', 'antigravity', 'antigravity'),
  resolveTarget('wt-c', 'codex', 'codex'),
  { match: '/api/asks/capabilities', method: 'GET', response: { status: 200, data: { protocol: 1, tools: { antigravity: false, codex: false } } } },
  { match: '/current-output', method: 'GET', response: { status: 200, data: {} } },
];

function mockRoutes(routes: Route[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const all = [...routes, ...BASE].sort((a, b) => b.match.length - a.match.length);
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const route = all.find((c) => url.includes(c.match) && (c.method ?? 'POST').toUpperCase() === method);
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

/** Runs with a process.exit that stops, as the real one does; the first code, or undefined. */
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
async function runRespond(argv: string[]): Promise<void> {
  const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
  await createRespondCommand().parseAsync(['node', 'respond', ...argv]);
}

const stderrLines = (): string[] => mockConsoleError.mock.calls.map((c) => String(c[0]));
const firstErrorLine = (): string | undefined => stderrLines().find((l) => l.startsWith('Error'));
const stdoutJson = (): Record<string, unknown> => JSON.parse(String(mockConsoleLog.mock.calls.at(-1)?.[0]));
const to = (calls: ReturnType<typeof mockRoutes>, suffix: string) =>
  calls.filter((c) => c.method === 'POST' && new URL(c.url).pathname.endsWith(suffix));

/** The checks every refusal shares (I7, I8). */
function expectRefusal(code: 'TOOL_POLICY_DENIED' | 'RELAY_TOOL_POLICY_DENIED'): void {
  const lines = stderrLines();
  const at = lines.findIndex((l) => l.startsWith(`Error [${code}]: `));
  expect(at).toBeGreaterThanOrEqual(0);
  // The reason is the first error line, and nothing of the generic handling precedes it.
  expect(firstErrorLine()).toBe(lines[at]);
  expect(lines[at + 1]).toContain(ANTIGRAVITY_TERMS_URL);
  expect(lines[at + 1]).toContain(ANTIGRAVITY_FAQ_URL);
  expect(lines.join('\n')).toContain(UNLOCK);
  expect(lines.join('\n')).toContain('sent: false');
  expect(lines.join('\n')).not.toMatch(/Unexpected HTTP status|safe to send it again|Message sent\./);
}

describe('send (Issue #4437)', () => {
  it('positive — 409 TOOL_POLICY_DENIED is exit 33 with the reason first, nothing typed', async () => {
    const calls = mockRoutes([{ match: '/api/worktrees/wt-g/send', response: denied('send', 'unknown') }]);
    const code = await runUntilExit(() => runSend(['wt-g', 'hello', '--instance', 'antigravity']));
    expect(code).toBe(33);
    expectRefusal('TOOL_POLICY_DENIED');
    expect(to(calls, '/send')).toHaveLength(1);
  });

  it('I5 — with no terminal the body says origin unknown (no-tty)', async () => {
    const calls = mockRoutes([{ match: '/api/worktrees/wt-g/send', response: denied() }]);
    await runUntilExit(() => runSend(['wt-g', 'hello', '--instance', 'antigravity']));
    expect(to(calls, '/send')[0].body).toMatchObject({
      content: 'hello',
      cliToolId: 'antigravity',
      instanceId: 'antigravity',
      origin: 'unknown',
      originEvidence: 'no-tty',
    });
  });

  it.each([
    ['CM_AGENT_TOOL', 'codex', 'session'],
    ['CM_WORKTREE_ID', 'wt-x', 'session'],
    ['CM_RUN_ORIGIN', 'schedule', 'schedule'],
    ['CLAUDECODE', '1', 'agent'],
  ])('I5 — %s=%s on a terminal still says %s', async (name, value, origin) => {
    setStdinTTY(true);
    vi.stubEnv(name, value);
    const calls = mockRoutes([{ match: '/api/worktrees/wt-g/send', response: denied('send', origin) }]);
    const code = await runUntilExit(() => runSend(['wt-g', 'hello', '--instance', 'antigravity']));
    expect(code).toBe(33);
    expect(to(calls, '/send')[0].body).toMatchObject({ origin, originEvidence: `env:${name}` });
  });

  it('I4 / I9 — a person in a terminal says terminal, and a 201 is sent as before (exit 0)', async () => {
    setStdinTTY(true);
    const calls = mockRoutes([
      { match: '/api/worktrees/wt-g/send', response: { status: 201, data: { id: 'm1', role: 'user', content: 'hello', sendOutcome: 'sent' } } },
    ]);
    const code = await runUntilExit(() => runSend(['wt-g', 'hello', '--instance', 'antigravity']));
    expect(code).toBeUndefined();
    expect(to(calls, '/send')[0].body).toMatchObject({ origin: 'terminal', originEvidence: 'tty' });
    expect(stderrLines()).toContain('Message sent.');
  });

  it('I9 — a declared server (201) takes an agent\'s send as before', async () => {
    vi.stubEnv('CM_AGENT_TOOL', 'codex');
    mockRoutes([
      { match: '/api/worktrees/wt-g/send', response: { status: 201, data: { id: 'm1', role: 'user', content: 'x', sendOutcome: 'sent' } } },
    ]);
    const code = await runUntilExit(() => runSend(['wt-g', 'x', '--instance', 'antigravity']));
    expect(code).toBeUndefined();
    expect(stderrLines()).toContain('Message sent.');
  });

  it('I9 — with --contract, the task is closed as failed and the refusal is still exit 33', async () => {
    const calls = mockRoutes([
      { match: '/api/worktrees/wt-g/tasks', response: { status: 201, data: { task: { id: TASK_ID, status: 'pending' }, message: 'goal' } } },
      { match: '/api/worktrees/wt-g/send', response: denied() },
      { match: `/api/tasks/${TASK_ID}`, method: 'PATCH', response: { status: 200, data: {} } },
    ]);
    const code = await runUntilExit(() => runSend(['wt-g', '--contract', '.commandmate/tasks/t.yaml', '--instance', 'antigravity']));
    expect(code).toBe(33);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'failed' });
    expectRefusal('TOOL_POLICY_DENIED');
  });

  it('send --reply-to — the relay refused (RELAY_TOOL_POLICY_DENIED) is exit 33 and nothing is sent (F3)', async () => {
    const calls = mockRoutes([
      { match: '/api/relays', response: RELAY_DENIED },
      { match: '/api/worktrees/wt-g/send', response: { status: 201, data: { id: 'm', role: 'user', content: 'x' } } },
    ]);
    const code = await runUntilExit(() => runSend(['wt-g', 'x', '--instance', 'antigravity', '--reply-to', 'wt-a@claude']));
    expect(code).toBe(33);
    expectRefusal('RELAY_TOOL_POLICY_DENIED');
    expect(to(calls, '/send')).toHaveLength(0);
    // The relay request itself carries no origin: relays are refused by their ends.
    expect(to(calls, '/api/relays')[0].body).not.toHaveProperty('origin');
  });

  it('negative control — another relay refusal stays exit 2', async () => {
    mockRoutes([{ match: '/api/relays', response: { status: 409, data: { error: 'chain', code: 'RELAY_CHAIN_BLOCKED' } } }]);
    const code = await runUntilExit(() => runSend(['wt-c', 'x', '--instance', 'codex', '--reply-to', 'wt-a@claude']));
    expect(code).toBe(2);
  });

  it('negative control — the role\'s 409 stays exit 32', async () => {
    mockRoutes([
      {
        match: '/api/worktrees/wt-c/send',
        response: { status: 409, data: { error: 'role does not hold', code: 'ROLE_CONDITION_UNMET', sendOutcome: 'not_sent' } },
      },
    ]);
    const code = await runUntilExit(() => runSend(['wt-c', 'x', '--instance', 'codex']));
    expect(code).toBe(32);
  });

  it('negative control — a send naming a tool the policy never restricts keeps its body as it was', async () => {
    vi.stubEnv('CM_AGENT_TOOL', 'claude');
    const calls = mockRoutes([
      { match: '/api/worktrees/wt-c/send', response: { status: 201, data: { id: 'm1', role: 'user', content: 'x', sendOutcome: 'sent' } } },
    ]);
    await runUntilExit(() => runSend(['wt-c', 'x', '--instance', 'codex']));
    expect(to(calls, '/send')[0].body).toEqual({ content: 'x', cliToolId: 'codex', instanceId: 'codex' });
  });

  it('a send naming no tool (the server picks the default) carries the origin', async () => {
    const calls = mockRoutes([{ match: '/api/worktrees/wt-g/send', response: denied() }]);
    const code = await runUntilExit(() => runSend(['wt-g', 'x']));
    expect(code).toBe(33);
    expect(to(calls, '/send')[0].body).toEqual({ content: 'x', origin: 'unknown', originEvidence: 'no-tty' });
  });

  it('negative control — PROMPT_WAITING stays exit 2 and a 500 stays 99', async () => {
    mockRoutes([{ match: '/api/worktrees/wt-c/send', response: { status: 409, data: { error: 'waiting', code: 'PROMPT_WAITING' } } }]);
    expect(await runUntilExit(() => runSend(['wt-c', 'x', '--instance', 'codex']))).toBe(2);
    mockRoutes([{ match: '/api/worktrees/wt-c/send', response: { status: 500, data: { error: 'boom' } } }]);
    expect(await runUntilExit(() => runSend(['wt-c', 'x', '--instance', 'codex']))).toBe(99);
  });
});

describe('ask (Issue #4437)', () => {
  it('positive — exit 33, the reason first, origin on the body', async () => {
    const calls = mockRoutes([{ match: '/api/worktrees/wt-g/send', response: denied('send') }]);
    const code = await runUntilExit(() => runAsk(['wt-g', 'hi', '--instance', 'antigravity']));
    expect(code).toBe(33);
    expectRefusal('TOOL_POLICY_DENIED');
    expect(to(calls, '/send')[0].body).toMatchObject({ origin: 'unknown', originEvidence: 'no-tty' });
  });

  it('--json — stdout is the refusal object (design §3.4)', async () => {
    mockRoutes([{ match: '/api/worktrees/wt-g/send', response: denied('send', 'unknown') }]);
    const code = await runUntilExit(() => runAsk(['wt-g', 'hi', '--instance', 'antigravity', '--json']));
    expect(code).toBe(33);
    expect(stdoutJson()).toEqual({
      worktreeId: 'wt-g',
      instanceId: 'antigravity',
      cliToolId: 'antigravity',
      sent: false,
      refusal: {
        code: 'TOOL_POLICY_DENIED',
        reason: 'ANTIGRAVITY_CONSUMER_TERMS',
        operation: 'send',
        origin: 'unknown',
        message: expect.stringContaining('nothing was typed'),
        links: { terms: ANTIGRAVITY_TERMS_URL, faq: ANTIGRAVITY_FAQ_URL },
        unlock: UNLOCK,
      },
    });
    expect(firstErrorLine()).toMatch(/^Error \[TOOL_POLICY_DENIED\]: /);
  });

  it('--async — the relay refused is exit 33, and --json names the refused end', async () => {
    const calls = mockRoutes([{ match: '/api/relays', response: RELAY_DENIED }]);
    const code = await runUntilExit(() => runAsk(['wt-g', 'hi', '--instance', 'antigravity', '--async', '--reply-to', 'wt-a@claude', '--json']));
    expect(code).toBe(33);
    expect(to(calls, '/send')).toHaveLength(0);
    expect(stdoutJson()).toMatchObject({
      worktreeId: 'wt-g',
      instanceId: 'antigravity',
      sent: false,
      refusal: { code: 'RELAY_TOOL_POLICY_DENIED', operation: 'relay', endpoint: 'to' },
    });
    expectRefusal('RELAY_TOOL_POLICY_DENIED');
  });

  it('negative control — a 201 to another tool goes on to wait as before', async () => {
    const calls = mockRoutes([
      { match: '/api/worktrees/wt-c/send', response: { status: 409, data: { error: 'waiting', code: 'PROMPT_WAITING' } } },
    ]);
    const code = await runUntilExit(() => runAsk(['wt-c', 'hi', '--instance', 'codex']));
    expect(code).toBe(2);
    expect(to(calls, '/send')).toHaveLength(1);
  });
});

describe('respond (Issue #4437)', () => {
  it('/prompt-response — exit 33, origin on the body', async () => {
    const calls = mockRoutes([{ match: '/api/worktrees/wt-g/prompt-response', response: denied('respond') }]);
    const code = await runUntilExit(() => runRespond(['wt-g', '1', '--instance', 'antigravity']));
    expect(code).toBe(33);
    expectRefusal('TOOL_POLICY_DENIED');
    expect(to(calls, '/prompt-response')[0].body).toMatchObject({ origin: 'unknown', originEvidence: 'no-tty' });
  });

  it('/respond (a decision answered by id) — exit 33, origin on the body', async () => {
    const calls = mockRoutes([
      {
        match: '/api/worktrees/wt-g/current-output',
        method: 'GET',
        response: { status: 200, data: { structuredEvents: { source: { capabilities: { eventIdentity: 'decision' } } } } },
      },
      { match: '/api/worktrees/wt-g/respond', response: denied('respond') },
    ]);
    const code = await runUntilExit(() => runRespond(['wt-g', '1', '--instance', 'antigravity']));
    expect(code).toBe(33);
    expect(to(calls, '/respond')[0].body).toMatchObject({ origin: 'unknown' });
    expect(to(calls, '/prompt-response')).toHaveLength(0);
  });

  const STRICT = ['wt-g', 'Yes, I trust this folder', '--instance', 'antigravity', '--expect-screen', 'antigravity-trust', '--observation', 'tok-1'];

  it('strict — the refusal is exit 33, before the strict respond\'s 40', async () => {
    const calls = mockRoutes([
      { match: '/api/worktrees/wt-g/prompt-response/strict', response: denied('respond', 'unknown', { strictRespond: 1 }) },
    ]);
    const code = await runUntilExit(() => runRespond(STRICT));
    expect(code).toBe(33);
    expectRefusal('TOOL_POLICY_DENIED');
    expect(to(calls, '/prompt-response/strict')[0].body).toMatchObject({ origin: 'unknown', originEvidence: 'no-tty' });
    expect(stderrLines().join('\n')).not.toContain('session_conflict');
  });

  it('strict --json — stdout is the refusal object', async () => {
    mockRoutes([{ match: '/api/worktrees/wt-g/prompt-response/strict', response: denied('respond', 'unknown', { strictRespond: 1 }) }]);
    const code = await runUntilExit(() => runRespond([...STRICT, '--json']));
    expect(code).toBe(33);
    expect(stdoutJson()).toMatchObject({
      worktreeId: 'wt-g',
      instanceId: 'antigravity',
      cliToolId: 'antigravity',
      sent: false,
      refusal: { code: 'TOOL_POLICY_DENIED', operation: 'respond', origin: 'unknown', unlock: UNLOCK },
    });
  });

  it('negative control — another strict 409 stays exit 40', async () => {
    mockRoutes([{ match: '/api/worktrees/wt-g/prompt-response/strict', response: { status: 409, data: { error: 'busy' } } }]);
    expect(await runUntilExit(() => runRespond(STRICT))).toBe(40);
  });
});
