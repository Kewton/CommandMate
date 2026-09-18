/**
 * RouteLoading Component
 * Shared route-level Suspense fallback for App Router loading.tsx files
 * (Issue #1118).
 *
 * Deliberately shape-free. All six `loading.tsx` files share this one
 * fallback, so it cannot know which screen is arriving; any page outline it
 * draws is wrong for the other five. [Issue #1184] it drew a heading plus two
 * side-by-side cards — the Home bento outline — so every navigation briefly
 * flashed what read as a half-rendered Home. Keep it an indeterminate
 * indicator, not a content skeleton.
 *
 * The root layout renders the AppShell (Issue #2682), so inside the shell this
 * fallback fills the main area. It does that with `h-full`, not `flex-1`:
 * `<main data-view-transition="content">` is `display: block` (it is itself a
 * flex *item* of the shell column), so a `flex-1` child is not a flex item and
 * the rule is inert — Issue #2683 shipped `flex-1` and the dots rendered in a
 * 192px band at the top of the main area. The pages rendered inside the shell
 * fill `<main>` the same way (`h-full` on their root element); the one that does
 * not is the mobile worktree screen, which carries its own viewport height.
 *
 * `min-h-[12rem]` is the floor for routes rendered without a shell, where the
 * parent's height is auto and `h-full` resolves to auto (Issue #2683).
 *
 * Dots use `bg-muted-foreground`, not the `Skeleton` primitive's `bg-muted` —
 * a slab colour for large placeholder blocks that is invisible at dot size on
 * the light `--background`. Matches ConversationPairCard's PendingIndicator.
 *
 * `prefers-reduced-motion` is handled globally in globals.css (Issue #1050),
 * which resets animation-duration/-delay — do not re-implement it here.
 */

import { useTranslations } from 'next-intl';

/**
 * Stagger for the indeterminate pulse. Whole literal class strings so the
 * Tailwind scanner picks them up.
 */
const DOT_DELAYS = [
  '[animation-delay:0ms]',
  '[animation-delay:150ms]',
  '[animation-delay:300ms]',
] as const;

export function RouteLoading() {
  const t = useTranslations('common');

  return (
    <div
      className="flex w-full h-full min-h-[12rem] items-center justify-center p-8"
      role="status"
      aria-label={t('loadingPage')}
      data-testid="route-loading"
    >
      <div className="flex items-center gap-2" aria-hidden="true">
        {DOT_DELAYS.map((delay) => (
          <span
            key={delay}
            className={`h-2.5 w-2.5 rounded-full bg-muted-foreground animate-pulse ${delay}`}
          />
        ))}
      </div>
    </div>
  );
}
