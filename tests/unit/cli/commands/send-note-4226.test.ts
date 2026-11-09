/**
 * Issue #4226 (design `docs/design/mem-prompt-4226.md` §6, I-F5・I-F6): `send --note`.
 *
 *  - The note is kept in mem as a `waiting` item of the sender, closed by the relay it
 *    opened, with the relay as its only evidence. Nothing of the other session, the
 *    time or the message is copied (D2), and the message is not changed.
 *  - A note mem refuses sends nothing and undoes what the send took: the task is failed,
 *    the grant this send armed is withdrawn (one on before stays), the relay withdrawn.
 *  - With --auto-yes, a state that cannot be read first stops the send before the grant.
 *  - A send without --note is as it was.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSendCommand } from '../../../../src/cli/commands/send';

const WT = 'wt1';
const ME = 'me-wt';
const NOTE = 'waiting for the review of the parser';
const EXPIRES = 1_900_000_000_000;

interface Server {
  order: string[];
  memPosts: Array<{ url: string; body: Record<string, unknown> }>;
  memAnswer: { status: number; body: Record<string, unknown> } | 'network';
  sends: Array<Record<string, unknown>>;
  sendAnswer: { status: number; body: Record<string, unknown> };
  autoYesPosts: Array<{ url: string; body: Record<string, unknown> }>;
  /** null: the read fails. */
  autoYesBefore: boolean | null;
  relayCancels: number;
  taskStatuses: unknown[];
}

function fakeServer(overrides: Partial<Server> = {}): Server {
  const state: Server = {
    order: [],
    memPosts: [],
    memAnswer: { status: 201, body: { ok: true, item: { id: 'item-1' }, replayed: false, warnings: [] } },
    sends: [],
    sendAnswer: { status: 201, body: { id: 1 } },
    autoYesPosts: [],
    autoYesBefore: false,
    relayCancels: 0,
    taskStatuses: [],
    ...overrides,
  };
  let armed = state.autoYesBefore === true;
  const respond = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      redirected: false,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;
  const grant = () => ({ enabled: true, expiresAt: EXPIRES, cliToolId: 'codex', instanceId: 'codex', grantId: 'grant-1' });

  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.includes('/api/capabilities')) return respond(200, { serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] });
    if (url.includes('/resolve-target')) {
      const instanceId = new URL(url).searchParams.get('instance') ?? 'codex';
      return respond(200, { cliToolId: instanceId.split('-')[0], instanceId, resolvedBy: 'explicit', conflict: null });
    }
    if (url.includes('/auto-yes') && method === 'GET') {
      if (state.autoYesBefore === null && !armed) return respond(500, { error: 'boom' });
      return respond(200, armed ? grant() : { enabled: false, expiresAt: null });
    }
    if (url.includes('/auto-yes') && method === 'POST') {
      state.autoYesPosts.push({ url, body });
      state.order.push(body.enabled ? 'arm' : 'disarm');
      armed = body.enabled === true;
      return respond(200, armed ? grant() : { enabled: false, expiresAt: null });
    }
    if (url.endsWith('/api/relays') && method === 'POST') {
      state.order.push('relay');
      return respond(201, { relay: { id: 'relay-1', bindMode: 'bound' }, bindMode: 'bound' });
    }
    if (url.endsWith('/api/relays/relay-1/cancel')) {
      state.relayCancels += 1;
      state.order.push('relay-cancel');
      return respond(200, { ok: true });
    }
    if (url.includes('/mem/items')) {
      state.memPosts.push({ url, body });
      state.order.push(url.endsWith('/close') ? 'mem-close' : 'mem');
      if (url.endsWith('/close')) return respond(200, { ok: true, item: { id: 'item-1' } });
      if (state.memAnswer === 'network') throw new TypeError('fetch failed');
      return respond(state.memAnswer.status, state.memAnswer.body);
    }
    if (url.endsWith(`/api/worktrees/${WT}/tasks`) && method === 'POST') {
      state.order.push('task');
      return respond(201, { task: { id: 'task-1' }, message: 'from the contract' });
    }
    if (url.includes('/api/tasks/') && method === 'PATCH') {
      state.taskStatuses.push(body.status);
      return respond(200, {});
    }
    if (url.endsWith('/send') && method === 'POST') {
      state.sends.push(body);
      state.order.push('send');
      return respond(state.sendAnswer.status, state.sendAnswer.body);
    }
    if (url.endsWith(`/api/worktrees/${WT}`)) return respond(200, { id: WT, agentInstances: [{ id: 'codex', cliTool: 'codex', alias: 'Codex', order: 0 }], rosterRevision: 'rev-1' });
    return respond(200, {});
  }) as unknown as typeof fetch;
  return state;
}

const SESSION_ENV = ['TMUX', 'TMUX_PANE', 'CM_WORKTREE_ID', 'CM_AGENT_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_AGENT_INSTANCE_ID', 'CM_CLI_TOOL', 'CM_AGENT_TOOL'];
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
  process.env.CM_WORKTREE_ID = ME;
  process.env.CM_CLI_TOOL = 'claude';
  errors = [];
  exitCode = undefined;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    // The first exit is the command's: the action's catch turns the thrown mock into a second one.
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
  const contract = args.includes('--contract');
  await createSendCommand()
    .parseAsync(['node', 'send', WT, ...(contract ? [] : ['hello']), ...(args.includes('--instance') ? [] : ['--instance', 'codex']), ...args])
    .catch(() => undefined);
  return exitCode;
}

const REFUSED = { status: 409, body: { ok: false, code: 'disabled', mode: 'off', message: 'mem is not enabled for this branch' } };
const arms = (server: Server) => server.autoYesPosts.filter(({ body }) => body.enabled === true);
const disarms = (server: Server) => server.autoYesPosts.filter(({ body }) => body.enabled === false);

describe('send --note (I-F5): what is kept, and what is not', () => {
  it('needs --reply-to: exit 2, nothing requested', async () => {
    const server = fakeServer();
    expect(await send('--note', NOTE)).toBe(2);
    expect(server.order).toEqual([]);
    expect(errors.join('\n')).not.toContain(NOTE);
  });

  it('needs a session identity: exit 2 before any side effect', async () => {
    delete process.env.CM_WORKTREE_ID;
    delete process.env.CM_CLI_TOOL;
    const server = fakeServer();
    expect(await send('--reply-to', `${ME}@claude`, '--note', NOTE)).toBe(2);
    expect(server.order).toEqual([]);
  });

  it('keeps a waiting item of the sender, closed by the relay, right before the message; the message is unchanged', async () => {
    const server = fakeServer();
    expect(await send('--reply-to', 'self', '--note', NOTE)).toBeUndefined();
    expect(server.order).toEqual(['relay', 'mem', 'send']);
    expect(server.memPosts[0].url).toContain(`/api/worktrees/${ME}/mem/items`);
    expect(server.memPosts[0].body).toEqual({
      instanceId: 'claude',
      kind: 'waiting',
      text: NOTE,
      closeWhen: 'relay:relay-1',
      evidence: ['relay:relay-1'],
      key: 'send-note:relay-1',
    });
    // Positive control: a body naming the other session (its worktree, its instance) or a time fails here.
    const kept = JSON.stringify(server.memPosts[0].body);
    expect(kept).not.toContain(WT);
    expect(kept).not.toContain('codex');
    expect(kept).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(server.sends[0].content ?? server.sends[0].message).toBe('hello');
    expect(JSON.stringify(server.sends[0])).not.toContain(NOTE);
  });

  it('(negative control) a send without --note: no mem request, the same order as before', async () => {
    const server = fakeServer();
    expect(await send('--reply-to', 'self')).toBeUndefined();
    expect(server.order).toEqual(['relay', 'send']);
  });
});

describe('send --note (I-F6): a refused note sends nothing and undoes what the send took', () => {
  it.each([
    ['mode off', REFUSED, 50],
    ['a secret-like note', { status: 400, body: { ok: false, code: 'secret_like', field: 'text', message: 'x' } }, 2],
    ['the open limit', { status: 409, body: { ok: false, code: 'limit_exceeded', message: 'x' } }, 56],
    ['no answer', 'network' as const, 1],
  ])('%s: no message, relay withdrawn, task failed, the armed grant withdrawn by name, exit with mem’s code', async (_name, memAnswer, code) => {
    const server = fakeServer({ memAnswer });
    expect(await send('--reply-to', 'self', '--note', NOTE, '--contract', '.commandmate/tasks/t.yaml', '--auto-yes')).toBe(code);
    expect(server.sends).toEqual([]);
    expect(server.relayCancels).toBe(1);
    expect(server.taskStatuses).toEqual(['failed']);
    expect(arms(server)).toHaveLength(1);
    expect(disarms(server)).toHaveLength(1);
    expect(disarms(server)[0].url).toContain('expectedGrantId=grant-1');
    expect(errors.join('\n')).not.toContain(NOTE);
  });

  it('a grant on before the send is left on: no arming, no withdrawal', async () => {
    const server = fakeServer({ memAnswer: REFUSED, autoYesBefore: true });
    expect(await send('--reply-to', 'self', '--note', NOTE, '--auto-yes')).toBe(50);
    expect(server.autoYesPosts).toEqual([]);
    expect(server.relayCancels).toBe(1);
  });

  it('--model that arms after the message: no grant request at all', async () => {
    const server = fakeServer({ memAnswer: REFUSED });
    expect(await send('--reply-to', 'self', '--note', NOTE, '--auto-yes', '--instance', 'copilot', '--model', 'gpt-5')).toBe(50);
    expect(server.autoYesPosts).toEqual([]);
    expect(server.sends).toEqual([]);
  });

  it('the conditional path (a pin): the relay first, then refused the same way', async () => {
    const server = fakeServer({ memAnswer: REFUSED });
    expect(await send('--reply-to', 'self', '--note', NOTE, '--expect-no-role')).toBe(50);
    expect(server.order.filter((step) => step !== 'arm')).toEqual(['relay', 'mem', 'relay-cancel']);
    expect(server.sends).toEqual([]);
  });

  it.each([
    ['unconditional', [] as string[], 0],
    ['conditional (a pin)', ['--expect-no-role'], 1],
  ])('Auto-Yes not readable first (%s): stopped before the grant, no mem, no message, task failed, exit 99', async (_name, extra, cancels) => {
    const server = fakeServer({ autoYesBefore: null });
    // Positive control: the send before #4226 arms a grant here and cannot withdraw it after mem refuses.
    expect(await send('--reply-to', 'self', '--note', NOTE, '--auto-yes', '--contract', '.commandmate/tasks/t.yaml', ...extra)).toBe(99);
    expect(arms(server)).toEqual([]);
    expect(server.memPosts).toEqual([]);
    expect(server.sends).toEqual([]);
    expect(server.taskStatuses).toEqual(['failed']);
    expect(server.relayCancels).toBe(cancels);
  });

  it('(negative control) not readable first without --note: armed and sent as before', async () => {
    const server = fakeServer({ autoYesBefore: null });
    expect(await send('--reply-to', 'self', '--auto-yes')).toBeUndefined();
    expect(arms(server)).toHaveLength(1);
    expect(server.sends).toHaveLength(1);
  });
});

describe('send --note: after the message', () => {
  it('known not sent: the note is closed by its author', async () => {
    const server = fakeServer({ sendAnswer: { status: 409, body: { error: 'refused', code: 'SOMETHING', sendOutcome: 'not_sent' } } });
    await send('--reply-to', 'self', '--note', NOTE);
    const close = server.memPosts.find(({ url }) => url.endsWith('/close'));
    expect(close?.url).toContain(`/api/worktrees/${ME}/mem/items/item-1/close`);
    expect(close?.body).toEqual({ instanceId: 'claude', reason: 'send_not_sent' });
  });

  it('not known whether it was sent: the note is left to the relay', async () => {
    const server = fakeServer({ sendAnswer: { status: 500, body: { error: 'boom', sendOutcome: 'unknown' } } });
    await send('--reply-to', 'self', '--note', NOTE);
    expect(server.memPosts.filter(({ url }) => url.endsWith('/close'))).toEqual([]);
  });
});
