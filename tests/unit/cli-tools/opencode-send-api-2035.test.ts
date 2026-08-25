/**
 * Issue #2035: `OpenCodeTool` sends through the server when it has one.
 *
 * `POST /session/:id/prompt_async` replaces the keystroke route as the primary
 * send path. The keystroke route it replaces types the body into the TUI's
 * composer, which is why the Issue's own example breaks there: a body of
 * `/exit` opens the command palette and the Enter is eaten by it (#1905), a
 * body typed on top of a half-finished draft is spliced onto it, and an image
 * degrades to `[添付画像: <path>]` text.
 *
 * ## What is real here and what is stubbed
 *
 * The tool and the client are the real thing — only `fetch`, tmux, the port
 * table and the subscription are stubbed. So the assertions below are about the
 * request that actually goes out (`http://127.0.0.1:4835/session/ses_…/prompt_async`,
 * `POST`, `redirect: manual`, the exact JSON body) and about the read-back that
 * follows it, not about a mock standing in for either.
 *
 * ## The fallback is the point
 *
 * Every way the server route can fail to apply — no port (a pane launched with
 * `CM_AGENT_HOOKS_INJECT=0`, or an opencode too old for `--port`), a
 * subscription that is not live, no session yet, a POST the server refused, a
 * message that never read back — has a test that ends in
 * `sendMessageWithSubmitVerification`, which is the send path exactly as it was
 * before this Issue. `tests/unit/cli-tools/opencode.test.ts` is the other half
 * of that: it runs with no port assigned at all and is untouched here.
 *
 * ## The bodies
 *
 * The three the Issue names are the three that were measured live on 1.18.22
 * and are re-used verbatim below, so a change that starts mangling one fails
 * against the same string the live server echoed back.
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
  };
});

import { OpenCodeTool, formatImagePathFallbackMessage } from '@/lib/cli-tools/opencode';
import { getAssignedOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import {
  getOpencodeLiveness,
  getOpencodePrimarySession,
} from '@/lib/hooks/sources/opencode/subscription';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { isImageCapableCLITool } from '@/lib/cli-tools/types';
import { hasSession } from '@/lib/tmux/tmux';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';

/** The port this Issue's live capture used. */
const PORT = 4835;
/** The session id from this Issue's live capture on 1.18.22. */
const SESSION = 'ses_fc87ba4fdffeFyVKS10XU1NhgI';
const WORKTREE = 'wt-2035';
const SESSION_NAME = 'mcbd-opencode-wt-2035';

/** The three bodies the acceptance condition names, as sent to the live server. */
const SLASH_BODY = '/tmp/spike-2035.txt の中身を1行で答えて';
const MULTILINE_BODY =
  'line one about the spike\nline two has 日本語 text\nline three ends here';
const LONG_BODY = `D:${Array.from({ length: 52 }, (_, i) => `[${String(i + 1).padStart(3, '0')}]`).join('')}:END`;

const hasSessionMock = vi.mocked(hasSession);
const submitMock = vi.mocked(sendMessageWithSubmitVerification);
const invalidateCacheMock = vi.mocked(invalidateCache);
const getPortMock = vi.mocked(getAssignedOpencodePort);
const livenessMock = vi.mocked(getOpencodeLiveness);
const primaryMock = vi.mocked(getOpencodePrimarySession);

const originalFetch = globalThis.fetch;

/** The `204` the live server answered a `prompt_async` with. */
function postAccepted() {
  return { ok: true, status: 204, headers: new Headers(), json: async () => undefined };
}

/** The `200 application/json` read-back, with the parts the live server sent. */
function readbackFound(parts: unknown[]) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ info: { id: 'msg', role: 'user' }, parts }),
  };
}

/** The `404` a message the server accepted and then discarded reads back as. */
function readbackMissing() {
  return {
    ok: false,
    status: 404,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ name: 'NotFoundError' }),
  };
}

/**
 * Answer POST then GET the way a successful live send did: `204`, then the
 * message with its text part.
 */
function stubHappyPath(text: string) {
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return postAccepted();
    return readbackFound([{ type: 'text', text }]);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The state in which the server route applies: port, live stream, session. */
function connected(): void {
  getPortMock.mockReturnValue(PORT);
  livenessMock.mockReturnValue({ state: 'live', lastHeartbeatAt: 1 });
  primaryMock.mockReturnValue(SESSION);
}

/** The JSON body of the one POST that went out. */
function postedBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
  ) as [string, RequestInit] | undefined;
  expect(call).toBeDefined();
  return JSON.parse(call![1].body as string) as Record<string, unknown>;
}

describe('Issue #2035: sending over the opencode server', () => {
  let tool: OpenCodeTool;

  beforeEach(() => {
    vi.clearAllMocks();
    hasSessionMock.mockResolvedValue(true);
    submitMock.mockResolvedValue(undefined);
    getPortMock.mockReturnValue(null);
    livenessMock.mockReturnValue({ state: 'unknown' });
    primaryMock.mockReturnValue(null);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('no stub')) as unknown as typeof fetch;
    tool = new OpenCodeTool();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('the request', () => {
    it("POSTs the prompt to the instance's own port and session", async () => {
      connected();
      const fetchMock = stubHappyPath(SLASH_BODY);

      await tool.sendMessage(WORKTREE, SLASH_BODY);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://127.0.0.1:${PORT}/session/${SESSION}/prompt_async`);
      expect(init.method).toBe('POST');
      // #1931: the port is the whole trust model, so a squatter must not get to
      // choose where the operator's message is forwarded.
      expect(init.redirect).toBe('manual');
    });

    it('chooses the message id up front so the send can be verified', async () => {
      connected();
      const fetchMock = stubHappyPath(SLASH_BODY);

      await tool.sendMessage(WORKTREE, SLASH_BODY);

      const body = postedBody(fetchMock);
      // `^msg` is the route's own schema; `cmate` keeps CommandMate's messages
      // apart from opencode's `msg_037794348001…` in the shared opencode.db.
      expect(body.messageID as string).toMatch(/^msg_cmate[0-9a-f]{24}$/);

      const getCall = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === undefined
      ) as [string, RequestInit] | undefined;
      expect(getCall?.[0]).toBe(
        `http://127.0.0.1:${PORT}/session/${SESSION}/message/${body.messageID as string}`
      );
    });

    it.each([
      ['a body that starts with a slash', SLASH_BODY],
      ['a three-line body', MULTILINE_BODY],
      ['a body past the pane width', LONG_BODY],
    ])('sends %s unchanged', async (_label, message) => {
      connected();
      const fetchMock = stubHappyPath(message);

      await tool.sendMessage(WORKTREE, message);

      expect(postedBody(fetchMock).parts).toEqual([{ type: 'text', text: message }]);
      expect(submitMock).not.toHaveBeenCalled();
    });

    it('does not type anything once the message read back', async () => {
      connected();
      stubHappyPath(SLASH_BODY);

      await tool.sendMessage(WORKTREE, SLASH_BODY);

      expect(submitMock).not.toHaveBeenCalled();
      // Issue #405: the transcript grew and the capture cache has a 5 s TTL.
      expect(invalidateCacheMock).toHaveBeenCalledWith(SESSION_NAME);
    });
  });

  describe('the read-back', () => {
    it('falls back to the keyboard when the server discarded the message', async () => {
      // Measured on 1.18.22: a message with an unresolvable part is accepted
      // with `204` and then never exists — the read-back answers `404`.
      connected();
      globalThis.fetch = vi.fn().mockImplementation(async (_u: string, init?: RequestInit) => {
        if (init?.method === 'POST') return postAccepted();
        return readbackMissing();
      }) as unknown as typeof fetch;

      await tool.sendMessage(WORKTREE, SLASH_BODY);

      expect(submitMock).toHaveBeenCalledWith(
        expect.objectContaining({ sessionName: SESSION_NAME, message: SLASH_BODY })
      );
    });

    it('stops asking as soon as the message is there', async () => {
      connected();
      const fetchMock = stubHappyPath(SLASH_BODY);

      await tool.sendMessage(WORKTREE, SLASH_BODY);

      // One POST and one GET: measured, the message was readable on the first
      // attempt in 5 runs out of 5.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refuses a read-back whose text is not what was sent', async () => {
      // The acceptance condition is that the body is *unchanged*, so a message
      // that exists under the right id but says something else is not a send.
      connected();
      globalThis.fetch = vi.fn().mockImplementation(async (_u: string, init?: RequestInit) => {
        if (init?.method === 'POST') return postAccepted();
        return readbackFound([{ type: 'text', text: 'something else' }]);
      }) as unknown as typeof fetch;

      await tool.sendMessage(WORKTREE, SLASH_BODY);

      expect(submitMock).toHaveBeenCalledTimes(1);
    });

    it('refuses a read-back that is not the user\'s message', async () => {
      connected();
      globalThis.fetch = vi.fn().mockImplementation(async (_u: string, init?: RequestInit) => {
        if (init?.method === 'POST') return postAccepted();
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            info: { id: 'msg', role: 'assistant' },
            parts: [{ type: 'text', text: SLASH_BODY }],
          }),
        };
      }) as unknown as typeof fetch;

      await tool.sendMessage(WORKTREE, SLASH_BODY);

      expect(submitMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('the fallback', () => {
    it('types the body when no port was assigned', async () => {
      // A pane launched with `CM_AGENT_HOOKS_INJECT=0`, or an opencode too old
      // for `--port`, must not become a pane that cannot be sent to.
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await tool.sendMessage(WORKTREE, SLASH_BODY);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(submitMock).toHaveBeenCalledWith(
        expect.objectContaining({ sessionName: SESSION_NAME, message: SLASH_BODY, cliToolId: 'opencode' })
      );
    });

    it('types the body when the subscription is not live', async () => {
      getPortMock.mockReturnValue(PORT);
      livenessMock.mockReturnValue({ state: 'lost', since: 1, reason: 'ECONNREFUSED' });
      primaryMock.mockReturnValue(SESSION);
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await tool.sendMessage(WORKTREE, SLASH_BODY);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(submitMock).toHaveBeenCalledTimes(1);
    });

    it('types the body on a pane that has not run a turn yet', async () => {
      // The gate learns the session from the first frame that names it, so the
      // first send of a fresh pane has no session id to post to.
      getPortMock.mockReturnValue(PORT);
      livenessMock.mockReturnValue({ state: 'live', lastHeartbeatAt: 1 });
      primaryMock.mockReturnValue(null);
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await tool.sendMessage(WORKTREE, SLASH_BODY);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(submitMock).toHaveBeenCalledTimes(1);
    });

    it('types the body when the server refused the POST', async () => {
      connected();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ name: 'SessionNotFoundError' }),
      }) as unknown as typeof fetch;

      await tool.sendMessage(WORKTREE, SLASH_BODY);

      expect(submitMock).toHaveBeenCalledTimes(1);
    });

    it('types the body when an unknown route answered 200 text/html', async () => {
      // #1931: a path a real opencode does not know answers the web UI's SPA
      // shell, so "the socket accepted me" is not "the route exists". The
      // measured success status for `prompt_async` is `204` and nothing else,
      // which is why this asserts the read-back never happened: a `200` treated
      // as acceptance would send CommandMate on to ask a squatter whether the
      // operator's message arrived.
      connected();
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        json: async () => ({}),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await tool.sendMessage(WORKTREE, SLASH_BODY);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
      expect(submitMock).toHaveBeenCalledTimes(1);
    });

    it('still refuses a send when the pane is gone', async () => {
      // Unchanged by this Issue: no pane, no send, by either route.
      hasSessionMock.mockResolvedValue(false);
      connected();

      await expect(tool.sendMessage(WORKTREE, SLASH_BODY)).rejects.toThrow(
        /does not exist/
      );
      expect(submitMock).not.toHaveBeenCalled();
    });
  });

  describe('images', () => {
    it('declares image support', () => {
      expect(tool.supportsImage()).toBe(true);
    });

    it('is picked up by the gate `send-user-message` actually branches on', () => {
      // Before this Issue opencode failed this guard, so the send service built
      // `[添付画像: …]` for it and never called a native path. The behaviour
      // change is this line.
      expect(isImageCapableCLITool(tool)).toBe(true);
    });

    it('posts the file as a part beside the text', async () => {
      connected();
      const fetchMock = vi.fn().mockImplementation(async (_u: string, init?: RequestInit) => {
        if (init?.method === 'POST') return postAccepted();
        // Measured: 1.18.22 synthesises a `Called the Read tool …` text part of
        // its own beside the operator's, so the check is membership.
        return readbackFound([
          { type: 'text', text: '画像を見て' },
          { type: 'text', text: 'Called the Read tool with the following input: {}' },
          { type: 'file', mime: 'image/png', filename: 'blue.png', url: 'data:image/png;base64,AA' },
        ]);
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await tool.sendMessageWithImage(WORKTREE, '画像を見て', '/tmp/shots/blue.png');

      expect(postedBody(fetchMock).parts).toEqual([
        { type: 'text', text: '画像を見て' },
        {
          type: 'file',
          mime: 'image/png',
          filename: 'blue.png',
          // Measured: a bare path is accepted with `204` and then dropped along
          // with the whole message.
          url: 'file:///tmp/shots/blue.png',
        },
      ]);
      expect(submitMock).not.toHaveBeenCalled();
    });

    it('percent-encodes a path the concatenated form would corrupt', async () => {
      connected();
      const fetchMock = vi.fn().mockImplementation(async (_u: string, init?: RequestInit) => {
        if (init?.method === 'POST') return postAccepted();
        return readbackFound([{ type: 'text', text: 'x' }]);
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await tool.sendMessageWithImage(WORKTREE, 'x', '/tmp/my shots/a#b.png');

      const parts = postedBody(fetchMock).parts as Array<Record<string, unknown>>;
      expect(parts[1].url).toBe('file:///tmp/my%20shots/a%23b.png');
    });

    it('degrades to the path text when there is no server to attach through', async () => {
      // No port: the pre-#2035 behaviour, and the same wording the send service
      // uses for every tool that cannot attach.
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await tool.sendMessageWithImage(WORKTREE, 'これは何', '/tmp/shots/blue.png');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(submitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'これは何\n\n[添付画像: /tmp/shots/blue.png]',
        })
      );
    });

    it('degrades with no leading blank lines when the message is empty', async () => {
      globalThis.fetch = vi.fn() as unknown as typeof fetch;

      await tool.sendMessageWithImage(WORKTREE, '', '/tmp/shots/blue.png');

      expect(submitMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: '[添付画像: /tmp/shots/blue.png]' })
      );
    });
  });

  describe('formatImagePathFallbackMessage', () => {
    // Pins the wording this Issue moved out of `send-user-message.ts`, so the
    // move stays a move: these are the two strings that branch used to build.
    it('appends the path after a blank line', () => {
      expect(formatImagePathFallbackMessage('hello', '/a/b.png')).toBe(
        'hello\n\n[添付画像: /a/b.png]'
      );
    });

    it('is the path alone when there is no message', () => {
      expect(formatImagePathFallbackMessage('', '/a/b.png')).toBe('[添付画像: /a/b.png]');
    });
  });
});
