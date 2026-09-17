/**
 * GET /api/app/release-notes?from=X.Y.Z&to=X.Y.Z
 * Issue #2646: bundled release notes for the "What's new" dialog.
 *
 * Returns the notes of every version v with `from < v <= to`, newest first
 * (at most 20). Authentication is middleware's job; this path must not be
 * added to AUTH_EXCLUDED_PATHS.
 *
 * @module api/app/release-notes
 */

import { NextRequest, NextResponse } from 'next/server';
import { compareVersions, isComparableVersion } from '@/cli/utils/semver';
import { readReleaseNotesBetween } from '@/lib/app-update/release-notes';

// Reads the package's files at request time; never prerender (cf. update-check [FIX-270]).
export const dynamic = 'force-dynamic';

/** Longer query values are rejected before any comparison */
const MAX_VERSION_PARAM_LENGTH = 32;

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

function isVersionParam(value: string | null): value is string {
  return value !== null && value.length <= MAX_VERSION_PARAM_LENGTH && isComparableVersion(value);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const from = request.nextUrl.searchParams.get('from');
  const to = request.nextUrl.searchParams.get('to');

  if (!isVersionParam(from) || !isVersionParam(to)) {
    return NextResponse.json(
      { error: 'from and to must be X.Y.Z versions' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }
  if (compareVersions(from, to) >= 0) {
    return NextResponse.json({ notes: [] }, { headers: NO_STORE_HEADERS });
  }

  try {
    const notes = await readReleaseNotesBetween(from, to);
    return NextResponse.json({ notes }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json(
      { error: 'Failed to read release notes' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
