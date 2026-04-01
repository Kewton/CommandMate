/**
 * Unit tests for useSendMessage
 * Issue #600: UX refresh - send message hook
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSendMessage } from '@/hooks/useSendMessage';

// Mock global fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('useSendMessage()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with isSending=false and error=null', () => {
    const { result } = renderHook(() =>
      useSendMessage({ worktreeId: 'wt-1', cliToolId: 'claude' })
    );
    expect(result.current.isSending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should send message successfully and call onSuccess', async () => {
    const onSuccess = vi.fn();
    mockFetch
      .mockResolvedValueOnce({ ok: true }) // terminal API
      .mockResolvedValueOnce({ ok: true }); // chat-db API

    const { result } = renderHook(() =>
      useSendMessage({
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        onSuccess,
      })
    );

    await act(async () => {
      await result.current.send('hello');
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/worktrees/wt-1/terminal',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ command: 'hello', cliToolId: 'claude' }),
      })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/worktrees/wt-1/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ role: 'user', content: 'hello', cliToolId: 'claude' }),
      })
    );
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    expect(result.current.isSending).toBe(false);
  });

  it('should handle terminal API error and call onError', async () => {
    const onError = vi.fn();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const { result } = renderHook(() =>
      useSendMessage({
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        onError,
      })
    );

    await act(async () => {
      await result.current.send('hello');
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toContain('Terminal API error: 500');
    expect(result.current.isSending).toBe(false);
  });

  it('should handle chat-db API error', async () => {
    const onError = vi.fn();
    mockFetch
      .mockResolvedValueOnce({ ok: true }) // terminal succeeds
      .mockResolvedValueOnce({ ok: false, status: 403 }); // chat-db fails

    const { result } = renderHook(() =>
      useSendMessage({
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        onError,
      })
    );

    await act(async () => {
      await result.current.send('hello');
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.error?.message).toContain('Chat DB error: 403');
  });

  it('should handle network error', async () => {
    const onError = vi.fn();
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() =>
      useSendMessage({
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        onError,
      })
    );

    await act(async () => {
      await result.current.send('hello');
    });

    expect(result.current.error?.message).toBe('Network error');
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('should set isSending=false after completion', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() =>
      useSendMessage({ worktreeId: 'wt-1', cliToolId: 'claude' })
    );

    await act(async () => {
      await result.current.send('hello');
    });

    expect(result.current.isSending).toBe(false);
  });
});
