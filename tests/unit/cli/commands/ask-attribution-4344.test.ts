/**
 * `commandmate ask` reads the reply by its own id where the server can
 * (Issue #4344, design `docs/design/ask-attribution-4344.md` §0.2・§6 PR1).
 *
 * The fake server answers by route. For claude it says `tools.claude: true`, so
 * `ask` sends `ask: { id, protocol: 1 }` and reads `/api/asks/:id` after the
 * turn. The pane and the newest ledger row are given content that the old
 * paths would have printed: the positive controls fail on the old code (it
 * prints the pane tail / the newest row), the negative controls pin what does
 * not change (another tool, an older server, the exit codes, the overlap line).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { WaitExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
});

const NOW = 1_787_600_000_000;

const json = (data: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }) as unknown as Response;

const frame = (cliToolId: string, extra: Record<string, unknown> = {}) => ({
  isRunning: true,
  isPromptWaiting: false,
  content: 'done',
  fullOutput: 'done',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  cliToolId,
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as const,
  ...extra,
});

/** A previous turn's reply, newest in the ledger, in the window the old read opens. */
const staleTurnRow = {
  id: 'old',
  worktreeId: 'wt1',
  role: 'assistant',
  messageType: 'normal',
  archived: false,
  content: 'history',
  requestId: 'claude-turn:0000',
  timestamp: new Date(NOW + 2_000).toISOString(),
};

/** The top-aligned 1000-line pane: the old `⏺ history` reply and the screen's empty rows. */
const PANE = ['> history', '⏺ history', '> hi', ...Array.from({ length: 400 }, () => '')].join('\n');

interface Server {
  cliToolId: string;
  /** `/api/asks/capabilities`: a body, or a status alone. */
  capabilities?: unknown;
  capabilitiesStatus?: number;
  /** The send's `ask` answer; defaults to "pending" for the id sent. */
  sendAsk?: (askId: string | undefined) => unknown;
  /** `/api/asks/:id`, by read number. */
  attribution?: (askId: string, read: number) => unknown;
  frame?: Record<string, unknown>;
  turnOpenAtSend?: boolean;
}

interface Seen { path: string; body: Record<string, unknown> | null }
let seen: Seen[] = [];

function mockServer(server: Server): void {
  seen = [];
  let reads = 0;
  global.fetch = vi.fn((input: unknown, init?: { body?: string }) => {
    const url = new URL(String(input));
    seen.push({ path: url.pathname, body: init?.body ? JSON.parse(init.body) : null });
    if (url.pathname === '/api/capabilities') {
      return Promise.resolve(json({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] }));
    }
    if (url.pathname === '/api/asks/capabilities') {
      if (server.capabilitiesStatus) return Promise.resolve(json({ error: 'not found' }, server.capabilitiesStatus));
      return Promise.resolve(json(server.capabilities ?? { protocol: 1, tools: { claude: true, codex: false } }));
    }
    if (url.pathname.startsWith('/api/asks/')) {
      const askId = url.pathname.split('/').pop() as string;
      reads += 1;
      return Promise.resolve(json(server.attribution?.(askId, reads) ?? { askId, state: 'pending', reason: null, reply: null, sendState: 'sent', nativeInputSeen: false, notified: false }));
    }
    if (url.pathname.endsWith('/resolve-target')) {
      return Promise.resolve(json({ cliToolId: server.cliToolId, instanceId: server.cliToolId, resolvedBy: 'roster', conflict: null }));
    }
    if (url.pathname.endsWith('/send')) {
      const body = init?.body ? JSON.parse(init.body) as { ask?: { id: string } } : {};
      const ask = server.sendAsk ? server.sendAsk(body.ask?.id) : body.ask ? { id: body.ask.id, state: 'pending', reason: null, sendState: 'sent' } : undefined;
      return Promise.resolve(json({
        id: 1, timestamp: new Date(NOW + 1).toISOString(),
        ...(server.turnOpenAtSend !== undefined ? { turnOpenAtSend: server.turnOpenAtSend } : {}),
        ...(ask ? { ask } : {}),
      }, 201));
    }
    if (url.pathname.endsWith('/messages')) return Promise.resolve(json([staleTurnRow]));
    if (url.pathname.endsWith('/capture')) return Promise.resolve(json({ output: PANE }));
    return Promise.resolve(json(frame(server.cliToolId, server.frame)));
  }) as unknown as typeof fetch;
}

async function runAsk(argv: string[]): Promise<void> {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const { createAskCommand } = await import('../../../../src/cli/commands/ask');
  const pending = createAskCommand().parseAsync(['node', 'ask', ...argv]);
  await vi.advanceTimersByTimeAsync(60_000);
  await pending;
}

const stderr = (): string => mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n');
const payload = (): Record<string, unknown> => JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
const sendBodies = () => seen.filter((s) => s.path.endsWith('/send')).map((s) => s.body);
const captures = () => seen.filter((s) => s.path.endsWith('/capture'));

const settled = (state: string, extra: Record<string, unknown> = {}) => (askId: string) =>
  ({ askId, state, reason: null, reply: null, sendState: 'sent', nativeInputSeen: true, notified: false, ...extra });

describe('ask on claude: the reply by the ask\'s own id (Issue #4344)', () => {
  it('(1) prints the matched reply in full — not the pane tail, not the newest row', async () => {
    const long = Array.from({ length: 305 }, (_, i) => `line ${i + 1}`).join('\n');
    mockServer({ cliToolId: 'claude', attribution: settled('matched', { reply: long }) });
    await runAsk(['wt1', 'write 305 lines', '--instance', 'claude']);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    expect(mockConsoleLog).toHaveBeenCalledWith(long);
    const [body] = sendBodies();
    expect(body).toMatchObject({ content: 'write 305 lines', cliToolId: 'claude', instanceId: 'claude', ask: { protocol: 1 } });
    expect(String((body?.ask as { id: string }).id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(captures()).toHaveLength(0);
  });

  it('(2) same text: ask `hi`, reply `hi` is printed exactly', async () => {
    mockServer({ cliToolId: 'claude', attribution: settled('matched', { reply: 'hi' }) });
    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);
    expect(payload()).toMatchObject({ source: 'history', reply: 'hi', attribution: { state: 'matched' } });
    expect(typeof payload().askId).toBe('string');
  });

  it('(2) no correspondence: reply null — the old `⏺ history` on the pane and the newest row are not taken', async () => {
    mockServer({ cliToolId: 'claude', attribution: settled('unmatched', { reason: 'envelope_lost', nativeInputSeen: false }) });
    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(payload()).toMatchObject({ source: 'none', reply: null, attribution: { state: 'unmatched', reason: 'envelope_lost' } });
    expect(captures()).toHaveLength(0);
    expect(stderr()).toContain('reply not collected: unmatched (envelope_lost)');
  });

  it('(3) a turn that never settles in the grace: unmatched/turn_incomplete, no earlier turn printed', async () => {
    mockServer({ cliToolId: 'claude', attribution: (askId) => ({ askId, state: 'pending', reason: null, reply: null, sendState: 'sent', nativeInputSeen: true, notified: false }) });
    await runAsk(['wt1', 'hi', '--instance', 'claude']);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(stderr()).toContain('reply not collected: unmatched (turn_incomplete)');
  });

  it('(4) a shared turn is ambiguous: stdout empty, the reason on stderr', async () => {
    mockServer({ cliToolId: 'claude', attribution: settled('ambiguous', { reason: 'shared_turn' }) });
    await runAsk(['wt1', 'hi', '--instance', 'claude']);
    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(stderr()).toContain('reply not collected: ambiguous (shared_turn)');
    expect(stderr()).toContain('capture wt1 --instance claude --pane');
  });

  it('(4) a turn that took only a background notice: the reply, and notified in --json (§7 (a) ②)', async () => {
    mockServer({ cliToolId: 'claude', attribution: settled('matched', { reply: 'ok', notified: true }) });
    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);
    expect(payload()).toMatchObject({ reply: 'ok', attribution: { state: 'matched', notified: true } });
  });

  it('(7) M4: a command body is unavailable/slash_command and the pane is not read', async () => {
    mockServer({ cliToolId: 'claude', sendAsk: () => ({ id: null, state: 'unavailable', reason: 'slash_command' }) });
    await runAsk(['wt1', '/compact', '--instance', 'claude', '--json']);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(sendBodies()[0]).toMatchObject({ content: '/compact' });
    expect(payload()).toMatchObject({ source: 'none', reply: null, askId: null, attribution: { state: 'unavailable', reason: 'slash_command' } });
    expect(stderr()).toContain('claude has no ask attribution (slash_command)');
    expect(captures()).toHaveLength(0);
  });

  it('(11) the server\'s R3 answer is passed through (ambiguous/turn_open_at_send) and the overlap line stays', async () => {
    mockServer({ cliToolId: 'claude', turnOpenAtSend: true, attribution: settled('ambiguous', { reason: 'turn_open_at_send' }) });
    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);
    expect(payload()).toMatchObject({ reply: null, attribution: { state: 'ambiguous', reason: 'turn_open_at_send' }, overlapped: true });
    expect(stderr()).toContain('overlapped:');
  });

  it('sends once and reads by id only: no second /send', async () => {
    mockServer({ cliToolId: 'claude', attribution: settled('matched', { reply: 'x' }) });
    await runAsk(['wt1', 'hi', '--instance', 'claude']);
    expect(sendBodies()).toHaveLength(1);
  });
});

describe('negative controls: what does not change', () => {
  it('an older server (capabilities 404) takes the old path, with the old send body', async () => {
    mockServer({ cliToolId: 'claude', capabilitiesStatus: 404 });
    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);
    expect(sendBodies()[0]).toEqual({ content: 'hi', cliToolId: 'claude', instanceId: 'claude' });
    expect(payload()).toEqual({ worktreeId: 'wt1', instanceId: 'claude', cliToolId: 'claude', source: 'history', reply: 'history' });
  });

  it('a server that says claude is not attributed takes the old path', async () => {
    mockServer({ cliToolId: 'claude', capabilities: { protocol: 1, tools: { claude: false } } });
    await runAsk(['wt1', 'hi', '--instance', 'claude', '--json']);
    expect(sendBodies()[0]).not.toHaveProperty('ask');
    expect(payload()).not.toHaveProperty('attribution');
  });

  it('another tool (codex) is not asked about and sends the body it always sent', async () => {
    mockServer({ cliToolId: 'codex' });
    await runAsk(['wt1', 'hi', '--instance', 'codex', '--json']);
    expect(seen.some((s) => s.path === '/api/asks/capabilities')).toBe(false);
    expect(sendBodies()[0]).toEqual({ content: 'hi', cliToolId: 'codex', instanceId: 'codex' });
  });

  it('--async is the relay path: no capabilities request, no ask field', async () => {
    mockServer({ cliToolId: 'claude' });
    await runAsk(['wt1', 'hi', '--instance', 'claude', '--async']).catch(() => {});
    expect(seen.some((s) => s.path === '/api/asks/capabilities')).toBe(false);
    for (const body of sendBodies()) expect(body).not.toHaveProperty('ask');
  });

  it('a prompt is still exit 10 with its payload, and the ledger is not read', async () => {
    mockServer({
      cliToolId: 'claude',
      frame: { isPromptWaiting: true, sessionStatus: 'waiting', promptData: { type: 'yes_no', question: 'Continue?', options: ['yes', 'no'], status: 'pending' } },
    });
    await runAsk(['wt1', 'hi', '--instance', 'claude']);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(seen.some((s) => /^\/api\/asks\/[0-9a-f-]{36}$/.test(s.path))).toBe(false);
  });
});
