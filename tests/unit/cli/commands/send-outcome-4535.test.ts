/**
 * Issue #4535 (design `docs/design/send-outcome-4535.md` §2.2・§3.1): what `send`
 * undoes after a failed `/send`, read as sent / not_sent / unknown.
 *
 *  - The relay, the `--note` item and the Auto-Yes grant this send armed are undone
 *    only when the answer proves nothing went in AND the relay is this send's
 *    (`fact === 'not_sent' && relayOwned`, INV-S5).
 *  - A 409 `RELAY_BIND_CONFLICT` is another copy of this very request holding the
 *    relay (N4): nothing is undone, the relay is looked up, and only its `failed`
 *    makes the cleanup this send's again (Q13 (b)). Its `sent` is exit 0 (T8).
 *  - Exit 34 stays the not_sent 409 `SEND_TARGET_CHANGED` alone (INV-F4).
 *
 * The server is a `global.fetch` stub answering JSON (the answers here are all
 * typed JSON; the untyped ones a real `fetch` meets are in send-outcome-http-4535).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSendCommand } from '../../../../src/cli/commands/send';
import { describeFailedSendOutcome } from '../../../../src/cli/commands/message-dispatch';
import { ApiError } from '../../../../src/cli/utils/api-client';

const WT = 'wt1';
const ME = 'me-wt';
const NOTE = 'waiting for the parser review';
const EXPIRES = 1_900_000_000_000;
const RELAY = 'relay-1';
/** What the real route answers for a message that went in (a ChatMessage: string id, role user). */
const SENT_ANSWER = { status: 201, body: { id: '6f0c1c1e-0000-4000-8000-000000000001', worktreeId: WT, role: 'user', content: 'hello' } };

interface Server {
  sends: Array<Record<string, unknown>>;
  sendAnswer: { status: number; body: Record<string, unknown> };
  /** What `GET /api/relays/relay-1` says the relay's send did; null: the lookup fails. */
  lookup: string | null;
  lookups: number;
  relayCancels: number;
  noteCloses: number;
  autoYesPosts: Array<{ url: string; body: Record<string, unknown> }>;
}

function fakeServer(overrides: Partial<Server> = {}): Server {
  const state: Server = {
    sends: [],
    sendAnswer: SENT_ANSWER,
    lookup: null,
    lookups: 0,
    relayCancels: 0,
    noteCloses: 0,
    autoYesPosts: [],
    ...overrides,
  };
  let armed = false;
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
    if (url.includes('/auto-yes') && method === 'GET') return respond(200, armed ? grant() : { enabled: false, expiresAt: null });
    if (url.includes('/auto-yes') && method === 'POST') {
      state.autoYesPosts.push({ url, body });
      armed = body.enabled === true;
      return respond(200, armed ? grant() : { enabled: false, expiresAt: null });
    }
    if (url.endsWith('/api/relays') && method === 'POST') {
      return respond(201, { relay: { id: RELAY, bindMode: 'bound' }, bindMode: 'bound' });
    }
    if (url.endsWith(`/api/relays/${RELAY}/cancel`)) {
      state.relayCancels += 1;
      return respond(200, { ok: true });
    }
    if (url.endsWith(`/api/relays/${RELAY}`) && method === 'GET') {
      state.lookups += 1;
      if (state.lookup === null) return respond(500, { error: 'lookup failed' });
      return respond(200, { relay: { id: RELAY, state: 'pending', sendState: state.lookup } });
    }
    if (url.includes('/mem/items')) {
      if (url.endsWith('/close')) {
        state.noteCloses += 1;
        return respond(200, { ok: true, item: { id: 'item-1' } });
      }
      return respond(201, { ok: true, item: { id: 'item-1' }, replayed: false, warnings: [] });
    }
    if (url.endsWith('/send') && method === 'POST') {
      state.sends.push(body);
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

/** `send wt1 hello --instance codex --reply-to self --note … --auto-yes`: a relay, a note and a grant to undo. */
async function sendWithEverything(): Promise<number | undefined> {
  await createSendCommand()
    .parseAsync(['node', 'send', WT, 'hello', '--instance', 'codex', '--reply-to', 'self', '--note', NOTE, '--auto-yes'])
    .catch(() => undefined);
  return exitCode;
}

const disarms = (server: Server) => server.autoYesPosts.filter(({ body }) => body.enabled === false);
const said = (): string => errors.join('\n');
const SAFE_AGAIN = 'it is safe to send it again';
const MAY_HAVE_ARRIVED = 'may have arrived';
const PANE_CHECK = /capture wt1 .*--pane/;

/** Nothing of this send's was undone, and the message was posted once. */
function expectNothingUndone(server: Server): void {
  expect(server.sends).toHaveLength(1);
  expect(server.relayCancels).toBe(0);
  expect(server.noteCloses).toBe(0);
  expect(disarms(server)).toHaveLength(0);
}

/** The relay withdrawn, the note closed, the armed grant withdrawn; the message posted once. */
function expectAllUndone(server: Server): void {
  expect(server.sends).toHaveLength(1);
  expect(server.relayCancels).toBe(1);
  expect(server.noteCloses).toBe(1);
  expect(disarms(server)).toHaveLength(1);
}

const CONFLICT = { status: 409, body: { error: 'the relay is already bound', code: 'RELAY_BIND_CONFLICT' } };

describe('R2 (Issue #4535): 409 RELAY_BIND_CONFLICT is another copy of this request — not this send\'s to undo', () => {
  it('R2: RELAY_BIND_CONFLICT — the note stays open, the relay is not withdrawn, Auto-Yes stays, the relay is looked up', async () => {
    // A copy of this request reserved the relay first and is waiting for the input lock.
    const server = fakeServer({ sendAnswer: CONFLICT, lookup: 'awaiting' });
    await sendWithEverything();
    expectNothingUndone(server);
    expect(server.lookups).toBe(1);
    expect(said()).toContain(MAY_HAVE_ARRIVED);
    expect(said()).not.toContain(SAFE_AGAIN);
  });

  it('control: RELAY_BIND_INVALID — the relay is withdrawn and the note closed', async () => {
    // An older server's typed refusal before the reservation (no sendOutcome): N5, this send's relay.
    const server = fakeServer({ sendAnswer: { status: 400, body: { error: 'bad relay', code: 'RELAY_BIND_INVALID' } } });
    await sendWithEverything();
    expectAllUndone(server);
  });

  it('RELAY_BIND_CONFLICT and the lookup says sent — exit 0, nothing resent', async () => {
    const server = fakeServer({ sendAnswer: CONFLICT, lookup: 'sent' });
    expect(await sendWithEverything()).toBeUndefined();
    expectNothingUndone(server);
    expect(said()).toContain('Message sent.');
  });

  it('RELAY_BIND_CONFLICT and the lookup says failed — withdrawn, closed, Auto-Yes withdrawn; stderr says safe to send again and NOT "may have arrived"', async () => {
    const server = fakeServer({ sendAnswer: CONFLICT, lookup: 'failed' });
    await sendWithEverything();
    expectAllUndone(server);
    expect(said()).toContain(SAFE_AGAIN);
    expect(said()).not.toContain(MAY_HAVE_ARRIVED);
  });

  it('RELAY_BIND_CONFLICT and the lookup says input_started — the "may have arrived" note, nothing withdrawn', async () => {
    const server = fakeServer({ sendAnswer: CONFLICT, lookup: 'input_started' });
    await sendWithEverything();
    expectNothingUndone(server);
    expect(said()).toContain(MAY_HAVE_ARRIVED);
    expect(said()).not.toContain(SAFE_AGAIN);
  });
});

describe('controls (Issue #4535 T12): a proven not_sent is undone as before', () => {
  it('control: 409 PROMPT_WAITING with not_sent — withdrawn and closed', async () => {
    const server = fakeServer({ sendAnswer: { status: 409, body: { error: 'answer the prompt first', code: 'PROMPT_WAITING', sendOutcome: 'not_sent' } } });
    expect(await sendWithEverything()).toBe(2);
    expectAllUndone(server);
  });

  it('control: 409 SEND_TARGET_CHANGED not_sent — exit 34, withdrawn', async () => {
    const server = fakeServer({ sendAnswer: { status: 409, body: { error: 'the target changed', code: 'SEND_TARGET_CHANGED', reason: 'target-gone', sendOutcome: 'not_sent' } } });
    expect(await sendWithEverything()).toBe(34);
    expectAllUndone(server);
  });

  it('SEND_TARGET_CHANGED unknown — exit 99, nothing withdrawn', async () => {
    const server = fakeServer({ sendAnswer: { status: 409, body: { error: 'the target changed', code: 'SEND_TARGET_CHANGED', reason: 'dispatch-changed', sendOutcome: 'unknown' } } });
    expect(await sendWithEverything()).toBe(99);
    expectNothingUndone(server);
    expect(said()).toMatch(PANE_CHECK);
  });

  it('control: model_refused 400 with not_sent — Auto-Yes withdrawn, "safe to send again"', async () => {
    const server = fakeServer({ sendAnswer: { status: 400, body: { error: 'model refused', code: 'model_refused', sendOutcome: 'not_sent' } } });
    await sendWithEverything();
    expectAllUndone(server);
    expect(said()).toContain(SAFE_AGAIN);
  });
});

describe('N5 (Issue #4535 T14): an older server\'s refusal proves not_sent only by a code the route answers before the send', () => {
  it('an older server\'s typed refusal (model_refused, no sendOutcome) is not_sent', async () => {
    const server = fakeServer({ sendAnswer: { status: 400, body: { error: 'model refused', code: 'model_refused' } } });
    await sendWithEverything();
    expectAllUndone(server);
  });

  it('a 400 with no code ({ error } only) is unknown', async () => {
    // Positive control: the rule before #4535 (any 4xx is not_sent) withdraws all three here.
    const server = fakeServer({ sendAnswer: { status: 400, body: { error: 'bad request' } } });
    await sendWithEverything();
    expectNothingUndone(server);
    expect(said()).toMatch(PANE_CHECK);
    expect(said()).not.toContain(SAFE_AGAIN);
  });
});

/**
 * Review P3 (#4535 B): `describeFailedSendOutcome` is the resend line `postMessage`
 * prints (`resendNoteFor`, with no relay notice before it), not a second reading of
 * `payload.sendOutcome`. So its callers' tests guard the line a failed send prints:
 * an answer that proves nothing says to look at the pane, whatever its body says.
 */
describe('describeFailedSendOutcome (Issue #4535): the resend line a failed send prints, read once', () => {
  const page = (status: number, bodyText: string, contentType: string | null = 'text/html'): ApiError =>
    new ApiError('failed', 99, status, undefined, undefined, { status, contentType, bodyText });

  it('a body reading sendOutcome not_sent that is not served as JSON is not "safe to send again"', () => {
    const error = new ApiError('failed', 99, 500, { error: 'x', sendOutcome: 'not_sent' } as never, undefined, {
      status: 500,
      contentType: 'text/html',
      bodyText: JSON.stringify({ error: 'x', sendOutcome: 'not_sent' }),
    });
    const line = describeFailedSendOutcome(error, WT);
    expect(line).not.toContain(SAFE_AGAIN);
    expect(line).toMatch(PANE_CHECK);
  });

  it.each([
    ['a 408 page from a front', page(408, '<html>Request Timeout</html>')],
    ['a dropped connection', new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })],
  ])('%s says to check the pane first (it proved nothing)', (_name, error) => {
    expect(describeFailedSendOutcome(error, WT)).toMatch(PANE_CHECK);
  });

  it('control: a typed not_sent served as JSON is "safe to send again"; a refused connection says nothing more', () => {
    const body = { error: 'x', sendOutcome: 'not_sent' };
    const typed = new ApiError('failed', 99, 500, body as never, undefined, { status: 500, contentType: 'application/json', bodyText: JSON.stringify(body) });
    expect(describeFailedSendOutcome(typed, WT)).toContain(SAFE_AGAIN);
    const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    expect(describeFailedSendOutcome(refused, WT)).toBeNull();
  });
});
