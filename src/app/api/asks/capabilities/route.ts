/**
 * API Route: GET /api/asks/capabilities (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3.1・§3.2).
 *
 * The protocol version of the ask envelope and, per tool, whether this server
 * attributes an ask's reply by the correlation ledger. The one source of that
 * table (`ASK_ATTRIBUTION_TOOLS`): the CLI is to ask here (design §6 PR3) instead of keeping a copy,
 * and an older server answers 404, which it reads as "not attributed".
 *
 * Inert like `/api/capabilities`: a fixed table compiled into the build, no
 * database, under the same middleware auth as every other API route.
 */

import { NextResponse } from 'next/server';
import { getAskCapabilities } from '@/lib/ask/ask-correlation';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(getAskCapabilities(), {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
