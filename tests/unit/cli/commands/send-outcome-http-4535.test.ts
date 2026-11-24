/**
 * Issue #4535 (design `docs/design/send-outcome-4535.md` §2.2, T9・T17・T18): what
 * `send` reads from answers only a real `fetch` meets — a page from a front, an
 * empty or non-JSON 2xx, a redirect, a refused connection.
 *
 * A real `http.createServer` on port 0 (`tests/helpers/send-outcome-server-4535.ts`)
 * and the real `fetch`: a `global.fetch` stub cannot follow a redirect, serve HTML
 * or leave out the `content-type`, so the guards here would stay green without it.
 * HOME is a private directory under os.tmpdir(); `CM_UAT_ISOLATION` keeps the
 * client off port 3000.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createSendCommand } from '../../../../src/cli/commands/send';
import {
  refusedPortUrl,
  startSendOutcomeServer,
  type SendOutcomeRoute,
  type SendOutcomeServer,
} from '../../../helpers/send-outcome-server-4535';

const WT = 'wt1';
const ME = 'me-wt';
const RELAY = 'relay-1';
const SEND = `/api/worktrees/${WT}/send`;
const CANCEL = `/api/relays/${RELAY}/cancel`;
const NOTE_CLOSE = `/api/worktrees/${ME}/mem/items/item-1/close`;
const CHAT_MESSAGE = { id: '6f0c1c1e-0000-4000-8000-000000000001', worktreeId: WT, role: 'user', content: 'hello' };

/** Everything but `/send`: a bound relay, a note, a relay lookup that cannot settle anything. */
function around(send: SendOutcomeRoute): Record<string, SendOutcomeRoute> {
  return {
    '/api/capabilities': { kind: 'json', status: 200, body: { serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] } },
    [`/api/worktrees/${WT}/resolve-target`]: {
      kind: 'json',
      status: 200,
      body: { cliToolId: 'codex', instanceId: 'codex', resolvedBy: 'explicit', conflict: null },
    },
    '/api/relays': { kind: 'json', status: 201, body: { relay: { id: RELAY, bindMode: 'bound' }, bindMode: 'bound' } },
    [CANCEL]: { kind: 'json', status: 200, body: { ok: true } },
    // A copy waiting for the input lock reads `awaiting` too: it settles nothing.
    [`/api/relays/${RELAY}`]: { kind: 'json', status: 200, body: { relay: { id: RELAY, state: 'pending', sendState: 'awaiting' } } },
    [`/api/worktrees/${ME}/mem/items`]: { kind: 'json', status: 201, body: { ok: true, item: { id: 'item-1' }, replayed: false, warnings: [] } },
    [NOTE_CLOSE]: { kind: 'json', status: 200, body: { ok: true, item: { id: 'item-1' } } },
    '/page': { kind: 'reply', status: 200, contentType: 'text/html', body: '<html><body>signed out</body></html>' },
    [SEND]: send,
  };
}

const SESSION_ENV = [
  'TMUX', 'TMUX_PANE', 'CM_WORKTREE_ID', 'CM_AGENT_WORKTREE_ID', 'CM_INSTANCE_ID', 'CM_AGENT_INSTANCE_ID',
  'CM_CLI_TOOL', 'CM_AGENT_TOOL', 'CM_PORT', 'CM_BIND', 'CM_HTTPS_CERT', 'CM_HTTPS_KEY', 'CM_AUTH_TOKEN',
  'CM_UAT_ISOLATION', 'HOME',
];
let saved: Record<string, string | undefined>;
let home: string;
let errors: string[];
let exitCode: number | undefined;
const servers: SendOutcomeServer[] = [];

beforeEach(() => {
  saved = {};
  for (const name of SESSION_ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'send-outcome-http-4535-'));
  process.env.HOME = home;
  process.env.CM_UAT_ISOLATION = '1';
  process.env.CM_BIND = '127.0.0.1';
  process.env.CM_WORKTREE_ID = ME;
  process.env.CM_CLI_TOOL = 'claude';
  errors = [];
  exitCode = undefined;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    if (exitCode === undefined) exitCode = code;
    throw new Error(`exit:${code}`);
  }) as never);
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

async function serve(routes: Record<string, SendOutcomeRoute>): Promise<SendOutcomeServer> {
  const server = await startSendOutcomeServer(routes);
  servers.push(server);
  return server;
}

/** `send wt1 hello --instance codex --reply-to self --note …` against `server`. */
async function sendTo(server: SendOutcomeServer): Promise<number | undefined> {
  process.env.CM_PORT = new URL(server.url).port;
  await createSendCommand()
    .parseAsync(['node', 'send', WT, 'hello', '--instance', 'codex', '--reply-to', 'self', '--note', 'waiting for it'])
    .catch(() => undefined);
  return exitCode;
}

const said = (): string => errors.join('\n');
const PANE_CHECK = /capture wt1 .*--pane/;

describe('R3/R4 (Issue #4535 T9): an answer that proves nothing is unknown', () => {
  it.each<[string, SendOutcomeRoute, number]>([
    ['a bare 408 HTML page', { kind: 'reply', status: 408, contentType: 'text/html', body: '<html>Request Timeout</html>' }, 99],
    ['a JSON 400 with no code', { kind: 'json', status: 400, body: { error: 'bad request' } }, 2],
    ['a non-JSON 200', { kind: 'reply', status: 200, contentType: 'text/plain', body: 'ok' }, 99],
    ['an empty 204', { kind: 'reply', status: 204 }, 99],
    ['an empty 200', { kind: 'reply', status: 200 }, 99],
    ['a JSON 200 of another shape', { kind: 'json', status: 200, body: { ok: true } }, 99],
    ['a 303 to a page', { kind: 'redirect', status: 303, location: '/page' }, 99],
    ['a 404 HTML page', { kind: 'reply', status: 404, contentType: 'text/html', body: '<html>Not Found</html>' }, 99],
    ['a 405', { kind: 'reply', status: 405 }, 99],
  ])('R3/R4: %s is unknown — no withdraw, no close, no resend', async (_label, answer, exit) => {
    const server = await serve(around(answer));
    expect(await sendTo(server)).toBe(exit);
    expect(server.posts(SEND)).toHaveLength(1);
    expect(server.requests(CANCEL)).toHaveLength(0);
    expect(server.requests(NOTE_CLOSE)).toHaveLength(0);
    expect(said()).toMatch(PANE_CHECK);
    expect(said()).not.toContain('Message sent.');
    expect(said()).not.toContain('it is safe to send it again');
  });

  it('control: a 201 ChatMessage is sent — exit 0, nothing undone', async () => {
    const server = await serve(around({ kind: 'json', status: 201, body: CHAT_MESSAGE }));
    expect(await sendTo(server)).toBeUndefined();
    expect(server.posts(SEND)).toHaveLength(1);
    expect(server.requests(CANCEL)).toHaveLength(0);
    expect(server.requests(NOTE_CLOSE)).toHaveLength(0);
    expect(said()).toContain('Message sent.');
  });
});

describe('I6 (Issue #4535 T17): a redirect is followed, and the handler sees one POST', () => {
  it('a 308 from a front is followed once — the handler sees one POST, exit 0', async () => {
    const back = await serve(around({ kind: 'json', status: 201, body: CHAT_MESSAGE }));
    const front = await serve(around({ kind: 'redirect', status: 308, location: `${back.url}${SEND}` }));
    expect(await sendTo(front)).toBeUndefined();
    expect(front.posts(SEND)).toHaveLength(1);
    expect(back.posts(SEND)).toHaveLength(1);
    expect(JSON.parse(back.posts(SEND)[0])).toMatchObject({ content: 'hello', relayId: RELAY });
    expect(said()).toContain('Message sent.');
  });
});

describe('N7 (Issue #4535 T18): a connection that was never made is not_sent', () => {
  it('ECONNREFUSED is not_sent — no unknown note, the relay is withdrawn', async () => {
    // The front sends `/send` on to a port nothing listens on: the handler is never reached.
    const nowhere = await refusedPortUrl();
    const front = await serve(around({ kind: 'redirect', status: 307, location: `${nowhere}${SEND}` }));
    await sendTo(front);
    expect(front.posts(SEND)).toHaveLength(1);
    expect(front.requests(CANCEL)).toHaveLength(1);
    expect(front.requests(NOTE_CLOSE)).toHaveLength(1);
    expect(said()).not.toMatch(PANE_CHECK);
    expect(said()).not.toContain('sendOutcome=unknown');
  });
});

/**
 * Review P2 (#4535 B): the content-type check reaches the CLI. A body that parses as
 * JSON but is not served as JSON proves nothing (design §2.2), so a front's page that
 * happens to read `{"code":"model_refused"}` must not undo anything, and a 409
 * `SEND_TARGET_CHANGED` it carries is not the proven not_sent that exit 34 says (INV-F4).
 * Red when the error keeps no answer, or `contentTypeOf` always says JSON.
 */
describe('content-type (Issue #4535 T9): a JSON body not served as JSON proves nothing', () => {
  const asPage = (status: number, body: unknown): SendOutcomeRoute => ({
    kind: 'reply',
    status,
    contentType: 'text/html',
    body: JSON.stringify(body),
  });
  const MODEL_REFUSED = { error: 'model refused', code: 'model_refused' };
  const TARGET_CHANGED = { error: 'the target changed', code: 'SEND_TARGET_CHANGED', reason: 'target-gone', sendOutcome: 'not_sent' };

  it('a 400 text/html reading {"code":"model_refused"} is unknown — no withdraw, no close', async () => {
    const server = await serve(around(asPage(400, MODEL_REFUSED)));
    await sendTo(server);
    expect(server.posts(SEND)).toHaveLength(1);
    expect(server.requests(CANCEL)).toHaveLength(0);
    expect(server.requests(NOTE_CLOSE)).toHaveLength(0);
    expect(said()).toMatch(PANE_CHECK);
    expect(said()).not.toContain('it is safe to send it again');
  });

  it('control: the same 400 served as JSON is not_sent — withdrawn and closed', async () => {
    const server = await serve(around({ kind: 'json', status: 400, body: MODEL_REFUSED }));
    await sendTo(server);
    expect(server.requests(CANCEL)).toHaveLength(1);
    expect(server.requests(NOTE_CLOSE)).toHaveLength(1);
  });

  it('a 409 SEND_TARGET_CHANGED whose sendOutcome is not served as JSON is exit 99 — nothing withdrawn', async () => {
    const server = await serve(around(asPage(409, TARGET_CHANGED)));
    expect(await sendTo(server)).toBe(99);
    expect(server.posts(SEND)).toHaveLength(1);
    expect(server.requests(CANCEL)).toHaveLength(0);
    expect(server.requests(NOTE_CLOSE)).toHaveLength(0);
    expect(said()).toMatch(PANE_CHECK);
  });

  it('control: the same 409 served as JSON is exit 34 — withdrawn and closed', async () => {
    const server = await serve(around({ kind: 'json', status: 409, body: TARGET_CHANGED }));
    expect(await sendTo(server)).toBe(34);
    expect(server.requests(CANCEL)).toHaveLength(1);
    expect(server.requests(NOTE_CLOSE)).toHaveLength(1);
  });
});

const AUTO_YES = `/api/worktrees/${WT}/auto-yes`;
const GRANT = { enabled: true, expiresAt: 1_900_000_000_000, cliToolId: 'codex', instanceId: 'codex', grantId: 'grant-1' };
const OFF = { enabled: false, expiresAt: null };

/** `around(send)` with an Auto-Yes route that is on after an arming POST and off after a disarming one. */
async function serveWithAutoYes(send: SendOutcomeRoute): Promise<SendOutcomeServer> {
  const box: { server?: SendOutcomeServer } = {};
  const routes = around(send);
  Object.defineProperty(routes, AUTO_YES, {
    enumerable: true,
    get: (): SendOutcomeRoute => {
      const last = box.server?.posts(AUTO_YES).at(-1);
      const armed = last !== undefined && (JSON.parse(last) as { enabled?: unknown }).enabled === true;
      return { kind: 'json', status: 200, body: armed ? GRANT : OFF };
    },
  });
  box.server = await serve(routes);
  return box.server;
}

/** The POSTs that turned Auto-Yes off. */
const disarms = (server: SendOutcomeServer): string[] =>
  server.posts(AUTO_YES).filter((body) => (JSON.parse(body) as { enabled?: unknown }).enabled === false);

/** `sendTo` with `--auto-yes`: a grant this send arms before the message. */
async function sendArmedTo(server: SendOutcomeServer): Promise<number | undefined> {
  process.env.CM_PORT = new URL(server.url).port;
  await createSendCommand()
    .parseAsync(['node', 'send', WT, 'hello', '--instance', 'codex', '--reply-to', 'self', '--note', 'waiting for it', '--auto-yes'])
    .catch(() => undefined);
  return exitCode;
}

/** Review P3 (#4535 B): a 2xx that is not a message (S4) leaves the grant this send armed on too. */
describe('S4 (Issue #4535 T9): Auto-Yes stays after a 2xx that is not a message', () => {
  it.each<[string, SendOutcomeRoute]>([
    ['a non-JSON 200', { kind: 'reply', status: 200, contentType: 'text/plain', body: 'ok' }],
    ['an empty 204', { kind: 'reply', status: 204 }],
    ['an empty 200', { kind: 'reply', status: 200 }],
    ['a JSON 200 of another shape', { kind: 'json', status: 200, body: { ok: true } }],
  ])('S4: %s — exit 99, the armed grant is not withdrawn', async (_label, answer) => {
    const server = await serveWithAutoYes(answer);
    expect(await sendArmedTo(server)).toBe(99);
    expect(server.posts(AUTO_YES).length).toBeGreaterThan(0);
    expect(disarms(server)).toHaveLength(0);
    expect(server.requests(CANCEL)).toHaveLength(0);
    expect(server.requests(NOTE_CLOSE)).toHaveLength(0);
  });

  it('control: a JSON 400 model_refused with not_sent — the armed grant is withdrawn', async () => {
    const server = await serveWithAutoYes({ kind: 'json', status: 400, body: { error: 'model refused', code: 'model_refused', sendOutcome: 'not_sent' } });
    await sendArmedTo(server);
    expect(disarms(server)).toHaveLength(1);
    expect(server.requests(CANCEL)).toHaveLength(1);
  });
});
