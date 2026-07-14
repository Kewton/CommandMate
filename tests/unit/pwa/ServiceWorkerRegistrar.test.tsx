/**
 * Unit tests for ServiceWorkerRegistrar (Issue #1124).
 *
 * Verifies the production-only registration guard: under NODE_ENV=test (as in
 * this suite) the worker must never be registered, matching the dev behaviour.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { ServiceWorkerRegistrar } from '@/components/pwa/ServiceWorkerRegistrar';

describe('ServiceWorkerRegistrar', () => {
  const register = vi.fn(() => Promise.resolve({}));

  beforeEach(() => {
    register.mockClear();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        controller: null,
      },
    });
  });

  it('does not register the service worker outside production', () => {
    render(<ServiceWorkerRegistrar />);
    expect(register).not.toHaveBeenCalled();
  });

  it('renders nothing when no update is pending', () => {
    const { container } = render(<ServiceWorkerRegistrar />);
    expect(container.firstChild).toBeNull();
  });
});
