/**
 * Logout API Route
 * Issue #331: Token authentication
 *
 * POST: Clear auth cookie and redirect to login
 */

import { NextResponse } from 'next/server';
import { AUTH_COOKIE_NAME, buildAuthCookieOptions } from '@/lib/auth';

export async function POST() {
  const response = NextResponse.json({ success: true });

  // Clear the auth cookie (maxAge: 0 instructs the browser to delete it)
  response.cookies.set(AUTH_COOKIE_NAME, '', buildAuthCookieOptions(0));

  return response;
}
