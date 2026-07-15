/**
 * ViewTransitionsProvider (Issue #1122).
 *
 * Bridges the browser View Transitions API to Next.js App Router client
 * navigation. `document.startViewTransition` captures the old DOM, runs a
 * callback, then captures the new DOM — but `router.push` commits the route
 * asynchronously, so the callback must stay pending until the new route is
 * live. This provider holds that resolver and settles it when `usePathname`
 * reports the commit (with a safety timeout so a same-route or interrupted
 * navigation never hangs the callback).
 *
 * Mounted once in AppProviders so it — and its pathname subscription — persist
 * across navigation even though the app shell is re-created per page.
 */

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { startViewTransition as runViewTransition } from '@/lib/view-transitions';

/**
 * Upper bound (ms) for how long the transition callback waits on a route
 * commit before settling anyway. Legitimate client navigations commit well
 * under this (a `loading.tsx` boundary updates the pathname promptly); it only
 * guards the pathological "pathname never changes" case.
 */
const COMMIT_SAFETY_TIMEOUT_MS = 500;

interface ViewTransitionContextValue {
  /** Wrap a navigation in a view transition (or run it immediately on fallback). */
  startTransition: (navigate: () => void) => void;
}

const FALLBACK: ViewTransitionContextValue = {
  startTransition: (navigate) => navigate(),
};

const ViewTransitionContext = createContext<ViewTransitionContextValue | null>(null);

/** Access the view-transition navigation helper. Safe without a provider. */
export function useViewTransition(): ViewTransitionContextValue {
  return useContext(ViewTransitionContext) ?? FALLBACK;
}

/** App Router navigation that crossfades via the View Transitions API. */
export function useViewTransitionRouter(): {
  push: (href: string) => void;
  replace: (href: string) => void;
} {
  const router = useRouter();
  const { startTransition } = useViewTransition();
  return useMemo(
    () => ({
      push: (href: string) => startTransition(() => router.push(href)),
      replace: (href: string) => startTransition(() => router.replace(href)),
    }),
    [router, startTransition],
  );
}

/**
 * Resolves the pending transition once the route actually commits. Isolated
 * from the provider body so subscribing to `usePathname` re-renders only this
 * leaf, not the whole app tree.
 */
function RouteCommitWatcher({ onCommit }: { onCommit: () => void }) {
  const pathname = usePathname();
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    onCommit();
  }, [pathname, onCommit]);
  return null;
}

export function ViewTransitionsProvider({ children }: { children: ReactNode }) {
  const finishRef = useRef<(() => void) | null>(null);

  const resolvePending = useCallback(() => {
    finishRef.current?.();
  }, []);

  const startTransition = useCallback((navigate: () => void) => {
    runViewTransition(
      () =>
        new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          finishRef.current = settle;
          navigate();
          window.setTimeout(settle, COMMIT_SAFETY_TIMEOUT_MS);
        }),
    );
  }, []);

  const value = useMemo(() => ({ startTransition }), [startTransition]);

  return (
    <ViewTransitionContext.Provider value={value}>
      <RouteCommitWatcher onCommit={resolvePending} />
      {children}
    </ViewTransitionContext.Provider>
  );
}
