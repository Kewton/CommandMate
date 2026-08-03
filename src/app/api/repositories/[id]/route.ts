/**
 * Repository API Route (individual repository)
 * PUT: Update repository display_name, visible and/or enabled (partial update)
 *
 * Issue #642: Repository display name (alias) feature
 * Issue #644: Shared MAX_DISPLAY_NAME_LENGTH constant
 * Issue #690: Add `visible` partial-update for sidebar visibility toggle.
 * Issue #1658: Add `enabled` partial-update — the NON-DESTRUCTIVE way to take a
 *              repository out of the scan set. `DELETE /api/repositories` also
 *              sets `enabled = 0`, but as part of "exclude and purge": it kills
 *              every tmux session under the repository and deletes its worktree
 *              rows along with all their child data. This route deletes nothing
 *              and kills nothing — it writes one column.
 *
 * Validation rules:
 *   - At least one of `displayName`, `visible` or `enabled` must be provided.
 *   - `visible` / `enabled`, when present, must be booleans.
 *   - Updating `visible` does NOT touch `enabled`, and updating `enabled` does
 *     NOT touch `visible` (concept independence, Issue #690).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  getRepositoryById,
  updateRepository,
  setRepositoryEnabled,
  RepositoryDbError,
} from '@/lib/db/db-repository';
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

    const { displayName, visible, enabled } = body;

    // Issue #690/#1658: At least one updatable field must be present.
    if (displayName === undefined && visible === undefined && enabled === undefined) {
      return NextResponse.json(
        { error: 'displayName, visible or enabled is required' },
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

    // Issue #1658: enabled must be boolean when supplied.
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
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

    if (Object.keys(updates).length > 0) {
      updateRepository(db, id, updates);
    }

    // Issue #1658: `enabled` goes through setRepositoryEnabled rather than the
    // generic updateRepository so the SEC-SF-004 ceiling on disabled rows is
    // enforced on this route too, not only on the DELETE path.
    if (enabled !== undefined) {
      try {
        setRepositoryEnabled(db, id, enabled);
      } catch (error) {
        if (error instanceof RepositoryDbError && error.code === 'LIMIT_EXCEEDED') {
          return NextResponse.json({ error: error.message }, { status: 409 });
        }
        throw error;
      }
    }

    const updated = getRepositoryById(db, id)!;

    return NextResponse.json({
      success: true,
      repository: {
        id: updated.id,
        name: updated.name,
        displayName: updated.displayName ?? null,
        path: updated.path,
        // Issue #1658: Surface enabled so the UI can sync the scan toggle.
        enabled: updated.enabled,
        // Issue #690: Surface visible to clients so the UI can sync state.
        visible: updated.visible,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
