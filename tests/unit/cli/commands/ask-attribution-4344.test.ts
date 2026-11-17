/**
 * `commandmate ask` reads its reply by its own id (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §0.2・§3.6 cell 17・§6 PR3).
 *
 * PR1 (claude) and PR2 (codex) built the server side: `GET /api/asks/capabilities`,
 * the `ask: { id, protocol: 1 }` field of `POST /send`, and `GET /api/asks/:askId`.
 * PR3 switches the CLI onto them. What is pinned here:
 *
 * Positive (red before PR3 — the old `ask` printed "the newest reply", falling
 * back to the pane):
 *  (1) copilot (capability false): `unavailable/tool_unsupported`, the screen is
 *      not read, exit 0;
 *  (2) capabilities 404 (an older server): `server_unsupported`, the old body,
 *      sent once, the screen not read, exit 0;
 *  PR1 (1) a claude reply at line 305 of a top-aligned pane comes back whole
 *      from the ledger; PR1 (2) a screen holding `hi` and an old reply, with no
 *      attribution, is not taken; `hi` answered `hi` is exactly `hi`; PR1 (3) the
 *      previous turn's row landing after the send is not taken (turn_incomplete);
 *  cell 17: grace expiry prints `unmatched/grace_expired` and writes nothing.
 *
 * Negative (unchanged): exit 10 / 11 / 21 / 124 read no ledger; `--async` reads no
 * capability and names no id; an instance alias still addresses the resolved
 * instance.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode, WaitExitCode } from '../../../../src/cli/types';
import { RELAY_CREATED, frame, mockServer, start, type Route } from './command-deadline-server';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('CM_PORT', '3999');
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Long enough for every poll sleep and the 15 s reply grace. */
const DRAIN_MS = 60_000;

const PR2_TOOLS = { claude: true, codex: true, copilot: false, gemini: false, 'vibe-local': false, opencode: false };

const stderrText = (): string => mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n');
const stdoutLines = (): string[] => mockConsoleLog.mock.calls.map((c) => String(c[0]));
const firstExit = (): unknown => mockExit.mock.calls[0]?.[0];
const payload = (): Record<string, unknown> => JSON.parse(stdoutLines()[0]);

interface Request {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

function requests(): Request[] {
  return vi.mocked(global.fetch).mock.calls.map(([input, init]) => {
    const options = init as RequestInit | undefined;
    return {
      method: options?.method ?? 'GET',
      path: new URL(String(input)).pathname,
      body: options?.body ? (JSON.parse(String(options.body)) as Record<string, unknown>) : null,
    };
  });
}
const sends = (): Request[] => requests().filter((r) => r.method === 'POST' && r.path.endsWith('/send'));
const toPath = (fragment: string): Request[] => requests().filter((r) => r.path.includes(fragment));
/** Reads of an ask's own attribution (not the capability table). */
const askReads = (): Request[] => requests().filter((r) => /^\/api\/asks\/(?!capabilities$)/.test(r.path));

/** `POST /send` of a #4344 server: the reserved ask comes back `pending`/`sent`. */
const SEND: Route = (_url, init) => {
  const ask = (JSON.parse(String(init?.body ?? '{}')) as { ask?: { id: string } }).ask;
  return {
    id: 'm1',
    worktreeId: 'wt1',
    role: 'user',
    content: 'x',
    timestamp: new Date().toISOString(),
    ...(ask ? { ask: { id: ask.id, state: 'pending', reason: null, sendState: 'sent' } } : {}),
  };
};

/** `GET /api/asks/:askId`, answering `fields` for whatever id was asked. */
function ledger(fields: (() => Record<string, unknown>) | Record<string, unknown>): Route {
  return (url) => ({
    askId: url.pathname.split('/').pop(),
    state: 'pending',
    reason: null,
    reply: null,
    sendState: 'sent',
    nativeInputSeen: false,
    notified: false,
    ...(typeof fields === 'function' ? fields() : fields),
  });
}

const resolveAs = (cliToolId: string, instanceId = cliToolId): Route => () => ({
  cliToolId, instanceId, resolvedBy: 'roster', conflict: null,
});

const frameOf = (cliToolId: string, extra: Record<string, unknown> = {}) => ({ ...frame, cliToolId, ...extra });

/** A top-aligned 1000-line pane with the reply at its top (the #4315 5-2b screen). */
function topAlignedPane(reply: string): string {
  return [reply, ...Array.from({ length: 1000 - reply.split('\n').length }, () => '')].join('\n');
}

async function runAsk(args: string[], drainMs = DRAIN_MS): Promise<void> {
  const run = await start('ask', args);
  await vi.advanceTimersByTimeAsync(drainMs);
  await run.pending;
}

describe('PR3 (1)(2): a tool or server that cannot attribute does not collect (Issue #4344 §0.2)', () => {
  it('(1) copilot: unavailable/tool_unsupported, no ask id on the send, the screen not read, exit 0', async () => {
    mockServer({
      '/resolve-target': resolveAs('copilot'),
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frameOf('copilot'),
      '/messages': [{ id: 'r', worktreeId: 'wt1', role: 'assistant', content: 'scraped', timestamp: new Date(Date.now() + 1_000).toISOString(), messageType: 'normal' }],
      'POST /capture': { output: 'copilot said this\n' },
    });

    await runAsk(['wt1', 'hi', '--instance', 'copilot', '--json']);

    expect(firstExit()).toBe(ExitCode.SUCCESS);
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body).toEqual({ content: 'hi', cliToolId: 'copilot', instanceId: 'copilot' });
    expect(toPath('/capture')).toHaveLength(0);
    expect(toPath('/messages')).toHaveLength(0);
    expect(askReads()).toHaveLength(0);
    expect(payload()).toEqual({
      worktreeId: 'wt1',
      instanceId: 'copilot',
      cliToolId: 'copilot',
      source: 'none',
      reply: null,
      askId: null,
      attribution: { state: 'unavailable', reason: 'tool_unsupported', notified: false },
    });
    expect(stderrText()).toContain('reply not collected (unavailable/tool_unsupported): copilot: ');
    expect(stderrText()).toContain('capture wt1 --instance copilot --pane');
  });

  it('(1) in text mode stdout is empty and stderr says why', async () => {
    mockServer({
      '/resolve-target': resolveAs('gemini'),
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frameOf('gemini'),
      'POST /capture': { output: 'gemini said this\n' },
    });

    await runAsk(['wt1', 'hi', '--instance', 'gemini']);

    expect(firstExit()).toBe(ExitCode.SUCCESS);
    expect(stdoutLines()).toEqual([]);
    expect(stderrText()).toMatch(/^reply not collected \(unavailable\/tool_unsupported\)/m);
    expect(toPath('/capture')).toHaveLength(0);
  });

  it('a tool the table does not name at all is tool_unsupported too', async () => {
    mockServer({
      '/resolve-target': resolveAs('command-code'),
      '/api/asks/capabilities': { protocol: 1, tools: { claude: true } },
      'POST /send': SEND,
      '/current-output': frameOf('command-code'),
    });

    await runAsk(['wt1', 'hi', '--instance', 'command-code', '--json']);

    expect(payload()).toMatchObject({ reply: null, attribution: { state: 'unavailable', reason: 'tool_unsupported' } });
    expect(sends()[0].body).not.toHaveProperty('ask');
  });

  it('(2) capabilities 404: server_unsupported, the old body sent once, the screen not read, exit 0', async () => {
    mockServer({
      '/api/asks/capabilities': { status: 404, data: { error: 'Not found' } },
      'POST /send': SEND,
      '/current-output': frame,
      '/messages': [{ id: 'r', worktreeId: 'wt1', role: 'assistant', content: 'old', requestId: 'claude-turn:x', timestamp: new Date(Date.now() + 1_000).toISOString(), messageType: 'normal' }],
      'POST /capture': { output: 'pane\n' },
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);

    expect(firstExit()).toBe(ExitCode.SUCCESS);
    expect(sends()).toHaveLength(1);
    expect(sends()[0].body).toEqual({ content: 'hi', cliToolId: 'claude', instanceId: 'claude' });
    expect(toPath('/capture')).toHaveLength(0);
    expect(toPath('/messages')).toHaveLength(0);
    expect(askReads()).toHaveLength(0);
    expect(payload()).toMatchObject({
      source: 'none',
      reply: null,
      askId: null,
      attribution: { state: 'unavailable', reason: 'server_unsupported', notified: false },
    });
    expect(stderrText()).toContain('reply not collected (unavailable/server_unsupported)');
  });

  it('a send answer with no `ask` (the field was not read) is server_unsupported, not a ledger read', async () => {
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': { id: 'm1' },
      '/current-output': frame,
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);

    expect(sends()[0].body).toHaveProperty('ask');
    expect(askReads()).toHaveLength(0);
    expect(payload()).toMatchObject({ reply: null, attribution: { state: 'unavailable', reason: 'server_unsupported' } });
  });

  it('a protocol this CLI does not speak is server_unsupported, sent with the old body', async () => {
    mockServer({
      '/api/asks/capabilities': { protocol: 2, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frame,
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);

    expect(sends()[0].body).not.toHaveProperty('ask');
    expect(payload()).toMatchObject({ attribution: { state: 'unavailable', reason: 'server_unsupported' } });
  });

  it('a capability read that fails otherwise (500) ends the command before the send (design §0.2)', async () => {
    mockServer({
      '/api/asks/capabilities': { status: 500, data: { error: 'boom' } },
      'POST /send': SEND,
      '/current-output': frame,
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude']);

    expect(firstExit()).not.toBe(ExitCode.SUCCESS);
    expect(sends()).toHaveLength(0);
  });

  it('a malformed capability answer ends the command before the send rather than guessing', async () => {
    mockServer({
      '/api/asks/capabilities': { serverVersion: 'x' },
      'POST /send': SEND,
      '/current-output': frame,
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude']);

    expect(firstExit()).toBe(ExitCode.UNEXPECTED_ERROR);
    expect(sends()).toHaveLength(0);
    expect(stderrText()).toContain('/api/asks/capabilities');
  });

  it('the server turning a command body down (slash_command) reads no ledger', async () => {
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': { id: 'm1', ask: { id: null, state: 'unavailable', reason: 'slash_command' } },
      '/current-output': frame,
    });

    await runAsk(['wt1', '/compact', '--instance', 'claude', '--json']);

    expect(sends()[0].body).toMatchObject({ content: '/compact' });
    expect(askReads()).toHaveLength(0);
    expect(payload()).toMatchObject({ reply: null, askId: null, attribution: { state: 'unavailable', reason: 'slash_command' } });
  });
});

describe('PR1 (1)(2)(3) through the CLI: the reply is the ledger\'s, never the screen (Issue #4344)', () => {
  it('(1) a claude reply at line 305 of a top-aligned pane comes back whole', async () => {
    const reply = Array.from({ length: 305 }, (_, i) => `line ${i + 1} of the review`).join('\n');
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frame,
      'GET /api/asks/': ledger({ state: 'matched', reply, nativeInputSeen: true }),
      '/messages': [],
      'POST /capture': { output: topAlignedPane(reply) },
    });

    await runAsk(['wt1', 'review this', '--instance', 'claude']);

    expect(firstExit()).toBe(ExitCode.SUCCESS);
    expect(stdoutLines()).toEqual([reply]);
    expect(toPath('/capture')).toHaveLength(0);
  });

  it('(1) codex: the matched reply is returned in full (consistency-review.mjs reads `reply` of --json)', async () => {
    const reply = `# Review\n\n${Array.from({ length: 200 }, (_, i) => `- [P2] finding ${i}`).join('\n')}\n\nDONE: review`;
    mockServer({
      '/resolve-target': resolveAs('codex'),
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frameOf('codex'),
      'GET /api/asks/': ledger({ state: 'matched', reply, nativeInputSeen: true }),
      '/messages': [],
    });

    await runAsk(['wt1', 'Read the brief and review', '--instance', 'codex', '--json']);

    expect(payload()).toMatchObject({ source: 'history', reply, attribution: { state: 'matched', reason: null } });
    expect(String(payload().askId)).toBe((sends()[0].body?.ask as { id: string }).id);
  });

  it('(2) a screen with `hi` and an old reply, and no attribution: the old reply is not taken', async () => {
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frame,
      'GET /api/asks/': ledger({ state: 'pending' }),
      '/messages': [{ id: 'old', worktreeId: 'wt1', role: 'assistant', content: 'the previous answer', requestId: 'claude-turn:old', timestamp: new Date(Date.now() + 500).toISOString(), messageType: 'normal' }],
      'POST /capture': { output: '> hi\n⏺ the previous answer\n' },
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);

    expect(payload()).toMatchObject({ source: 'none', reply: null, attribution: { state: 'unmatched', reason: 'grace_expired' } });
    expect(JSON.stringify(payload())).not.toContain('previous answer');
    expect(toPath('/capture')).toHaveLength(0);
  });

  it('(2) `hi` answered `hi` is exactly `hi`', async () => {
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frame,
      'GET /api/asks/': ledger({ state: 'matched', reply: 'hi', nativeInputSeen: true }),
      '/messages': [],
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude']);

    expect(stdoutLines()).toEqual(['hi']);
  });

  it('(3) the previous turn ending after the send is not taken: turn_incomplete', async () => {
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frame,
      'GET /api/asks/': ledger({ state: 'pending', nativeInputSeen: true }),
      '/messages': [{ id: 'prev', worktreeId: 'wt1', role: 'assistant', content: 'previous turn', requestId: 'claude-turn:prev', timestamp: new Date(Date.now() + 2_000).toISOString(), messageType: 'normal' }],
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);

    expect(payload()).toMatchObject({ reply: null, attribution: { state: 'unmatched', reason: 'turn_incomplete' } });
    expect(stderrText()).toContain('reply not collected (unmatched/turn_incomplete)');
  });

  it('waits inside the grace for a pending ask to settle, re-reading by id', async () => {
    const settlesAt = Date.now() + 5_200;
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frame,
      'GET /api/asks/': ledger(() => (Date.now() >= settlesAt
        ? { state: 'matched', reply: '11', nativeInputSeen: true }
        : { state: 'pending' })),
      '/messages': [],
    });

    await runAsk(['wt1', '5+6', '--instance', 'claude']);

    expect(stdoutLines()).toEqual(['11']);
    expect(askReads().length).toBeGreaterThan(1);
    expect(new Set(askReads().map((r) => r.path)).size).toBe(1);
  });
});

describe('the attribution states the ledger settles on (Issue #4344 §3.3)', () => {
  it.each([
    ['ambiguous', 'shared_turn'],
    ['ambiguous', 'turn_open_at_send'],
    ['unmatched', 'absorbed_mid_turn'],
    ['unmatched', 'envelope_duplicated'],
    ['unmatched', 'body_truncated'],
    ['unmatched', 'turn_interrupted'],
    ['unmatched', 'not_sent'],
    ['unmatched', 'history_missing'],
    ['unmatched', 'history_changed'],
  ])('%s/%s: reply null, the state and reason as the ledger said, exit 0', async (state, reason) => {
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frame,
      'GET /api/asks/': ledger({ state, reason, nativeInputSeen: true }),
      '/messages': [],
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);

    expect(firstExit()).toBe(ExitCode.SUCCESS);
    expect(payload()).toMatchObject({ source: 'none', reply: null, attribution: { state, reason, notified: false } });
    expect(stderrText()).toContain(`reply not collected (${state}/${reason})`);
    // Settled on the first read: no grace spent.
    expect(askReads()).toHaveLength(1);
  });

  it('matched with notified: the reply, notified:true, and a note on stderr (§7 (a) ②)', async () => {
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frame,
      'GET /api/asks/': ledger({ state: 'matched', reply: 'done', nativeInputSeen: true, notified: true }),
      '/messages': [],
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);

    expect(payload()).toMatchObject({ reply: 'done', attribution: { state: 'matched', reason: null, notified: true } });
    expect(stderrText()).toContain('background-task notification');
  });

  it('a matched reply keeps its whitespace and loses only escape bytes', async () => {
    const ESC = String.fromCharCode(27);
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frame,
      'GET /api/asks/': ledger({ state: 'matched', reply: `  indented\n${ESC}[1mbold${ESC}[0m\n`, nativeInputSeen: true }),
      '/messages': [],
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude']);

    expect(stdoutLines()).toEqual(['  indented\nbold\n']);
  });
});

describe('§3.6 cell 17: the reply grace runs out (Issue #4344)', () => {
  it('grace expiry prints unmatched/grace_expired and leaves the row pending', async () => {
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frame,
      'GET /api/asks/': ledger({ state: 'pending' }),
      '/messages': [],
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);

    expect(firstExit()).toBe(ExitCode.SUCCESS);
    expect(payload()).toMatchObject({ reply: null, attribution: { state: 'unmatched', reason: 'grace_expired' } });
    // Nothing is written to the ledger: every request to /api/asks is a GET.
    expect(requests().filter((r) => r.path.startsWith('/api/asks')).every((r) => r.method === 'GET')).toBe(true);
    expect(askReads().length).toBeGreaterThan(1);
  });

  it('a pending ask whose send outcome is unknown is send_unknown', async () => {
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frame,
      'GET /api/asks/': ledger({ state: 'pending', sendState: 'send_unknown' }),
      '/messages': [],
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);

    expect(payload()).toMatchObject({ attribution: { state: 'unmatched', reason: 'send_unknown' } });
  });

  it('a ledger read that never answers ends at the grace, exit 0 (not 124)', async () => {
    mockServer({
      '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
      'POST /send': SEND,
      '/current-output': frame,
      'GET /api/asks/': 'hang',
      '/messages': [],
    });

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--timeout', '2', '--json']);

    expect(firstExit()).toBe(ExitCode.SUCCESS);
    expect(payload()).toMatchObject({ attribution: { state: 'unmatched', reason: 'grace_expired' } });
  });
});

describe('negative controls: what PR3 leaves as it was (Issue #4344 §6)', () => {
  const capable = (extra: Record<string, Route>): Record<string, Route> => ({
    '/api/asks/capabilities': { protocol: 1, tools: PR2_TOOLS },
    'POST /send': SEND,
    'GET /api/asks/': ledger({ state: 'matched', reply: 'never read' }),
    ...extra,
  });

  it('exit 10 (a prompt): the payload, and no ledger read', async () => {
    mockServer(capable({
      '/current-output': frameOf('claude', {
        isPromptWaiting: true,
        sessionStatus: 'waiting',
        promptData: { type: 'yes_no', question: 'Continue?', options: ['yes', 'no'], status: 'pending' },
      }),
    }));

    await runAsk(['wt1', 'hi', '--instance', 'claude']);

    expect(firstExit()).toBe(WaitExitCode.PROMPT_DETECTED);
    expect(askReads()).toHaveLength(0);
    expect(toPath('/prompt-response')).toHaveLength(0);
  });

  it('exit 11 (an upstream fault): no ledger read', async () => {
    mockServer(capable({
      '/current-output': frameOf('claude', { upstreamFault: { id: 'context-limit', matchedText: 'Context limit reached' } }),
    }));

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);

    expect(firstExit()).toBe(WaitExitCode.UPSTREAM_FAULT);
    expect(askReads()).toHaveLength(0);
  });

  it('exit 21 (nothing running): no ledger read', async () => {
    mockServer(capable({
      '/current-output': frameOf('claude', { isRunning: false, sessionStatus: 'idle', sessionStatusReason: null }),
    }));

    await runAsk(['wt1', 'hi', '--instance', 'claude']);

    expect(firstExit()).toBe(21);
    expect(askReads()).toHaveLength(0);
  });

  it('exit 124 (timed out): no ledger read', async () => {
    mockServer(capable({
      '/current-output': frameOf('claude', { sessionStatus: 'running', sessionStatusReason: 'thinking_indicator', thinking: true }),
    }));

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--timeout', '2']);

    expect(firstExit()).toBe(WaitExitCode.TIMEOUT);
    expect(askReads()).toHaveLength(0);
  });

  it('--async: no capability read, no ask id on the send, the relay id as before', async () => {
    mockServer(capable({
      'POST /api/relays': RELAY_CREATED,
      '/current-output': frame,
    }));

    await runAsk(['wt1', 'hi', '--instance', 'claude', '--async', '--reply-to', 'wt0@claude']);

    expect(firstExit()).toBe(ExitCode.SUCCESS);
    expect(toPath('/api/asks/capabilities')).toHaveLength(0);
    expect(sends()[0].body).not.toHaveProperty('ask');
    expect(stdoutLines()).toEqual(['relay-1']);
  });

  it('an instance alias: the capability is the resolved tool\'s, the send and the read address the resolved instance', async () => {
    mockServer(capable({
      '/resolve-target': resolveAs('codex', 'codex-2'),
      '/current-output': frameOf('codex'),
      'GET /api/asks/': ledger({ state: 'matched', reply: '2 です', nativeInputSeen: true }),
      '/messages': [],
    }));

    await runAsk(['wt1', '1+1は？', '--instance', 'Codex 2', '--json']);

    expect(sends()[0].body).toMatchObject({ cliToolId: 'codex', instanceId: 'codex-2', ask: { protocol: 1 } });
    expect(payload()).toMatchObject({ instanceId: 'codex-2', cliToolId: 'codex', reply: '2 です' });
    expect(askReads()).toHaveLength(1);
    expect(askReads()[0].path).toBe(`/api/asks/${(sends()[0].body?.ask as { id: string }).id}`);
  });
});
