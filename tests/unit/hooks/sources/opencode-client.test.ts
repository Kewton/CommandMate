/**
 * The wire between CommandMate and one opencode server (Issue #1763).
 *
 * Two things here are measurements rather than choices, and both are asserted:
 *
 *  - **The frames carry no SSE `event:` line.** Every frame is a bare `data:`
 *    line whose JSON holds the type, so `es.addEventListener("session.idle", …)`
 *    picks up nothing at all (#1758, fixtures README). The parser therefore
 *    reads `data:` and ignores the rest.
 *  - **Replies go to `POST /permission/:requestID/reply`.** The per-session
 *    endpoint takes a different key (`response`) and cannot carry a reason;
 *    this one takes `reply` plus an optional `message` that reaches the agent
 *    verbatim (#1758 §5.5.2). One had to be picked, and this is the superset.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  createSseParser,
  fetchOpencodeActivity,
  fetchOpencodeHealth,
  fetchOpencodePendingPermissions,
  opencodeBaseUrl,
  openOpencodeEventStream,
  replyOpencodePermission,
  replyOpencodeQuestion,
} from '@/lib/hooks/sources/opencode/client';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

/**
 * A captured frame as one `data:` line.
 *
 * The fixtures on disk are pretty-printed for reading; the server sends each
 * frame on a single line, which is what the framing depends on.
 */
function fixtureText(name: string): string {
  return JSON.stringify(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')));
}

const originalFetch = globalThis.fetch;

/** Answer every request with one JSON body. */
function stubJson(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Answer with an SSE body assembled from the given chunks. */
function stubStream(chunks: string[]): void {
  const encoder = new TextEncoder();
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: {
      getReader: () => {
        let index = 0;
        return {
          read: async () =>
            index < chunks.length
              ? { done: false, value: encoder.encode(chunks[index++]) }
              : { done: true, value: undefined },
          cancel: async () => {},
        };
      },
    },
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('addressing', () => {
  it('only ever talks to loopback', () => {
    // The server is unauthenticated by default, so the host is the security
    // property (#1758 §5.8.3).
    expect(opencodeBaseUrl(4242)).toBe('http://127.0.0.1:4242');
  });
});

describe('health', () => {
  it('reads healthy and version', async () => {
    stubJson({ healthy: true, version: '1.18.3' });
    expect(await fetchOpencodeHealth(4242)).toEqual({ healthy: true, version: '1.18.3' });
  });

  it('answers null for an unhealthy or unreachable server', async () => {
    stubJson({ healthy: false });
    expect(await fetchOpencodeHealth(4242)).toBeNull();

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    // Never throws: the ordinary case is that the pane exited.
    expect(await fetchOpencodeHealth(4242)).toBeNull();
  });
});

describe('pending state', () => {
  it('reads GET /permission, which answers a bare array', async () => {
    stubJson([{ id: 'per_1' }, 'not an object']);
    expect(await fetchOpencodePendingPermissions(4242)).toEqual([{ id: 'per_1' }]);
  });

  it('reports busy when any session is working', async () => {
    // A session blocked on an approval reads `busy` (#1758 §5.3.1), so this
    // answers "is the turn over", never "is a human needed".
    stubJson({ ses_a: { type: 'idle' }, ses_b: { type: 'busy' } });
    expect(await fetchOpencodeActivity(4242)).toBe('busy');

    stubJson({ ses_a: { type: 'idle' } });
    expect(await fetchOpencodeActivity(4242)).toBe('idle');

    stubJson(null, false);
    expect(await fetchOpencodeActivity(4242)).toBeNull();
  });
});

describe('replies', () => {
  it('posts a rejection with the reason the agent will see', async () => {
    const fetchMock = stubJson(true);

    await replyOpencodePermission(4242, 'per_1', 'reject', 'blocked by CommandMate');

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4242/permission/per_1/reply');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      reply: 'reject',
      message: 'blocked by CommandMate',
    });
  });

  it('omits the message when there is none', async () => {
    const fetchMock = stubJson(true);
    await replyOpencodePermission(4242, 'per_1', 'once');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ reply: 'once' });
  });

  it('posts question answers as one array per question', async () => {
    const fetchMock = stubJson(true);
    await replyOpencodeQuestion(4242, 'que_1', [['Blue'], ['VS Code']]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4242/question/que_1/reply');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      answers: [['Blue'], ['VS Code']],
    });
  });

  it('reports failure instead of throwing', async () => {
    stubJson(null, false);
    expect(await replyOpencodePermission(4242, 'per_1', 'once')).toBe(false);
  });
});

describe('the SSE parser', () => {
  it('reassembles frames split across chunks', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"a":')).toEqual([]);
    expect(parser.push('1}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual(['{"a":1}']);
  });

  it('joins multi-line data and ignores comments and other fields', () => {
    const parser = createSseParser();
    expect(parser.push(': keepalive\nid: 7\nevent: ignored\ndata: {"a":\ndata: 1}\n\n')).toEqual([
      '{"a":\n1}',
    ]);
  });

  it('tolerates CRLF', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"a":1}\r\n\r\n')).toEqual(['{"a":1}']);
  });

  it('flushes a frame the server never terminated', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"a":1}')).toEqual([]);
    expect(parser.flush()).toEqual(['{"a":1}']);
  });
});

describe('the event stream', () => {
  it('yields parsed frames from captured payloads', async () => {
    stubStream([
      `data: ${fixtureText('server-connected')}\n\n`,
      `data: ${fixtureText('session-idle')}\n\n`,
    ]);

    const frames: Record<string, unknown>[] = [];
    for await (const frame of await openOpencodeEventStream(4242, new AbortController().signal)) {
      frames.push(frame);
    }

    expect(frames.map((frame) => frame.type)).toEqual(['server.connected', 'session.idle']);
  });

  it('skips a malformed frame rather than ending the stream', async () => {
    // A bad line is a bug in one frame, not a reason to stop watching a session.
    stubStream([`data: not json\n\n`, `data: ${fixtureText('session-idle')}\n\n`]);

    const frames: Record<string, unknown>[] = [];
    for await (const frame of await openOpencodeEventStream(4242, new AbortController().signal)) {
      frames.push(frame);
    }

    expect(frames.map((frame) => frame.type)).toEqual(['session.idle']);
  });

  it('throws when the server refuses the subscription', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch;

    // Issue #1900 split connecting from iterating, so the refusal surfaces on
    // the connect rather than on the first pull — which is the point: the
    // caller re-syncs pending state only once this call has resolved.
    await expect(
      openOpencodeEventStream(4242, new AbortController().signal)
    ).rejects.toThrow('opencode /event responded 404');
  });
});
