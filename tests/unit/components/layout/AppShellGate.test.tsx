/**
 * `AppShellGate` — the shell survives a navigation (Issue #2682).
 *
 * The bug this pins was never in the links: `Sidebar` already navigates with
 * `next/link` and the settings gear with `useViewTransitionRouter().push()`.
 * It was in where the shell was mounted — nine `page.tsx` files each rendered
 * their own `<AppShell>`, so a route change tore the shell down and built a new
 * one, taking the sidebar's scroll position and every piece of shell-local
 * state with it.
 *
 * So the subject here is identity, not markup: across a change of `pathname`
 * the shell element must be the SAME DOM node, mounted exactly once. The
 * regression that would undo this is a single character — `<AppShell
 * key={pathname}>` — and it is invisible to any assertion that only looks at
 * what is on screen.
 *
 * `AppShell` itself is replaced by a light stub: the real one drags in Sidebar,
 * Header, the command palette and four contexts, none of which this file is
 * about (`AppShell-layout.test.tsx` and `components/layout/AppShell.test.tsx`
 * are). The stub carries the two attributes the assertions below read, spelled
 * exactly as the real component spells them (`AppShell.tsx:156` / `:215` for
 * `data-testid`, `:192` / `:262` for `data-view-transition`).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const nav = vi.hoisted(() => ({ pathname: '/' }));
const shellMounts = vi.hoisted(() => ({ count: 0 }));
const childMounts = vi.hoisted(() => ({ count: 0 }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
}));

vi.mock('@/components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => {
    React.useEffect(() => {
      shellMounts.count += 1;
    }, []);
    return (
      <div data-testid="app-shell">
        <main data-view-transition="content">{children}</main>
      </div>
    );
  },
}));

import { AppShellGate, shouldRenderShell } from '@/components/layout/AppShellGate';

/** A page stand-in that reports its own mount count, the way page state would. */
function PageBody() {
  React.useEffect(() => {
    childMounts.count += 1;
  }, []);
  return <div data-testid="page-body" />;
}

function contentNodes(): NodeListOf<Element> {
  return document.querySelectorAll('[data-view-transition="content"]');
}

beforeEach(() => {
  nav.pathname = '/';
  shellMounts.count = 0;
  childMounts.count = 0;
});

afterEach(() => {
  cleanup();
});

describe('AppShellGate — 遷移でシェルが作り直されないこと (Issue #2682)', () => {
  it('keeps the same shell node, and one mount, across /repositories → /sessions → /worktrees/abc', () => {
    nav.pathname = '/repositories';
    const { rerender } = render(
      <AppShellGate>
        <PageBody />
      </AppShellGate>
    );

    const before = screen.getByTestId('app-shell');
    expect(shellMounts.count).toBe(1);
    expect(contentNodes()).toHaveLength(1);

    for (const pathname of ['/sessions', '/worktrees/abc']) {
      nav.pathname = pathname;
      rerender(
        <AppShellGate>
          <PageBody />
        </AppShellGate>
      );

      // Identity, not equality: a `key={pathname}` would hand back a new node
      // that looks identical.
      expect(screen.getByTestId('app-shell')).toBe(before);
      expect(shellMounts.count).toBe(1);
      expect(contentNodes()).toHaveLength(1);
    }
  });

  it('re-mounts only the page body, which is the part a navigation is allowed to replace', () => {
    nav.pathname = '/repositories';
    const { rerender } = render(
      <AppShellGate>
        <PageBody />
      </AppShellGate>
    );
    expect(childMounts.count).toBe(1);

    // A real navigation swaps `children` for a different page element; the
    // shell around it must not notice.
    nav.pathname = '/sessions';
    rerender(
      <AppShellGate>
        <div data-testid="other-page" />
      </AppShellGate>
    );

    expect(screen.getByTestId('other-page')).toBeInTheDocument();
    expect(screen.queryByTestId('page-body')).toBeNull();
    expect(shellMounts.count).toBe(1);
  });
});

describe('shouldRenderShell — 判定表 (Issue #2682)', () => {
  it.each([
    '/',
    '/repositories',
    '/sessions',
    '/review',
    '/more',
    '/skills',
    '/skills/installed',
    '/skills/abc',
    '/worktrees/abc',
  ])('renders the shell on %s', (pathname) => {
    expect(shouldRenderShell(pathname)).toBe(true);
  });

  it.each([
    '/login',
    '/offline',
    '/proxy/x',
    '/worktrees/abc/terminal',
    '/worktrees/abc/files',
    '/worktrees/abc/files/src/index.ts',
  ])('renders no shell on %s', (pathname) => {
    expect(shouldRenderShell(pathname)).toBe(false);
  });

  // Negative controls: the exclusions are segment-boundary prefixes, not
  // substring matches. A route that merely starts with the same letters is a
  // different route and keeps the shell.
  it.each(['/loginx', '/worktrees/abc/filesx', '/offlinex', '/proxyx'])(
    'does not mistake %s for an excluded path',
    (pathname) => {
      expect(shouldRenderShell(pathname)).toBe(true);
    }
  );
});

describe('AppShellGate — どちらを描くか (Issue #2682)', () => {
  it('draws exactly one shell around the children on a shell path', () => {
    nav.pathname = '/sessions';
    render(
      <AppShellGate>
        <PageBody />
      </AppShellGate>
    );

    expect(screen.getAllByTestId('app-shell')).toHaveLength(1);
    expect(screen.getByTestId('app-shell')).toContainElement(screen.getByTestId('page-body'));
  });

  it('draws the children alone on an excluded path', () => {
    nav.pathname = '/worktrees/abc/terminal';
    render(
      <AppShellGate>
        <PageBody />
      </AppShellGate>
    );

    expect(screen.queryByTestId('app-shell')).toBeNull();
    expect(screen.getByTestId('page-body')).toBeInTheDocument();
    expect(shellMounts.count).toBe(0);
  });

  it('drops the shell when a navigation leaves the shell paths, and brings it back', () => {
    nav.pathname = '/sessions';
    const { rerender } = render(
      <AppShellGate>
        <PageBody />
      </AppShellGate>
    );
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();

    nav.pathname = '/login';
    rerender(
      <AppShellGate>
        <PageBody />
      </AppShellGate>
    );
    expect(screen.queryByTestId('app-shell')).toBeNull();

    nav.pathname = '/sessions';
    rerender(
      <AppShellGate>
        <PageBody />
      </AppShellGate>
    );
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(shellMounts.count).toBe(2);
  });
});
