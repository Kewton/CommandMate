/**
 * Repository API Route (individual repository)
 * PUT: Update repository display_name and/or visible (partial update)
 *
 * Issue #642: Repository display name (alias) feature
 * Issue #644: Shared MAX_DISPLAY_NAME_LENGTH constant
 * Issue #690: Add `visible` partial-update for sidebar visibility toggle.
 *
 * Validation rules (Issue #690):
 *   - At least one of `displayName` or `visible` must be provided.
 *   - `visible`, when present, must be a boolean.
 *   - Updating `visible` does NOT touch `enabled` (concept independence).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getRepositoryById, updateRepository } from '@/lib/db/db-repository';
import { MAX_DISPLAY_NAME_LENGTH } from '@/config/repository-config';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Invalid repository ID' }, { status: 400 });
    }

    const body = await request.json();

    if (body === null || typeof body !== 'object') {
      return NextResponse.json({ error: 'Request body is required' }, { status: 400 });
    }

    const { displayName, visible } = body;

    // Issue #690: At least one updatable field must be present.
    if (displayName === undefined && visible === undefined) {
      return NextResponse.json(
        { error: 'displayName or visible is required' },
        { status: 400 }
      );
    }

    // displayName must be a string or undefined/null
    if (displayName !== undefined && displayName !== null && typeof displayName !== 'string') {
      return NextResponse.json({ error: 'displayName must be a string' }, { status: 400 });
    }

    // Validate length
    if (typeof displayName === 'string' && displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      return NextResponse.json(
        { error: `displayName must be ${MAX_DISPLAY_NAME_LENGTH} characters or less` },
        { status: 400 }
      );
    }

    // Issue #690: visible must be boolean when supplied.
    if (visible !== undefined && typeof visible !== 'boolean') {
      return NextResponse.json({ error: 'visible must be a boolean' }, { status: 400 });
    }

    const db = getDbInstance();

    const existing = getRepositoryById(db, id);
    if (!existing) {
      return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
    }

    // Build updates: empty string or null clears display_name
    const updates: { displayName?: string; visible?: boolean } = {};
    if (displayName !== undefined) {
      updates.displayName = typeof displayName === 'string' ? displayName.trim() : '';
    }
    if (visible !== undefined) {
      updates.visible = visible;
    }

    updateRepository(db, id, updates);

    const updated = getRepositoryById(db, id)!;

    return NextResponse.json({
      success: true,
      repository: {
        id: updated.id,
        name: updated.name,
        displayName: updated.displayName ?? null,
        path: updated.path,
        enabled: updated.enabled,
        // Issue #690: Surface visible to clients so the UI can sync state.
        visible: updated.visible,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
