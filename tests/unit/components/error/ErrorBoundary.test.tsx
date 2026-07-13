/**
 * Tests for ErrorBoundary DefaultErrorFallback and the themed error fallbacks
 * (Issue #1112: status tint token migration).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import {
  HistoryErrorFallback,
  PromptErrorFallback,
  ConnectionErrorFallback,
} from '@/components/error/fallbacks';

function Bomb(): React.ReactElement {
  throw new Error('boom');
}

describe('ErrorBoundary DefaultErrorFallback (Issue #1112)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the fallback with danger tint tokens when a child throws', () => {
    const { container } = render(
      <ErrorBoundary componentName="TestComponent">
        <Bomb />
      </ErrorBoundary>
    );

    const fallback = container.firstElementChild as HTMLElement;
    expect(fallback).not.toBeNull();
    expect(fallback.className).toContain('bg-danger-subtle');
    expect(fallback.className).toContain('border-danger-border');
    expect(fallback.className).not.toMatch(/bg-red-\d/);
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('recovers via the retry button', () => {
    let shouldThrow = true;
    function MaybeBomb(): React.ReactElement {
      if (shouldThrow) throw new Error('boom');
      return <div data-testid="recovered">ok</div>;
    }

    render(
      <ErrorBoundary>
        <MaybeBomb />
      </ErrorBoundary>
    );

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('recovered')).toBeInTheDocument();
  });
});

describe('error fallbacks tint tokens (Issue #1112)', () => {
  it('PromptErrorFallback uses warning tint tokens', () => {
    const { container } = render(<PromptErrorFallback error={new Error('x')} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('bg-warning-subtle');
    expect(root.className).toContain('border-warning-border');
    expect(root.className).not.toMatch(/yellow-\d/);
  });

  it('ConnectionErrorFallback uses warning tint tokens', () => {
    const { container } = render(<ConnectionErrorFallback error={new Error('x')} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('bg-warning-subtle');
    expect(root.className).toContain('border-warning-border');
    expect(root.className).not.toMatch(/orange-\d/);
  });

  it('HistoryErrorFallback uses neutral semantic tokens', () => {
    const { container } = render(<HistoryErrorFallback error={new Error('x')} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('bg-surface');
    expect(root.className).not.toMatch(/bg-gray-\d/);
  });
});
