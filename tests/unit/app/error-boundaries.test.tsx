/**
 * Tests for the App Router error boundaries (Issue #1404).
 *
 * Verifies that a ChunkLoadError triggers exactly one guarded recovery reload
 * and that a non-ChunkLoadError does not auto-reload. The guard/loop logic
 * itself is covered by tests/unit/lib/error/chunk-reload.test.ts; here we assert
 * the boundaries wire into it correctly.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// Keep detection real; stub only the browser-wired recovery so no real reload
// happens and we can assert call counts.
vi.mock('@/lib/error/chunk-reload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/error/chunk-reload')>();
  return {
    ...actual,
    recoverFromChunkErrorInBrowser: vi.fn(() => 'reloaded' as const),
  };
});

import { recoverFromChunkErrorInBrowser } from '@/lib/error/chunk-reload';
import AppError from '@/app/error';
import GlobalError from '@/app/global-error';

const mockedRecover = vi.mocked(recoverFromChunkErrorInBrowser);

function chunkError(): Error & { digest?: string } {
  const err = new Error('Loading chunk 12 failed.') as Error & { digest?: string };
  err.name = 'ChunkLoadError';
  return err;
}

function genericError(): Error & { digest?: string } {
  return new Error('boom') as Error & { digest?: string };
}

beforeEach(() => {
  mockedRecover.mockClear();
  // global-error renders <html> into a container div → React logs a nesting
  // warning; keep test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('app/error.tsx (Issue #1404)', () => {
  it('triggers guarded recovery exactly once for a ChunkLoadError', () => {
    render(<AppError error={chunkError()} reset={vi.fn()} />);
    expect(mockedRecover).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-reload for a non-ChunkLoadError and calls reset on retry', () => {
    const reset = vi.fn();
    render(<AppError error={genericError()} reset={reset} />);

    expect(mockedRecover).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button'));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('app/global-error.tsx (Issue #1404)', () => {
  it('triggers guarded recovery exactly once for a ChunkLoadError', () => {
    render(<GlobalError error={chunkError()} reset={vi.fn()} />);
    expect(mockedRecover).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-reload for a non-ChunkLoadError', () => {
    render(<GlobalError error={genericError()} reset={vi.fn()} />);
    expect(mockedRecover).not.toHaveBeenCalled();
  });

  it('renders a provider-independent fallback (no i18n provider required)', () => {
    const { container } = render(<GlobalError error={genericError()} reset={vi.fn()} />);
    // English default before client locale detection; copy is inline, not keyed.
    expect(container.textContent).toContain('Something went wrong');
  });
});
