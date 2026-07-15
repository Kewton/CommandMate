/**
 * RouteLoading Component
 * Shared route-level Suspense fallback for App Router loading.tsx files
 * (Issue #1118).
 *
 * Deliberately shape-free. All seven `loading.tsx` files share this one
 * fallback, so it cannot know which screen is arriving; any page outline it
 * draws is wrong for the other six. [Issue #1184] it drew a heading plus two
 * side-by-side cards — the Home bento outline — so every navigation briefly
 * flashed what read as a half-rendered Home. Keep it an indeterminate
 * indicator, not a content skeleton.
 *
 * It still fills the viewport: pages render their own AppShell, so this
 * renders with no shell around it, and covering the viewport is what keeps the
 * swap into the real shell from flashing blank or jumping (the #1118 intent).
 *
 * Dots use `bg-muted-foreground`, not the `Skeleton` primitive's `bg-muted` —
 * a slab colour for large placeholder blocks that is invisible at dot size on
 * the light `--background`. Matches ConversationPairCard's PendingIndicator.
 *
 * `prefers-reduced-motion` is handled globally in globals.css (Issue #1050),
 * which resets animation-duration/-delay — do not re-implement it here.
 */

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
  return (
    <div
      className="flex min-h-screen w-full items-center justify-center p-8"
      role="status"
      aria-label="Loading page"
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
