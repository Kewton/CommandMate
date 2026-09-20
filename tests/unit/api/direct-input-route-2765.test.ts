/**
 * POST /api/worktrees/[id]/direct-input（Issue #2765）
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/cli-tools/direct-input', () => ({
  sendDirectInput: vi.fn(),
}));
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));
vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/api/worktrees/[id]/direct-input/route';
import { sendDirectInput } from '@/lib/cli-tools/direct-input';
import { getWorktreeById } from '@/lib/db';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { MAX_DIRECT_INPUT_EVENTS } from '@/types/direct-input';

const URL = 'http://localhost:3000/api/worktrees/wt-1/direct-input';
const params = { params: Promise.resolve({ id: 'wt-1' }) };

function request(body: unknown): NextRequest {
  return new NextRequest(URL, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const APPROVE = [{ type: 'key', key: 'C-a' }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWorktreeById).mockReturnValue({ id: 'wt-1' } as never);
  vi.mocked(sendDirectInput).mockResolvedValue('sent');
});

describe('[#2765] 受け付ける入力', () => {
  it('key と text を順番どおりに gateway へ渡し、スナップショットを流す', async () => {
    const events = [{ type: 'text', text: 'why?' }, { type: 'key', key: 'Enter' }];
    const res = await POST(request({ cliToolId: 'command-code', events }), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(sendDirectInput).toHaveBeenCalledWith('command-code', 'wt-1', events, undefined);
    expect(broadcastTerminalSnapshotAfterInteraction).toHaveBeenCalledWith('wt-1', 'command-code', undefined);
  });

  it('ツールが宣言していないキー（C-a を claude へ）も通す — 語彙は固定で、ツール別ではない', async () => {
    const res = await POST(request({ cliToolId: 'claude', events: APPROVE }), params);
    expect(res.status).toBe(200);
    expect(sendDirectInput).toHaveBeenCalledWith('claude', 'wt-1', APPROVE, undefined);
  });

  it('instanceId を gateway へ渡す', async () => {
    await POST(request({ cliToolId: 'command-code', events: APPROVE, instanceId: 'command-code-2' }), params);
    expect(sendDirectInput).toHaveBeenCalledWith('command-code', 'wt-1', APPROVE, 'command-code-2');
  });
});

describe('[#2765] 400 で止めるもの（gateway を呼ばない）', () => {
  it.each([
    ['JSON でない body', '{invalid json'],
    ['cliToolId が無い', { events: APPROVE }],
    ['未知の cliToolId', { cliToolId: 'bash', events: APPROVE }],
    ['不正な instanceId', { cliToolId: 'claude', events: APPROVE, instanceId: '../x' }],
    ['events が配列でない', { cliToolId: 'claude', events: 'C-a' }],
    ['events が空', { cliToolId: 'claude', events: [] }],
    ['語彙に無いキー', { cliToolId: 'claude', events: [{ type: 'key', key: 'F1' }] }],
    ['tmux のキー名に見える任意文字列', { cliToolId: 'claude', events: [{ type: 'key', key: 'C-a; kill-server' }] }],
    ['空の text', { cliToolId: 'claude', events: [{ type: 'text', text: '' }] }],
    ['未知の type', { cliToolId: 'claude', events: [{ type: 'paste', text: 'a' }] }],
    ['events が多すぎる', {
      cliToolId: 'claude',
      events: Array.from({ length: MAX_DIRECT_INPUT_EVENTS + 1 }, () => ({ type: 'key', key: 'Up' })),
    }],
  ])('%s', async (_name, body) => {
    const res = await POST(request(body), params);
    expect(res.status).toBe(400);
    expect(sendDirectInput).not.toHaveBeenCalled();
  });
});

describe('[#2765] 404 / 500', () => {
  it('worktree が無ければ 404（gateway を呼ばない）', async () => {
    vi.mocked(getWorktreeById).mockReturnValue(undefined as never);
    const res = await POST(request({ cliToolId: 'claude', events: APPROVE }), params);
    expect(res.status).toBe(404);
    expect(sendDirectInput).not.toHaveBeenCalled();
  });

  it('セッションが無ければ 404（スナップショットは流さない）', async () => {
    vi.mocked(sendDirectInput).mockResolvedValue('session-not-found');
    const res = await POST(request({ cliToolId: 'claude', events: APPROVE }), params);
    expect(res.status).toBe(404);
    expect(broadcastTerminalSnapshotAfterInteraction).not.toHaveBeenCalled();
  });

  it('送信が失敗したら、内部の文言を出さずに 500', async () => {
    vi.mocked(sendDirectInput).mockRejectedValue(new Error('tmux: no server running on /tmp/x'));
    const res = await POST(request({ cliToolId: 'claude', events: APPROVE }), params);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to send direct input to terminal' });
  });
});
