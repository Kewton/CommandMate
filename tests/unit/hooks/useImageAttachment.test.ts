/**
 * Unit tests for useImageAttachment hook
 * Issue #474: Tests file validation, upload flow, and state management
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useImageAttachment } from '@/hooks/useImageAttachment';
import { IMAGE_MAX_SIZE_BYTES, ATTACHABLE_IMAGE_ACCEPT } from '@/config/image-extensions';

describe('useImageAttachment', () => {
  const worktreeId = 'test-worktree';
  const mockUploadFn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with null attachment and no error', () => {
    const { result } = renderHook(() => useImageAttachment(worktreeId, mockUploadFn));

    expect(result.current.attachedImage).toBeNull();
    expect(result.current.isUploading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.acceptAttribute).toBe(ATTACHABLE_IMAGE_ACCEPT);
  });

  it('should upload file and set attachedImage on success', async () => {
    mockUploadFn.mockResolvedValueOnce({ path: '.commandmate/attachments/1234-test.png' });

    const { result } = renderHook(() => useImageAttachment(worktreeId, mockUploadFn));

    const file = new File(['dummy'], 'test.png', { type: 'image/png' });
    const event = {
      target: { files: [file] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => {
      await result.current.handleFileSelect(event);
    });

    expect(mockUploadFn).toHaveBeenCalledWith(worktreeId, file);
    expect(result.current.attachedImage).toEqual({
      file,
      path: '.commandmate/attachments/1234-test.png',
    });
    expect(result.current.isUploading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should set error on upload failure', async () => {
    mockUploadFn.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useImageAttachment(worktreeId, mockUploadFn));

    const file = new File(['dummy'], 'test.png', { type: 'image/png' });
    const event = {
      target: { files: [file] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => {
      await result.current.handleFileSelect(event);
    });

    expect(result.current.attachedImage).toBeNull();
    expect(result.current.error).toBe('Network error');
    expect(result.current.isUploading).toBe(false);
  });

  it('should reject unsupported file formats', async () => {
    const { result } = renderHook(() => useImageAttachment(worktreeId, mockUploadFn));

    const file = new File(['<svg></svg>'], 'test.svg', { type: 'image/svg+xml' });
    const event = {
      target: { files: [file] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => {
      await result.current.handleFileSelect(event);
    });

    expect(mockUploadFn).not.toHaveBeenCalled();
    expect(result.current.error).toContain('Unsupported file format');
  });

  it('should reject files exceeding size limit', async () => {
    const { result } = renderHook(() => useImageAttachment(worktreeId, mockUploadFn));

    // Create a file larger than the limit
    const largeContent = new Uint8Array(IMAGE_MAX_SIZE_BYTES + 1);
    const file = new File([largeContent], 'large.png', { type: 'image/png' });

    const event = {
      target: { files: [file] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => {
      await result.current.handleFileSelect(event);
    });

    expect(mockUploadFn).not.toHaveBeenCalled();
    expect(result.current.error).toContain('exceeds');
  });

  it('should do nothing when no file is selected', async () => {
    const { result } = renderHook(() => useImageAttachment(worktreeId, mockUploadFn));

    const event = {
      target: { files: [] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => {
      await result.current.handleFileSelect(event);
    });

    expect(mockUploadFn).not.toHaveBeenCalled();
    expect(result.current.attachedImage).toBeNull();
  });

  it('should clear attachment with removeAttachment', async () => {
    mockUploadFn.mockResolvedValueOnce({ path: '.commandmate/attachments/1234-test.png' });

    const { result } = renderHook(() => useImageAttachment(worktreeId, mockUploadFn));

    const file = new File(['dummy'], 'test.png', { type: 'image/png' });
    const event = {
      target: { files: [file] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => {
      await result.current.handleFileSelect(event);
    });

    expect(result.current.attachedImage).not.toBeNull();

    act(() => {
      result.current.removeAttachment();
    });

    expect(result.current.attachedImage).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('should reset attachment with resetAfterSend', async () => {
    mockUploadFn.mockResolvedValueOnce({ path: '.commandmate/attachments/1234-test.png' });

    const { result } = renderHook(() => useImageAttachment(worktreeId, mockUploadFn));

    const file = new File(['dummy'], 'test.png', { type: 'image/png' });
    const event = {
      target: { files: [file] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => {
      await result.current.handleFileSelect(event);
    });

    expect(result.current.attachedImage).not.toBeNull();

    act(() => {
      result.current.resetAfterSend();
    });

    expect(result.current.attachedImage).toBeNull();
  });

  it('should reject files without extension', async () => {
    const { result } = renderHook(() => useImageAttachment(worktreeId, mockUploadFn));

    const file = new File(['dummy'], 'noextension', { type: 'application/octet-stream' });
    const event = {
      target: { files: [file] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    await act(async () => {
      await result.current.handleFileSelect(event);
    });

    expect(mockUploadFn).not.toHaveBeenCalled();
    expect(result.current.error).toContain('Unsupported file format');
  });
});
