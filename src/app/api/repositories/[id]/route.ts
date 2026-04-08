/**
 * Repository API Route (individual repository)
 * PUT: Update repository display_name
 *
 * Issue #642: Repository display name (alias) feature
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getRepositoryById, updateRepository } from '@/lib/db/db-repository';

/** Maximum length for display_name */
const MAX_DISPLAY_NAME_LENGTH = 100;

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

    const { displayName } = body;

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

    const db = getDbInstance();

    const existing = getRepositoryById(db, id);
    if (!existing) {
      return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
    }

    // Build updates: empty string or null clears display_name
    const updates: { displayName?: string } = {};
    if (displayName !== undefined) {
      updates.displayName = typeof displayName === 'string' ? displayName.trim() : '';
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
      },
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
