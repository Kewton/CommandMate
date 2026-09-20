/**
 * sendDirectInputAndInvalidate（Issue #2765）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { execFileAsyncMock, invalidateCacheMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  invalidateCacheMock: vi.fn(),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: invalidateCacheMock,
}));
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('util', () => ({
  promisify: vi.fn(() => execFileAsyncMock),
}));

import {
  DIRECT_INPUT_TEXT_CHUNK_BYTES,
  exactTarget,
  sendDirectInputAndInvalidate,
} from '@/lib/tmux/tmux';
import type { DirectInputEvent } from '@/types/direct-input';

const SESSION = 'mcbd-command-code-wt-1';
const argvOf = (call: unknown[]): string[] => call[1] as string[];

beforeEach(() => {
  execFileAsyncMock.mockClear();
  invalidateCacheMock.mockClear();
});

describe('[#2765] sendDirectInputAndInvalidate', () => {
  it('key は tmux のキー名として、`--` の後ろに置いて送る', async () => {
    await sendDirectInputAndInvalidate(SESSION, [{ type: 'key', key: 'C-a' }]);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    expect(argvOf(execFileAsyncMock.mock.calls[0])).toEqual(['send-keys', '-t', exactTarget(SESSION), '--', 'C-a']);
  });

  it('text は -H の 16 進バイト列で送る（-l は末尾の `;` を落とすので使わない）', async () => {
    await sendDirectInputAndInvalidate(SESSION, [{ type: 'text', text: 'a;' }]);
    expect(argvOf(execFileAsyncMock.mock.calls[0])).toEqual(['send-keys', '-t', exactTarget(SESSION), '-H', '61', '3b']);
    expect(argvOf(execFileAsyncMock.mock.calls[0])).not.toContain('-l');
  });

  it('UTF-8 をバイト単位で送る', async () => {
    await sendDirectInputAndInvalidate(SESSION, [{ type: 'text', text: 'あ' }]);
    expect(argvOf(execFileAsyncMock.mock.calls[0]).slice(4)).toEqual(['e3', '81', '82']);
  });

  it('イベントを順番どおりに 1 つずつ送る', async () => {
    await sendDirectInputAndInvalidate(SESSION, [
      { type: 'text', text: 'why' },
      { type: 'key', key: 'Enter' },
    ]);
    expect(execFileAsyncMock.mock.calls.map((call) => argvOf(call).slice(3))).toEqual([
      ['-H', '77', '68', '79'],
      ['--', 'Enter'],
    ]);
  });

  it('長い text は DIRECT_INPUT_TEXT_CHUNK_BYTES ごとに分ける', async () => {
    await sendDirectInputAndInvalidate(SESSION, [
      { type: 'text', text: 'x'.repeat(DIRECT_INPUT_TEXT_CHUNK_BYTES + 1) },
    ]);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
    expect(argvOf(execFileAsyncMock.mock.calls[0]).slice(4)).toHaveLength(DIRECT_INPUT_TEXT_CHUNK_BYTES);
    expect(argvOf(execFileAsyncMock.mock.calls[1]).slice(4)).toEqual(['78']);
  });

  it('送り終えたらキャプチャのキャッシュを捨てる', async () => {
    await sendDirectInputAndInvalidate(SESSION, [{ type: 'key', key: 'Up' }]);
    expect(invalidateCacheMock).toHaveBeenCalledWith(SESSION);
  });

  it('語彙に無いキーが 1 つでも混ざっていたら、tmux を 1 回も起動せずに投げる', async () => {
    const events = [
      { type: 'key', key: 'Up' },
      { type: 'key', key: 'F1' },
    ] as unknown as DirectInputEvent[];
    await expect(sendDirectInputAndInvalidate(SESSION, events)).rejects.toThrow('Invalid direct input event');
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });
});
