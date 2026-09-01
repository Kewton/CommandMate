/**
 * `worktreeApi.sendMessage` returns the created row (Issue #2213).
 *
 * `/send` has always answered 201 with the saved `ChatMessage`
 * (`NextResponse.json(result.message, { status: 201 })`), but this client
 * declared the response as `{ success: boolean }` — the body was on the wire and
 * discarded in the type. These tests pin the corrected contract, including the
 * one thing a JSON round trip cannot carry: `timestamp` is typed `Date` and every
 * consumer of a message calls `.getTime()` on it, so the string has to be
 * revived exactly the way `useSplitMessages` revives a fetched list.
 *
 * The request shape is asserted alongside, because widening the RESPONSE must
 * not disturb what is sent — the optimistic path (#1121 / #2213) and the
 * await-then-clear path share this one call site.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { worktreeApi, reviveMessageTimestamp } from '@/lib/api-client';
import type { ChatMessage } from '@/types/models';

const CREATED_ROW = {
  id: 'msg-created-1',
  worktreeId: 'wt-1',
  role: 'user',
  content: 'ship it',
  timestamp: '2026-09-01T10:20:30.000Z',
  messageType: 'normal',
  archived: false,
  cliToolId: 'claude',
  instanceId: 'claude-2',
};

function mockSendResponse(body: unknown = CREATED_ROW): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 201,
      redirected: false,
      url: 'http://localhost/api/worktrees/wt-1/send',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(body),
    } as unknown as Response),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[#2213] worktreeApi.sendMessage', () => {
  it('resolves with the ChatMessage the server created', async () => {
    mockSendResponse();

    const created = await worktreeApi.sendMessage('wt-1', 'ship it', {
      cliToolId: 'claude',
      instanceId: 'claude-2',
    });

    expect(created.id).toBe('msg-created-1');
    expect(created.role).toBe('user');
    expect(created.content).toBe('ship it');
    expect(created.cliToolId).toBe('claude');
    expect(created.instanceId).toBe('claude-2');
  });

  it('revives `timestamp` to a Date, so ordering comparisons work on it', async () => {
    mockSendResponse();

    const created = await worktreeApi.sendMessage('wt-1', 'ship it', { cliToolId: 'claude' });

    expect(created.timestamp).toBeInstanceOf(Date);
    expect(created.timestamp.getTime()).toBe(Date.parse('2026-09-01T10:20:30.000Z'));
  });

  it('still sends exactly the same request body', async () => {
    const fetchMock = mockSendResponse();

    await worktreeApi.sendMessage('wt-1', 'ship it', {
      cliToolId: 'codex',
      instanceId: 'codex-3',
      imagePath: '.commandmate/attachments/1-a.png',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/worktrees/wt-1/send');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      content: 'ship it',
      cliToolId: 'codex',
      instanceId: 'codex-3',
      imagePath: '.commandmate/attachments/1-a.png',
    });
  });

  it('omits the optional fields the caller did not set', async () => {
    const fetchMock = mockSendResponse();

    await worktreeApi.sendMessage('wt-1', 'bare');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ content: 'bare' });
  });
});

describe('[#2213] reviveMessageTimestamp', () => {
  it('leaves a row that already carries a Date untouched', () => {
    const row = {
      ...CREATED_ROW,
      timestamp: new Date('2026-09-01T10:20:30.000Z'),
    } as unknown as ChatMessage;

    expect(reviveMessageTimestamp(row)).toBe(row);
  });

  it('does not throw on a body that is not an object', () => {
    expect(() => reviveMessageTimestamp(null as unknown as ChatMessage)).not.toThrow();
    expect(reviveMessageTimestamp(null as unknown as ChatMessage)).toBeNull();
  });
});
