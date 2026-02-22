/**
 * Auth Status API Route
 * Issue #331: Token authentication
 *
 * GET: Returns whether authentication is enabled
 *
 * force-dynamic: This route must NOT be statically cached at build time.
 * CM_AUTH_TOKEN_HASH is set at runtime (not available during npm run build),
 * so static caching would always return authEnabled:false.
 */

import { NextResponse } from 'next/server';
import { isAuthEnabled } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    authEnabled: isAuthEnabled(),
  });
}
