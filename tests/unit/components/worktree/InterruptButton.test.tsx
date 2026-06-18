/**
 * Tests for InterruptButton component
 *
 * Issue #901: split 時に同一 cliTool の別 instance へ interrupt が誤送信される問題の
 * 回帰テスト。interrupt の宛先キーに instanceId を含めることで、alias instance を
 * 指定した split のみ対象になることを担保する。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InterruptButton } from '@/components/worktree/InterruptButton';

describe('InterruptButton', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const clickInterrupt = () => {
    fireEvent.click(screen.getByTestId('interrupt-button'));
  };

  const getRequestBody = (): Record<string, unknown> => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/worktrees/wt-1/interrupt');
    expect(init.method).toBe('POST');
    return JSON.parse(init.body as string);
  };

  it('sends { cliToolId, instanceId } for an alias instance (split target)', async () => {
    render(
      <InterruptButton
        worktreeId="wt-1"
        cliToolId="claude"
        instanceId="claude-2"
      />
    );

    clickInterrupt();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(getRequestBody()).toEqual({ cliToolId: 'claude', instanceId: 'claude-2' });
  });

  it('sends only { cliToolId } for the primary instance (instanceId === cliToolId)', async () => {
    render(
      <InterruptButton
        worktreeId="wt-1"
        cliToolId="claude"
        instanceId="claude"
      />
    );

    clickInterrupt();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(getRequestBody()).toEqual({ cliToolId: 'claude' });
  });

  it('sends only { cliToolId } when instanceId is omitted (backward compatible)', async () => {
    render(
      <InterruptButton
        worktreeId="wt-1"
        cliToolId="claude"
      />
    );

    clickInterrupt();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(getRequestBody()).toEqual({ cliToolId: 'claude' });
  });

  it('does not leak another instance id: alias B targets only its own instance', async () => {
    render(
      <InterruptButton
        worktreeId="wt-1"
        cliToolId="claude"
        instanceId="claude-3"
      />
    );

    clickInterrupt();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = getRequestBody();
    expect(body.instanceId).toBe('claude-3');
    expect(body.instanceId).not.toBe('claude');
    expect(body.instanceId).not.toBe('claude-2');
  });

  it('does not send when disabled', () => {
    render(
      <InterruptButton
        worktreeId="wt-1"
        cliToolId="claude"
        instanceId="claude-2"
        disabled
      />
    );

    clickInterrupt();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
