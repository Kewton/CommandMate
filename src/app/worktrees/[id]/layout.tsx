/**
 * Worktree route segment layout.
 *
 * Its only job is to keep a URL that names a worktree by a **historical** ID
 * working (Issue #1621, Phase 2). A worktree ID escapes into places the app
 * cannot rewrite — an open tab, a phone, a PWA shortcut, a bookmark — so when
 * the ID behind a directory changes, every one of those references 404s. The
 * alias table records what the ID used to be; this sends the browser to what it
 * is now.
 *
 * Placed on the layout rather than on `page.tsx` so it also covers
 * `/worktrees/<id>/terminal` and `/worktrees/<id>/files/...`, which are client
 * components that never touch the server. The cost is that a nested URL lands
 * on the worktree's detail page rather than on the same sub-page: a layout
 * cannot see the path below it, and the alternative (splitting each nested page
 * into a server shell plus a client body) is a much larger change for a case
 * that only arises for bookmarks of sub-pages. Landing on the right worktree
 * beats 404 either way.
 *
 * ## The redirect is a meta refresh (HTTP 200), NOT the 301 the design asked for
 *
 * Measured against a real server (`tsx server.ts`, NODE_ENV=production,
 * isolated DB): `permanentRedirect` from this layout returns
 *
 *     HTTP/1.1 200 OK
 *     <meta id="__next-page-redirect" http-equiv="refresh" content="0;url=/worktrees/<new id>">
 *
 * That is Next.js App Router behaviour, not a symptom of anything here — an
 * unconditional `permanentRedirect('/probe-target')` as the layout's very first
 * statement produces the same 200 + meta tag, with `loading.tsx` present or
 * removed. The App Router emits a real 3xx only from Route Handlers, Server
 * Actions and middleware; a redirect thrown while a page's HTML is already
 * streaming can no longer set a status line, so it is delivered in the document
 * instead.
 *
 * A browser follows it, so the user-visible goal holds: an old tab, phone, PWA
 * shortcut or bookmark lands on the current worktree instead of a 404. What is
 * lost is what a status code buys — the browser does not rewrite the bookmark,
 * and a non-browser client does not follow it.
 *
 * Getting a true 301/308 needs the request intercepted before rendering starts,
 * i.e. `middleware.ts` or the custom `server.ts`. Neither is reachable from this
 * change (both are outside its scope), and middleware additionally runs on the
 * edge runtime, where the SQLite lookup this needs is impossible. The follow-up
 * belongs with #1645, which renumbers the existing rows and therefore owns the
 * moment old IDs actually start arriving.
 *
 * Resolution failures never block the page: `canonicalWorktreeId` is total and
 * returns the requested ID unchanged when it cannot do better, so an unmigrated
 * or unreadable database renders exactly what it renders today.
 */

import { permanentRedirect } from 'next/navigation';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

export default async function WorktreeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const canonicalId = canonicalWorktreeId(id);

  if (canonicalId !== id) {
    // Note: permanentRedirect throws, so nothing below runs.
    permanentRedirect(`/worktrees/${encodeURIComponent(canonicalId)}`);
  }

  return <>{children}</>;
}
