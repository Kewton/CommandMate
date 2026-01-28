/**
 * API Route: GET/POST /api/worktrees/:id/auto-yes
 * Manages auto-yes mode state for a worktree
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { getAutoYesState, setAutoYesEnabled, type AutoYesState } from '@/lib/auto-yes-manager';

/** Build the JSON response shape from an AutoYesState */
function buildAutoYesResponse(state: AutoYesState | null): { enabled: boolean; expiresAt: number | null } {
  return {
    enabled: state?.enabled ?? false,
    expiresAt: state?.enabled ? state.expiresAt : null,
  };
}

/** Validate that the worktree exists; returns 404 response if not found */
function validateWorktreeExists(worktreeId: string): NextResponse | null {
  const db = getDbInstance();
  const worktree = getWorktreeById(db, worktreeId);
  if (!worktree) {
    return NextResponse.json(
      { error: `Worktree '${worktreeId}' not found` },
      { status: 404 }
    );
  }
  return null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const notFound = validateWorktreeExists(params.id);
    if (notFound) return notFound;

    const state = getAutoYesState(params.id);
    return NextResponse.json(buildAutoYesResponse(state));
  } catch (error: unknown) {
    console.error('Error getting auto-yes state:', error);
    return NextResponse.json(
      { error: 'Failed to get auto-yes state' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const notFound = validateWorktreeExists(params.id);
    if (notFound) return notFound;

    const body = await request.json();
    if (typeof body.enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'enabled must be a boolean' },
        { status: 400 }
      );
    }

    const state = setAutoYesEnabled(params.id, body.enabled);
    return NextResponse.json(buildAutoYesResponse(state));
  } catch (error: unknown) {
    console.error('Error setting auto-yes state:', error);
    return NextResponse.json(
      { error: 'Failed to set auto-yes state' },
      { status: 500 }
    );
  }
}
