/**
 * API Route: GET /api/capabilities
 *
 * Issue #1925 (design §10.6 / DR4-008): lets a CLI ask what the running server
 * can do before it depends on it. The CLI is routinely newer than the daemon —
 * `npm i -g commandmate` does not restart a running server — so a CLI that
 * simply called a new endpoint and read the 404 could not tell "this server is
 * older than me" from "that worktree does not exist": Next.js answers an
 * unimplemented App Router path with a 404 that carries no `code`, and the
 * CLI's error mapping flattens both into "Resource not found."
 *
 * Deliberately inert:
 * - The body is `serverVersion` plus a fixed token list compiled into the
 *   build. No installed-tool inventory, no paths, no ports, no worktree counts:
 *   `CM_AUTH_TOKEN_HASH` unset skips auth entirely and `CM_BIND=0.0.0.0` is a
 *   supported configuration, so "authentication is off and the port is on the
 *   LAN" is a real deployment and this response must be worthless to it.
 * - Not listed in AUTH_EXCLUDED_PATHS: it lives under the same middleware auth
 *   as every other API route.
 * - No rate limiter (DR4-015): unlike `resolve-target` this route reads no
 *   database and spawns no child process, so a flood of requests costs the same
 *   as a flood of 404s. `createRequestRateLimiter` is for routes whose work is
 *   the expensive part.
 */

import { NextResponse } from 'next/server';
import { getServerVersion } from '@/lib/version-checker';

// The version is read from the runtime package.json, so prerendering it at
// build time would freeze the answer of a server that later gets upgraded.
export const dynamic = 'force-dynamic';

/**
 * Capability tokens this build declares.
 *
 * A token is a promise about a wire contract, not about an implementation, and
 * it is never removed once shipped — a client that keys off it must keep
 * working against every later server. Add one when a client needs to know
 * whether an endpoint exists before calling it.
 */
export const SERVER_CAPABILITIES = [
  /** GET /api/worktrees/:id/resolve-target answers with {cliToolId, instanceId, resolvedBy}. */
  'resolve-session-target',
] as const;

/** Exact response shape. Pinned key-for-key by tests/unit/api/capabilities.test.ts. */
export interface CapabilitiesResponse {
  serverVersion: string;
  capabilities: string[];
}

export async function GET(): Promise<NextResponse> {
  const body: CapabilitiesResponse = {
    serverVersion: getServerVersion(),
    capabilities: [...SERVER_CAPABILITIES],
  };
  return NextResponse.json(body, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
