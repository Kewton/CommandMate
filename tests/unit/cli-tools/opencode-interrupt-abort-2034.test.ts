/**
 * Issue #2034: `OpenCodeTool.interrupt()` takes the server route when it can.
 *
 * `POST /session/:id/abort` ends the turn outright. The keystroke route it
 * replaces cannot claim that unconditionally: two Escapes inside a five-second
 * footer label (#1894) is a bet on what the TUI has drawn, and a picker or a
 * dialog on screen eats the presses.
 *
 * ## What is real here and what is stubbed
 *
 * The tool, `abortOpencodeTurn` and the client are all the real thing — only
 * `fetch`, tmux, the port table and the subscription are stubbed. So the
 * assertions below are about the request that actually goes out
 * (`http://127.0.0.1:4298/session/ses_…/abort`, `POST`, `redirect: manual`),
 * not about a mock standing in for it: deleting the call from `interrupt()`
 * turns the first two tests red, and so does deleting it from
 * `abortOpencodeTurn`.
 *
 * ## The fallback is the point
 *
 * Every way the server route can fail to apply — no port (a pane launched with
 * `CM_AGENT_HOOKS_INJECT=0`, or an opencode too old for `--port`), a
 * subscription that is not live, no session the gate calls this instance's, a
 * refused request, an abort the server accepted and did not act on — has a test
 * that ends in exactly two Escapes. `tests/unit/cli-tools/opencode-interrupt-1894.test.ts`
 * is the other half of that: it runs with no port assigned at all and is
 * untouched by this Issue.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  capturePane: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn(),
  killSession: vi.fn(),
  exactTarget: vi.fn((name: string) => `=${name}:`),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('@/lib/cli-tools/opencode-config', () => ({
  ensureOpencodeConfig: vi.fn(),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/hooks/sources/opencode/ports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/ports')>();
  return { ...actual, getAssignedOpencodePort: vi.fn() };
});

vi.mock('@/lib/hooks/sources/opencode/subscription', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/subscription')>();
  return {
    ...actual,
    getOpencodeLiveness: vi.fn(),
    getOpencodePrimarySession: vi.fn(),
    watchOpencodeSessionIdle: vi.fn(),
  };
});

import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { OPENCODE_ABORT_IDLE_TIMEOUT_MS } from '@/lib/hooks/sources/opencode/runtime';
import { getAssignedOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import {
  getOpencodeLiveness,
  getOpencodePrimarySession,
  watchOpencodeSessionIdle,
} from '@/lib/hooks/sources/opencode/subscription';
import { sendSpecialKey } from '@/lib/tmux/tmux';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';

const PORT = 4298;
/** The session id from this Issue's live capture on 1.18.22. */
const SESSION = 'ses_fc981bbfbffehcj99HRR4GwkkC';
const SESSION_NAME = 'mcbd-opencode-wt-2034';

const sendSpecialKeyMock = vi.mocked(sendSpecialKey);
const invalidateCacheMock = vi.mocked(invalidateCache);
const getPortMock = vi.mocked(getAssignedOpencodePort);
const livenessMock = vi.mocked(getOpencodeLiveness);
const primaryMock = vi.mocked(getOpencodePrimarySession);
const watchMock = vi.mocked(watchOpencodeSessionIdle);

const originalFetch = globalThis.fetch;

/**
 * Answer the abort request the way the live server did.
 *
 * Measured on 1.18.22: `200`, `content-type: application/json`, body `true`.
 */
function stubAbort(body: unknown = true, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** A watch that answers `seen` without any real subscription behind it. */
function stubWatch(seen: boolean) {
  const cancel = vi.fn();
  watchMock.mockReturnValue({ seen: Promise.resolve(seen), cancel });
  return cancel;
}

/** The state in which the server route applies: port, live stream, session. */
function connected(): void {
  getPortMock.mockReturnValue(PORT);
  livenessMock.mockReturnValue({ state: 'live', lastHeartbeatAt: 1 });
  primaryMock.mockReturnValue(SESSION);
}

describe('Issue #2034: interrupt over the opencode server', () => {
  let tool: OpenCodeTool;

  beforeEach(() => {
    vi.clearAllMocks();
    sendSpecialKeyMock.mockResolvedValue(undefined);
    getPortMock.mockReturnValue(null);
    livenessMock.mockReturnValue({ state: 'unknown' });
    primaryMock.mockReturnValue(null);
    stubWatch(true);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('no stub')) as unknown as typeof fetch;
    tool = new OpenCodeTool();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs the abort to the instance\'s own port and session', async () => {
    connected();
    const fetchMock = stubAbort();

    await tool.interrupt('wt-2034');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:${PORT}/session/${SESSION}/abort`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
  });

  it('does not touch the keyboard once the server confirmed the turn ended', async () => {
    connected();
    stubAbort();

    await tool.interrupt('wt-2034');

    expect(sendSpecialKeyMock).not.toHaveBeenCalled();
    // Issue #405: the pane changed, and the capture cache has a 5 s TTL — the
    // same order as the interrupt itself. The API path owes this as much as the
    // keystroke path does.
    expect(invalidateCacheMock).toHaveBeenCalledWith(SESSION_NAME);
  });

  it('arms the idle watch before the request, and on the aborted session', async () => {
    // Measured: the first `session.idle` was emitted in the same millisecond the
    // abort replied. A watch armed after the await is racing its own completion.
    connected();
    const order: string[] = [];
    watchMock.mockImplementation(() => {
      order.push('watch');
      return { seen: Promise.resolve(true), cancel: vi.fn() };
    });
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      order.push('fetch');
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => true,
      };
    }) as unknown as typeof fetch;

    await tool.interrupt('wt-2034');

    expect(order).toEqual(['watch', 'fetch']);
    expect(watchMock).toHaveBeenCalledWith(
      { worktreeId: 'wt-2034', cliToolId: 'opencode', instanceId: undefined },
      SESSION,
      OPENCODE_ABORT_IDLE_TIMEOUT_MS
    );
  });

  it('addresses the additional instance, not the primary pane', async () => {
    // Issue #868: an extra instance is a separate tmux session AND a separate
    // port assignment. Aborting the primary one would end the wrong agent's turn.
    connected();
    stubAbort();

    await tool.interrupt('wt-2034', 'opencode-2');

    expect(getPortMock).toHaveBeenCalledWith({
      worktreeId: 'wt-2034',
      cliToolId: 'opencode',
      instanceId: 'opencode-2',
    });
    expect(sendSpecialKeyMock).not.toHaveBeenCalled();
  });

  describe('falls back to Escape twice', () => {
    /** Two Escapes on the primary pane and no HTTP request at all. */
    async function expectKeyboardFallback(fetchMock?: ReturnType<typeof vi.fn>): Promise<void> {
      expect(sendSpecialKeyMock).toHaveBeenCalledTimes(2);
      expect(sendSpecialKeyMock).toHaveBeenNthCalledWith(1, SESSION_NAME, 'Escape');
      expect(sendSpecialKeyMock).toHaveBeenNthCalledWith(2, SESSION_NAME, 'Escape');
      expect(invalidateCacheMock).toHaveBeenCalledWith(SESSION_NAME);
      if (fetchMock) expect(fetchMock).not.toHaveBeenCalled();
    }

    it('when no port is assigned — `CM_AGENT_HOOKS_INJECT=0`, or an old opencode', async () => {
      const fetchMock = stubAbort();
      getPortMock.mockReturnValue(null);

      await tool.interrupt('wt-2034');

      await expectKeyboardFallback(fetchMock);
    });

    it('when the subscription is not live', async () => {
      const fetchMock = stubAbort();
      getPortMock.mockReturnValue(PORT);
      // A port with a dropped stream cannot confirm anything, and an abort sent
      // blind is an abort that might have hit somebody else's process.
      livenessMock.mockReturnValue({ state: 'lost', since: 1, reason: 'stream-ended' });
      primaryMock.mockReturnValue(SESSION);

      await tool.interrupt('wt-2034');

      await expectKeyboardFallback(fetchMock);
    });

    it('when the gate cannot name the instance\'s session', async () => {
      const fetchMock = stubAbort();
      getPortMock.mockReturnValue(PORT);
      livenessMock.mockReturnValue({ state: 'live', lastHeartbeatAt: 1 });
      primaryMock.mockReturnValue(null);

      await tool.interrupt('wt-2034');

      await expectKeyboardFallback(fetchMock);
    });

    it('when the server refuses the abort', async () => {
      connected();
      const cancel = stubWatch(true);
      stubAbort(true, { ok: false, status: 404 });

      await tool.interrupt('wt-2034');

      await expectKeyboardFallback();
      // And the watch is dropped rather than left to time out on its own.
      expect(cancel).toHaveBeenCalled();
    });

    it('when the server accepts the abort and no `session.idle` follows', async () => {
      // `200 true` means "request taken", not "a turn stopped" — the same reply
      // came back for a session that was already idle. Unconfirmed is not done.
      connected();
      stubWatch(false);
      stubAbort();

      await tool.interrupt('wt-2034');

      await expectKeyboardFallback();
    });

    it('when the port answers nothing at all', async () => {
      connected();
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

      await tool.interrupt('wt-2034');

      await expectKeyboardFallback();
    });

    it('when reading the connection state throws', async () => {
      // Nothing on the server route may take the interrupt down with it: the
      // keyboard is what is left, and it has to still be reachable.
      connected();
      primaryMock.mockImplementation(() => {
        throw new Error('subscription table exploded');
      });

      await tool.interrupt('wt-2034');

      await expectKeyboardFallback();
    });
  });
});
