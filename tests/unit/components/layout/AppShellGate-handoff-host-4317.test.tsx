/**
 * `AppShellGate` mounts the hand-off dialog's one host beside the shell (Issue #4317 PR2).
 *
 * The host is a sibling of `AppShell` at the same position on every path, so neither a navigation
 * (between worktrees, or to a path with no shell and back) nor the gate's own branch makes it anew:
 * one mount over the whole run, one host in the document. It is not under the shell (the shell's
 * stub here does not draw it).
 *
 * `AppShell` and the host are light stubs that count their mounts.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const nav = vi.hoisted(() => ({ pathname: '/worktrees/wt-a' }));
const mounts = vi.hoisted(() => ({ shell: 0, host: 0 }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
}));
vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => {
    React.useEffect(() => {
      mounts.shell += 1;
    }, []);
    return <div data-testid="app-shell">{children}</div>;
  },
}));
vi.mock('@/components/mem/HandoffDialogHost', () => ({
  HandoffDialogHost: () => {
    React.useEffect(() => {
      mounts.host += 1;
    }, []);
    return <div data-testid="handoff-host" />;
  },
}));

import { AppShellGate } from '@/components/layout/AppShellGate';

beforeEach(() => {
  nav.pathname = '/worktrees/wt-a';
  mounts.shell = 0;
  mounts.host = 0;
});
afterEach(() => cleanup());

describe('[#4317 PR2] the hand-off host beside the shell', () => {
  it('one host, outside the shell, mounted once across worktrees, a path without the shell and back', () => {
    const view = render(<AppShellGate><div data-testid="page" /></AppShellGate>);
    const host = screen.getByTestId('handoff-host');
    expect(screen.getByTestId('app-shell').contains(host)).toBe(false);
    for (const pathname of ['/worktrees/wt-b', '/worktrees/wt-a/terminal', '/login', '/worktrees/wt-a', '/']) {
      nav.pathname = pathname;
      view.rerender(<AppShellGate><div data-testid="page" /></AppShellGate>);
      expect(screen.getAllByTestId('handoff-host')).toHaveLength(1);
      expect(screen.getByTestId('handoff-host')).toBe(host);
    }
    expect(mounts.host).toBe(1);
    // (negative control) the shell's own branch is made anew by the excluded paths, as before.
    expect(mounts.shell).toBeGreaterThan(1);
  });
});
