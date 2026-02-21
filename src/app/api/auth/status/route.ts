/**
 * Auth Status API Route
 * Issue #331: Token authentication
 *
 * GET: Returns whether authentication is enabled
 */

import { NextResponse } from 'next/server';
import { isAuthEnabled } from '@/lib/auth';

export async function GET() {
  return NextResponse.json({
    authEnabled: isAuthEnabled(),
  });
}
