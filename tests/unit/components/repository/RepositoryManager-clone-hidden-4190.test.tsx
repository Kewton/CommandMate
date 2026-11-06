/**
 * Tests for RepositoryManager component
 * Issue #71: Clone URL registration feature - UI extension
 *
 * Issue #4190: clone polling vs hidden / unmount
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { RepositoryManager } from '@/components/repository/RepositoryManager';

/**
 * Issue #1219: this file asserts the rendered wording, so it must resolve
 * through the real dictionary — tests/setup.ts's global mock would echo
 * `common.repositories.clone` back and every assertion below would pass
 * against a dictionary that has no such key. Backing them with locales/
 * turns the pre-existing English expectations into the byte-identity guard
 * for the i18n migration.
 */
const locale = vi.hoisted(() => ({ current: 'en' }));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock(() => locale.current);
});

// Mock api-client module
vi.mock('@/lib/api-client', () => ({
  repositoryApi: {
    scan: vi.fn(),
    sync: vi.fn(),
    clone: vi.fn(),
    getCloneStatus: vi.fn(),
    // Issue #1517: the Local Path form checks the path while the user types.
    validatePath: vi.fn(() => new Promise(() => {})),
  },
  // Issue #1517: opening the add form fetches the allowed roots for the hint.
  fsApi: {
    browse: vi.fn(() => new Promise(() => {})),
    addRecentPath: vi.fn(),
  },
  handleApiError: vi.fn((err) => {
    if (err instanceof Error) {
      return err.message;
    }
    if (err && typeof err === 'object' && 'message' in err) {
      return String(err.message);
    }
    return 'An error occurred';
  }),
}));

// Mock url-normalizer
vi.mock('@/lib/url-normalizer', () => ({
  UrlNormalizer: {
    getInstance: () => ({
      validate: vi.fn((url: string) => {
        if (!url || url.trim() === '') {
          return { valid: false, error: 'EMPTY_URL' };
        }
        if (url.startsWith('https://') || url.startsWith('git@')) {
          return { valid: true };
        }
        return { valid: false, error: 'INVALID_URL_FORMAT' };
      }),
      extractRepoName: vi.fn((url: string) => {
        const match = url.match(/\/([^\/]+?)(\.git)?$/);
        return match ? match[1] : '';
      }),
    }),
  },
}));

import { repositoryApi } from '@/lib/api-client';
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
}
async function switchTo(state: DocumentVisibilityState): Promise<void> {
  setVisibility(state);
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  });
}
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
function restoreVisibility(): void {
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
  else delete (document as unknown as Record<string, unknown>).hidden;
}


const running = { success: true, jobId: 'job-1', status: 'running', progress: 10 } as never;

async function startClone(): Promise<ReturnType<typeof render>> {
  const view = render(<RepositoryManager onRepositoryAdded={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /add repository/i }));
  fireEvent.mouseDown(screen.getByRole('tab', { name: /clone url/i }));
  fireEvent.change(screen.getByPlaceholderText('https://github.com/user/repo.git'), {
    target: { value: 'https://github.com/user/myrepo.git' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^clone$/i }));
    await vi.advanceTimersByTimeAsync(0);
  });
  return view;
}

describe('RepositoryManager clone polling (Issue #4190)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setVisibility('visible');
    vi.mocked(repositoryApi.clone).mockResolvedValue({
      success: true, jobId: 'job-1', status: 'pending', message: 'started',
    } as never);
    vi.mocked(repositoryApi.getCloneStatus).mockResolvedValue(running);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    restoreVisibility();
  });

  it('control: polls every interval while visible', async () => {
    await startClone();
    const n = vi.mocked(repositoryApi.getCloneStatus).mock.calls.length;
    await tick(6100);
    expect(vi.mocked(repositoryApi.getCloneStatus).mock.calls.length).toBeGreaterThan(n + 1);
  });

  it('asks nothing while hidden and reads once on visible', async () => {
    await startClone();
    await switchTo('hidden');
    await tick(1); // let any pending timer land and rest
    const n = vi.mocked(repositoryApi.getCloneStatus).mock.calls.length;
    await tick(20_000);
    expect(vi.mocked(repositoryApi.getCloneStatus).mock.calls.length).toBe(n);

    await switchTo('visible');
    expect(vi.mocked(repositoryApi.getCloneStatus).mock.calls.length).toBe(n + 1);
  });

  it('stops on unmount', async () => {
    const view = await startClone();
    view.unmount();
    const n = vi.mocked(repositoryApi.getCloneStatus).mock.calls.length;
    await tick(20_000);
    expect(vi.mocked(repositoryApi.getCloneStatus).mock.calls.length).toBe(n);
  });

  it('does not adopt an answer after unmount', async () => {
    let release: (v: never) => void = () => {};
    vi.mocked(repositoryApi.getCloneStatus).mockImplementationOnce(
      () => new Promise((res) => { release = res as never; }),
    );
    const onAdded = vi.fn();
    const view = render(<RepositoryManager onRepositoryAdded={onAdded} />);
    fireEvent.click(screen.getByRole('button', { name: /add repository/i }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: /clone url/i }));
    fireEvent.change(screen.getByPlaceholderText('https://github.com/user/repo.git'), {
      target: { value: 'https://github.com/user/myrepo.git' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^clone$/i }));
      await vi.advanceTimersByTimeAsync(0);
    });
    view.unmount();
    await act(async () => {
      release({ success: true, jobId: 'job-1', status: 'completed', progress: 100 } as never);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('a stale answer from before hidden does not override the one after coming back', async () => {
    let releaseOld: (v: never) => void = () => {};
    vi.mocked(repositoryApi.getCloneStatus).mockReset();
    vi.mocked(repositoryApi.getCloneStatus).mockImplementationOnce(
      () => new Promise((res) => { releaseOld = res as never; }),
    );
    vi.mocked(repositoryApi.getCloneStatus).mockResolvedValue(running);
    const onAdded = vi.fn();
    render(<RepositoryManager onRepositoryAdded={onAdded} />);
    fireEvent.click(screen.getByRole('button', { name: /add repository/i }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: /clone url/i }));
    fireEvent.change(screen.getByPlaceholderText('https://github.com/user/repo.git'), {
      target: { value: 'https://github.com/user/myrepo.git' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^clone$/i }));
      await vi.advanceTimersByTimeAsync(0);
    });
    await switchTo('hidden');
    await switchTo('visible'); // newer read answers "running"
    await act(async () => {
      releaseOld({ success: true, jobId: 'job-1', status: 'completed', progress: 100 } as never);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onAdded).not.toHaveBeenCalled();
  });
});
