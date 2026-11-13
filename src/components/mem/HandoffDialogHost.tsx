/**
 * The one host of the hand-off dialog (Issue #4317 PR2, design `mem-ui-4227.md` §4.1.1; the
 * pre-review `prereview-4317-reply.md` 1・2).
 *
 * Mounted once by `AppShellGate`, beside the shell — outside the route (its `loading.tsx` and the
 * page Next keys by its `[id]`) and outside the page's PC / phone branches — so neither a switch of
 * worktree nor a switch of width makes it anew. Before, the host was the page itself
 * (`WorktreeDetailRefactored`), inside the route's dynamic segment: on the dev server B → A by
 * `router.push` left 0 dialogs for 0.25〜0.35 s (the route's Loading, before A's page existed).
 *
 * The page keeps the hand-off's state and rules (`useWorktreeDetailController`): it registers
 * (`@/lib/handoff/page-registration`) and publishes on its registration its target, its close
 * through the rule and its existing stop. This host draws:
 *
 * | state | dialogs |
 * |---|---|
 * | a worktree's detail route whose page is the current registration, its view with a target | 1 (that page's; foreign on another worktree's page) |
 * | a detail route whose page is not the current registration or has published nothing yet (the route's Loading, a page made again, the page being left still registered) | 1 when the route's page will take the store's opening back (`handoffTakeBackOf`), its buttons disabled (no registration: nothing new starts, no last callback is used); else 0 |
 * | the session expired (the registry's `authExpired`) | 0 (unmounted, never hidden: a hidden dialog closes its opening) |
 * | not a detail route (the list, settings, login / offline / proxy, the terminal and files screens) or the path not known | 0 (unmounted) |
 *
 * `shouldRenderShell()` is not this host's permission: it is true on the list too. The detail route
 * is read from the path itself.
 *
 * What the dialog keeps of its own (the person's choices, the notice, `writing`) is per opening: the
 * dialog sets it afresh when another opening (token) is shown, and keeps it — and its DOM — while the
 * same opening is shown over a route or width change (it is never keyed, so never made anew here).
 *
 * The host reports the path's detail route to the registry (`reportHandoffRoute`): a registration
 * not on the route (B still registered while the path is A's) is not drawn as the route's page and
 * — the same test, in `handoffPageMayStart` — starts nothing new after its awaits either.
 *
 * This host writes nothing of the store: it reads the opening (`handoffStoreSnapshot`) and the
 * registry; every start and close is the dialog's, under its registration and the existing rule.
 *
 * @module components/mem/HandoffDialogHost
 */
'use client';

import { useLayoutEffect, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { SessionHandoffDialog, type SessionHandoffTarget } from '@/components/mem/SessionHandoffDialog';
import { handoffStoreSnapshot, subscribeHandoffStore, type HandoffStoreState, type SessionStopResult } from '@/lib/handoff/close-rule';
import {
  currentHandoffPage,
  handoffRegistrationOnRoute,
  handoffRegistrySnapshot,
  reportHandoffRoute,
  subscribeHandoffRegistry,
  type HandoffPageRegistration,
  type HandoffRegistryState,
} from '@/lib/handoff/page-registration';
import { handoffTakeBackOf } from '@/lib/handoff/take-back';
import { isCliToolType } from '@/lib/cli-tools/types';

/** A worktree's detail route (`/worktrees/<id>`, not its terminal or files screens). */
const DETAIL_ROUTE = /^\/worktrees\/([^/]+)\/?$/;

/** The worktree whose detail route `pathname` is; `null` for any other path or none. */
export function handoffHostWorktreeOf(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const match = DETAIL_ROUTE.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export interface HandoffHostView {
  /** The page's worktree (the opening's own, or the page it is foreign on). */
  readonly worktreeId: string;
  readonly target: SessionHandoffTarget;
  readonly onClose: () => void;
  readonly onStop: () => Promise<SessionStopResult>;
  /** The page's registration; `null` while no page is registered (the dialog starts nothing). */
  readonly registration: HandoffPageRegistration | null;
}

const NO_CLOSE = (): void => undefined;
const NO_STOP = async (): Promise<SessionStopResult> => 'refused';

/** Pure: what the host draws for this path, registry and store (`null`: nothing). */
export function handoffHostView(pathname: string | null | undefined, registry: HandoffRegistryState, store: HandoffStoreState): HandoffHostView | null {
  const route = handoffHostWorktreeOf(pathname);
  if (route === null || registry.authExpired) return null;
  // The current registration, when it is the route's page (a page being left is not the route's).
  const current = currentHandoffPage(registry);
  // The same test as `handoffPageMayStart`'s (the route reported below): one condition for what is
  // drawn as the route's page and for what its dialog may start.
  if (current !== null && current.view !== null && handoffRegistrationOnRoute(current.worktreeId, route)) {
    const { target, onClose, onStop } = current.view;
    if (target === null) return null;
    return { worktreeId: current.worktreeId, target, onClose, onStop, registration: current.id };
  }
  // No page of the route registered (or none published yet; the page being left still registered):
  // what the route's page will take back, inert.
  const back = handoffTakeBackOf(route, isCliToolType, store);
  if (back === null) return null;
  return { worktreeId: route, target: back.target, onClose: NO_CLOSE, onStop: NO_STOP, registration: null };
}

export function HandoffDialogHost() {
  const pathname = usePathname();
  const registry = useSyncExternalStore(subscribeHandoffRegistry, handoffRegistrySnapshot, handoffRegistrySnapshot);
  const store = useSyncExternalStore(subscribeHandoffStore, handoffStoreSnapshot, handoffStoreSnapshot);
  const route = handoffHostWorktreeOf(pathname);
  /**
   * PR2 再指示 1: the route takes part in `handoffPageMayStart` — a continuation of a page that is not
   * the route's (B still registered, the path A's) starts nothing new. Reported in the commit (a
   * layout effect: before any awaited continuation runs on), and `null` once the host is gone.
   */
  useLayoutEffect(() => {
    reportHandoffRoute(route);
    return () => reportHandoffRoute(null);
  }, [route]);
  const view = handoffHostView(pathname, registry, store);
  if (view === null) return null;
  return (
    <SessionHandoffDialog
      isOpen
      worktreeId={view.worktreeId}
      target={view.target}
      onClose={view.onClose}
      onStop={view.onStop}
      registration={view.registration}
    />
  );
}
