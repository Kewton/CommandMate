/**
 * Issue #4518 段 1 (design `docs/design/send-instance-id-4518.md` v3): the invariants of
 * `send --instance-id <id>` that a stubbed server can show — N1 (the origin stamp and the
 * exit-33 mapping on every write of the new path), A2 (a boundary refusal keeps its type),
 * N2 (only a proven refusal before execution is "not sent"), Q3 (argument conflicts).
 *
 * Plain `it`: today's code, GREEN — it pins the defect or the machine the design keeps.
 * `it.fails` marked `// #4518 stage2`: what stage 2 must make true; RED now.
 * The real-route counterparts are in `tests/integration/send-instance-id-4518.test.ts`.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSendCommand } from '../../../../src/cli/commands/send';
import { withSendOrigin } from '../../../../src/cli/utils/send-origin';
import { isToolPolicyRoute } from '../../../../src/cli/utils/tool-policy-failure';
import {
  InputBoundaryRefusedError,
  observeInputStart,
  noteInputStart,
} from '../../../../src/lib/session/instance-input-lock';

const WT = 'wt1';
const ME = 'me-wt';
const NOTE = 'waiting for the review of the parser';

interface Post {
  path: string;
  body: Record<string, unknown>;
}

interface Server {
  order: string[];
  posts: Post[];
  /** The answer to the message's POST: JSON, or a non-JSON page from something in between. */
  sendAnswer: { status: number; body: Record<string, unknown> } | { status: number; html: string };
  relayCancels: number;
  memCloses: number;
}

const ROSTER = [
  { id: 'claude', cliTool: 'claude', alias: '', order: 0 },
  { id: 'claude-3', cliTool: 'claude', alias: 'Reviewer', order: 1 },
  { id: 'agy-1', cliTool: 'antigravity', alias: '', order: 2 },
];

function fakeServer(overrides: Partial<Server> = {}): Server {
  const state: Server = { order: [], posts: [], sendAnswer: { status: 201, body: { id: 1 } }, relayCancels: 0, memCloses: 0, ...overrides };
  const respond = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      redirected: false,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;
  const page = (status: number, html: string): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'text/html' }),
      redirected: false,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
      text: async () => html,
    }) as unknown as Response;

  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const pathname = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method !== 'GET') state.posts.push({ path: pathname, body });
    if (pathname === '/api/capabilities') return respond(200, { serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] });
    if (pathname.endsWith('/resolve-target')) {
      const instanceId = new URL(url).searchParams.get('instance') ?? 'claude';
      const row = ROSTER.find((instance) => instance.id === instanceId);
      return respond(200, { cliToolId: row?.cliTool ?? 'claude', instanceId, resolvedBy: row ? 'roster' : 'worktree-default', conflict: null });
    }
    if (pathname === '/api/relays' && method === 'POST') {
      state.order.push('relay');
      const to = body.to as { cliToolId?: string; instanceId?: unknown } | undefined;
      const toTool = to?.cliToolId ?? ROSTER.find((instance) => instance.id === to?.instanceId)?.cliTool;
      if (toTool === 'antigravity') {
        return respond(409, { error: 'No relay was opened', code: 'RELAY_TOOL_POLICY_DENIED', policy: { tool: 'antigravity', operation: 'relay', endpoint: 'to' } });
      }
      return respond(201, { relay: { id: 'relay-1', bindMode: 'bound' }, bindMode: 'bound' });
    }
    if (pathname === '/api/relays/relay-1' && method === 'GET') throw new TypeError('fetch failed');
    if (pathname === '/api/relays/relay-1/cancel') {
      state.relayCancels += 1;
      state.order.push('relay-cancel');
      return respond(200, { ok: true });
    }
    if (pathname.includes('/mem/items')) {
      if (pathname.endsWith('/close')) {
        state.memCloses += 1;
        state.order.push('mem-close');
        return respond(200, { ok: true, item: { id: 'item-1' } });
      }
      state.order.push('mem');
      return respond(201, { ok: true, item: { id: 'item-1' }, replayed: false, warnings: [] });
    }
    if (/^\/api\/worktrees\/[^/]+\/send$/.test(pathname) && method === 'POST') {
      state.order.push('send');
      const target = body.instanceId;
      const named = typeof target === 'string' ? target : (target as { id?: string } | undefined)?.id;
      if (ROSTER.find((instance) => instance.id === named)?.cliTool === 'antigravity') {
        return respond(409, { error: 'refused', code: 'TOOL_POLICY_DENIED', sendOutcome: 'not_sent', policy: { tool: 'antigravity', operation: 'send' } });
      }
      const answer = state.sendAnswer;
      return 'html' in answer ? page(answer.status, answer.html) : respond(answer.status, answer.body);
    }
    if (pathname === `/api/worktrees/${WT}`) return respond(200, { id: WT, agentInstances: ROSTER, rosterRevision: 'rev-1' });
    return respond(200, {});
  }) as unknown as typeof fetch;
  return state;
}

const SESSION_ENV = ['TMUX', 'TMUX_PANE', 'CM_WORKTREE_ID', 'CM_AGENT_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_AGENT_INSTANCE_ID', 'CM_CLI_TOOL', 'CM_AGENT_TOOL', 'CM_ANTIGRAVITY_USAGE', 'CM_ANTIGRAVITY_NOTICE_DIR'];
const realFetch = global.fetch;
let saved: Record<string, string | undefined>;
let errors: string[];
let exitCode: number | undefined;

beforeEach(() => {
  saved = {};
  for (const name of SESSION_ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  // An agent session (send-origin: `agent`), the sender of the note.
  process.env.CM_WORKTREE_ID = ME;
  process.env.CM_CLI_TOOL = 'claude';
  process.env.CM_AGENT_TOOL = 'claude';
  // The antigravity usage notice is never written under HOME by this file.
  process.env.CM_ANTIGRAVITY_NOTICE_DIR = '/nonexistent-4518';
  errors = [];
  exitCode = undefined;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    errors.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    if (exitCode === undefined) exitCode = code;
    throw new Error(`exit:${code}`);
  }) as never);
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

async function send(...args: string[]): Promise<number | undefined> {
  await createSendCommand().parseAsync(['node', 'send', WT, 'hello', ...args]).catch(() => undefined);
  return exitCode;
}

const HTML_408 = '<html><body>408 Request Timeout</body></html>';

// ---------------------------------------------------------------------------
// N1: origin stamp and the exit-33 mapping
// ---------------------------------------------------------------------------

describe('#4518 N1: the origin stamp and the policy mapping are keyed on the path (green, pinned)', () => {
  const agyBody = { content: 'x', cliToolId: 'antigravity', instanceId: 'agy-1' };
  const agent = () => ({ origin: 'agent' as const, evidence: 'env:CM_AGENT_TOOL' });

  it('the existing /send is stamped and mapped to exit 33', () => {
    expect(withSendOrigin(`/api/worktrees/${WT}/send`, agyBody, agent)).toMatchObject({ origin: 'agent' });
    expect(isToolPolicyRoute(`/api/worktrees/${WT}/send`)).toBe(true);
    expect(isToolPolicyRoute('/api/relays')).toBe(true);
  });

  it('a new path is neither stamped nor mapped (why design §1 choice A needs both lists changed, codex r2 N1)', () => {
    expect(withSendOrigin(`/api/worktrees/${WT}/send-exact`, agyBody, agent)).toEqual(agyBody);
    expect(isToolPolicyRoute(`/api/worktrees/${WT}/send-exact`)).toBe(false);
    expect(isToolPolicyRoute('/api/relays/exact')).toBe(false);
  });

  it('a body whose instanceId is an object keeps the path\'s stamp (choice B rides on /send as it is)', () => {
    const exactBody = { content: 'x', cliToolId: 'antigravity', instanceId: { id: 'agy-1', exact: true } };
    expect(withSendOrigin(`/api/worktrees/${WT}/send`, exactBody, agent)).toMatchObject({ origin: 'agent', originEvidence: 'env:CM_AGENT_TOOL' });
  });
});

describe('#4518 N1 stage 2: every write of `--instance-id` is stamped and mapped (it.fails until stage 2)', () => {
  // #4518 stage2
  it.fails('--instance-id agy-1 from an agent session: every write path is a policy route, the message carries the origin, exit 33', async () => {
    const server = fakeServer();
    expect(await send('--instance-id', 'agy-1')).toBe(33);
    expect(server.posts.length).toBeGreaterThan(0);
    for (const post of server.posts) expect(isToolPolicyRoute(post.path)).toBe(true);
    const message = server.posts.find((post) => /\/send/.test(post.path));
    expect(message?.body).toMatchObject({ origin: 'agent' });
    expect(errors[0]).toMatch(/^Error \[TOOL_POLICY_DENIED\]: /);
  });

  // #4518 stage2
  it.fails('--instance-id agy-1 --reply-to self: refused at the relay, exit 33, no message posted', async () => {
    const server = fakeServer();
    expect(await send('--instance-id', 'agy-1', '--reply-to', 'self')).toBe(33);
    expect(server.order).toEqual(['relay']);
    expect(errors[0]).toMatch(/^Error \[RELAY_TOOL_POLICY_DENIED\]: /);
  });
});

// ---------------------------------------------------------------------------
// A2: the type of a boundary refusal
// ---------------------------------------------------------------------------

class ExactTargetChanged extends Error {
  readonly code = 'EXACT_TARGET_CHANGED';
}

async function refusalOf(thrown: Error): Promise<unknown> {
  try {
    await observeInputStart(async () => {
      noteInputStart();
    }, undefined, {
      beforeInput: () => {
        throw thrown;
      },
    });
  } catch (error) {
    return error;
  }
  throw new Error('the boundary did not refuse');
}

describe('#4518 A2: runBoundaryHook (instance-input-lock.ts) wraps whatever beforeInput throws (green, pinned)', () => {
  it('the refusal is an InputBoundaryRefusedError with only the message copied: no cause, not the thrown type, no code of its own', async () => {
    const thrown = new ExactTargetChanged('claude-3 is no longer codex-free');
    const refusal = await refusalOf(thrown);
    expect(refusal).toBeInstanceOf(InputBoundaryRefusedError);
    expect(refusal).not.toBeInstanceOf(ExactTargetChanged);
    expect((refusal as Error).cause).toBeUndefined();
    expect((refusal as { code?: string }).code).toBe('INPUT_BOUNDARY_REFUSED');
    expect((refusal as Error).message).toContain('claude-3 is no longer codex-free');
  });
});

describe('#4518 A2 stage 2: the exact re-check keeps its type up to the send result (it.fails until stage 2)', () => {
  // #4518 stage2
  it.fails('the refusal carries the thrown error (as cause, or as itself) so the route can tell it from a lost reservation', async () => {
    const thrown = new ExactTargetChanged('changed');
    const refusal = await refusalOf(thrown);
    const kept = refusal === thrown || (refusal as Error).cause === thrown;
    expect(kept).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// N2: only a proven refusal before execution is "not sent"
// ---------------------------------------------------------------------------

describe('#4518 N2: today a bare 4xx page is read as "not sent" (green, pinned for --instance)', () => {
  it('--instance claude-3 --reply-to --note, a non-JSON 408 from in between: the relay is withdrawn and the note closed', async () => {
    const server = fakeServer({ sendAnswer: { status: 408, html: HTML_408 } });
    const code = await send('--instance', 'claude-3', '--reply-to', 'self', '--note', NOTE);
    expect(code).not.toBe(0);
    expect(server.order).toEqual(['relay', 'mem', 'send', 'mem-close', 'relay-cancel']);
    expect(server.relayCancels).toBe(1);
    expect(server.memCloses).toBe(1);
  });

  it('(control) a non-JSON 200 with the relay unreadable is unknown: nothing withdrawn, nothing closed', async () => {
    const server = fakeServer({ sendAnswer: { status: 200, html: '<html>ok?</html>' } });
    const code = await send('--instance', 'claude-3', '--reply-to', 'self', '--note', NOTE);
    expect(code).not.toBe(0);
    expect(server.relayCancels).toBe(0);
    expect(server.memCloses).toBe(0);
    expect(errors.join('\n')).not.toContain('safe to send it again');
  });
});

describe('#4518 N2 stage 2: --instance-id says "not sent" only on the server\'s own refusal (it.fails until stage 2)', () => {
  // #4518 stage2
  it.fails('a non-JSON 408 from in between: not exit 2, the relay kept, the note kept, no "not sent" / "safe to send it again"', async () => {
    const server = fakeServer({ sendAnswer: { status: 408, html: HTML_408 } });
    const code = await send('--instance-id', 'claude-3', '--reply-to', 'self', '--note', NOTE);
    expect(code).not.toBe(0);
    expect(code).not.toBe(2);
    expect(server.order).toEqual(['relay', 'mem', 'send']);
    expect(errors.join('\n')).not.toMatch(/nothing was sent|not sent|safe to send it again/i);
  });

  // #4518 stage2
  it.fails('a JSON 409 EXACT_TARGET_MISMATCH with sendOutcome not_sent: exit 2, the relay withdrawn, the note closed', async () => {
    const server = fakeServer({
      sendAnswer: { status: 409, body: { error: 'claude-3 is not on the roster', code: 'EXACT_TARGET_MISMATCH', sendOutcome: 'not_sent', relayId: 'relay-1' } },
    });
    expect(await send('--instance-id', 'claude-3', '--reply-to', 'self', '--note', NOTE)).toBe(2);
    expect(server.order).toEqual(['relay', 'mem', 'send', 'mem-close', 'relay-cancel']);
  });
});

// ---------------------------------------------------------------------------
// Q3 / arguments: refused before any request
// ---------------------------------------------------------------------------

describe('#4518 Q3 stage 2: argument conflicts are exit 2 with no request (it.fails until stage 2)', () => {
  // #4518 stage2
  it.fails('--instance-id with --instance: exit 2, no request', async () => {
    const server = fakeServer();
    expect(await send('--instance-id', 'claude-3', '--instance', 'claude-3')).toBe(2);
    expect(server.posts).toEqual([]);
    expect(errors.join('\n')).toContain('--instance-id');
    expect(errors.join('\n')).not.toMatch(/unknown option/);
  });

  // #4518 stage2
  it.fails('--instance-id with an alias (not an id): exit 2, no request — an alias is never looked up', async () => {
    const server = fakeServer();
    expect(await send('--instance-id', 'Code Reviewer')).toBe(2);
    expect(server.posts).toEqual([]);
    expect(errors.join('\n')).not.toMatch(/unknown option/);
  });

  // #4518 stage2: delete this one (the flag exists then). It shows why the it.fails above fail today.
  it('(control) today --instance-id is an unknown option: exit 1 from commander, no request', async () => {
    const server = fakeServer();
    expect(await send('--instance-id', 'claude-3')).toBe(1);
    expect(server.posts).toEqual([]);
    expect(errors.join('\n')).toMatch(/unknown option '--instance-id'/);
  });
});
