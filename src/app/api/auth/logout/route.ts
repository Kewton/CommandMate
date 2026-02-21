/**
 * Logout API Route
 * Issue #331: Token authentication
 *
 * POST: Clear auth cookie and redirect to login
 */

import { NextResponse } from 'next/server';
import { AUTH_COOKIE_NAME } from '@/lib/auth';

export async function POST() {
  const response = NextResponse.json({ success: true });

  // Clear the auth cookie
  response.cookies.set(AUTH_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  });

  return response;
}
