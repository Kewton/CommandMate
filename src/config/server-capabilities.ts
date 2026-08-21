/**
 * Capability tokens the running server declares (Issue #1925, design §10.6 / DR4-008).
 *
 * Lives outside `src/app/api/**` because an App Router `route.ts` may only export
 * the fields Next.js knows about (`GET`, `dynamic`, `revalidate`, …). Exporting
 * anything else — even a plain `const` the tests read — fails the build with
 * `"X" is not a valid Route export field`, and neither `tsc --noEmit` nor the
 * unit suite sees it because the check lives in Next's own build step (Issue #1943).
 *
 * A token is a promise about a wire contract, not about an implementation, and it
 * is never removed once shipped — a client that keys off it must keep working
 * against every later server. Add one when a client needs to know whether an
 * endpoint exists before calling it.
 */
export const SERVER_CAPABILITIES = [
  /** GET /api/worktrees/:id/resolve-target answers with {cliToolId, instanceId, resolvedBy}. */
  'resolve-session-target',
] as const;

/** Exact response shape of GET /api/capabilities. Pinned key-for-key by tests. */
export interface CapabilitiesResponse {
  serverVersion: string;
  capabilities: string[];
}
