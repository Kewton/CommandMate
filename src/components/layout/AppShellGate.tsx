/**
 * AppShellGate Component
 *
 * Issue #2682: the shell (Sidebar / Header / main) is mounted ONCE, by the root
 * layout, instead of once per page.
 *
 * Before this, nine `page.tsx` files each rendered their own `<AppShell>`. A
 * page is below the layout in the App Router tree, so moving between two of
 * them tears the whole shell down and builds a new one: the sidebar's scroll
 * position, the hover-frozen ordering and every piece of shell-local state go
 * with it, which is what made a nav click read as a full reload. Only moves
 * *within* the `/worktrees/[id]` segment felt light, because there the shell
 * happened to stay mounted.
 *
 * The shell now lives in `src/app/layout.tsx`, above every route, so a
 * navigation swaps only `children` — the `<main>` — and `AppShell` is never
 * re-created.
 *
 * ## Why a pathname gate rather than a route group
 *
 * Four screens deliberately render no shell: `/login`, `/offline`,
 * `/worktrees/<id>/terminal` and `/worktrees/<id>/files/...`. Moving the other
 * pages into an `(app)` route group would either drag the two standalone
 * worktree screens along (they sit *below* `/worktrees/[id]`) or force the
 * historical-ID redirect layout (`src/app/worktrees/[id]/layout.tsx`, Issue
 * #1621) to be split and duplicated. So no file moves: the gate decides from
 * the pathname instead.
 *
 * ## The one invariant
 *
 * This component must stay a plain branch on `pathname`. Keying the shell on
 * the pathname (`<AppShell key={pathname}>`) would re-create it on every
 * navigation and put back exactly the bug this removes.
 */

'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AppShell } from '@/components/layout/AppShell';

/**
 * Route prefixes that render no shell. Matched as a prefix, on a segment
 * boundary — `/loginx` is a different route and keeps the shell.
 *
 * `/proxy` has no page of its own today (it is a route handler,
 * `src/app/proxy/[...path]/route.ts`, which never passes through a layout); it
 * is listed so a future page there does not silently inherit the shell.
 */
export const SHELL_EXCLUDED_PREFIXES = ['/login', '/offline', '/proxy'] as const;

/**
 * The two standalone screens under a worktree: `/worktrees/<id>/terminal` and
 * `/worktrees/<id>/files/...`. `/worktrees/<id>` itself keeps the shell.
 */
export const SHELL_EXCLUDED_WORKTREE_SUBPATHS = /^\/worktrees\/[^/]+\/(terminal|files)(\/|$)/;

/** Whether this path renders the shell (Sidebar / Header / main). */
export function shouldRenderShell(pathname: string): boolean {
  if (SHELL_EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return false;
  if (SHELL_EXCLUDED_WORKTREE_SUBPATHS.test(pathname)) return false;
  return true;
}

/**
 * Wraps the root layout's children in the shell, except on the paths above.
 */
export function AppShellGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (!shouldRenderShell(pathname ?? '')) return <>{children}</>;
  return <AppShell>{children}</AppShell>;
}
