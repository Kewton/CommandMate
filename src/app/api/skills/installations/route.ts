/**
 * GET /api/skills/installations — applied Skill state across every worktree (Issue #1248)
 *
 * The dashboard's single read. It walks the receipts on disk and compares them
 * with the index, so what it reports is evidence rather than a database claim —
 * which is what makes a deleted or rebuilt database show up as `unmanaged` here
 * instead of as "nothing installed".
 *
 * Catalog lookup is deliberately non-fatal. `update_available` needs to know the
 * newest offerable version, but an unreachable Catalog must not take the whole
 * screen down: the scan still answers "what is installed and has it drifted",
 * and `catalogAvailable: false` tells the client that update detection is the
 * one column it cannot trust.
 *
 * Every path in the response is repository-relative, matching the install DTO
 * policy (#1231): no machine-absolute path and no artifact URL.
 *
 * @module api/skills/installations
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { getDbInstance } from '@/lib/db/db-instance';
import { getSkillCatalog } from '@/lib/skills/catalog-client';
import { normalizeHostVersion, resolveSkillVersions } from '@/lib/skills/compatibility';
import { getServerVersion } from '@/lib/version-checker';
import { SKILL_API_NO_STORE_HEADERS, skillApiError } from '@/lib/api/skills-api';
import { scanSkillInstallationStatus } from '@/lib/skills/status-scanner';
import type {
  SkillInstallationStatus,
  SkillInstallationStatusEntry,
} from '@/lib/skills/status-scanner';

export const dynamic = 'force-dynamic';

const logger = createLogger('api/skills/installations');

const STATUS_VALUES: readonly SkillInstallationStatus[] = [
  'installed',
  'modified',
  'missing',
  'unmanaged',
  'update_available',
];

/** Applied state of every Skill the server can see. */
export interface SkillInstallationsResponse {
  scannedAt: number;
  /** Worktrees actually read by the scan. */
  worktreeCount: number;
  /** A scan bound stopped the walk, so the list is incomplete. */
  truncated: boolean;
  /** Registered worktrees whose directory is gone. */
  unreadableWorktreeIds: string[];
  /** False when the Catalog was unreachable, making `update_available` unknowable. */
  catalogAvailable: boolean;
  installations: SkillInstallationStatusEntry[];
}

/**
 * Newest offerable version per Skill.
 *
 * The *recommended* version, not the Catalog's `latest`: offering an update to a
 * release this CommandMate cannot run would be a worse answer than offering none.
 */
async function loadLatestVersions(): Promise<ReadonlyMap<string, string> | null> {
  const hostVersion = getServerVersion();
  const result = await getSkillCatalog({ hostVersion });
  if (!result.ok) return null;

  const currentVersion = normalizeHostVersion(hostVersion);
  const latest = new Map<string, string>();
  for (const entry of result.snapshot.catalog.entries) {
    const resolution = resolveSkillVersions(entry, { currentVersion, includePrerelease: false });
    const recommended = resolution.recommended?.version.version;
    if (recommended !== undefined) latest.set(entry.id, recommended);
  }
  return latest;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const worktreeId = url.searchParams.get('worktreeId');
    const skillId = url.searchParams.get('skillId');
    const status = url.searchParams.get('status');
    const refresh = url.searchParams.get('refresh') === 'true';

    if (status !== null && !STATUS_VALUES.includes(status as SkillInstallationStatus)) {
      return skillApiError(
        'SKILL_INSTALLATIONS_INVALID_STATUS',
        `status must be one of: ${STATUS_VALUES.join(', ')}.`,
        400
      );
    }

    const latestVersions = await loadLatestVersions();
    const scan = await scanSkillInstallationStatus(getDbInstance(), {
      latestVersions: latestVersions ?? undefined,
      refresh,
    });

    const installations = scan.entries.filter(
      (entry) =>
        (worktreeId === null || entry.worktreeId === worktreeId) &&
        (skillId === null || entry.skillId === skillId) &&
        (status === null || entry.status === status)
    );

    const body: SkillInstallationsResponse = {
      scannedAt: scan.scannedAt,
      worktreeCount: scan.worktreeCount,
      truncated: scan.truncated,
      unreadableWorktreeIds: scan.unreadableWorktreeIds,
      catalogAvailable: latestVersions !== null,
      installations,
    };
    return NextResponse.json(body, { headers: SKILL_API_NO_STORE_HEADERS });
  } catch (error) {
    logger.error('skill-installations-scan-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return skillApiError(
      'SKILL_INSTALLATIONS_INTERNAL_ERROR',
      'Failed to scan installed Skills.',
      500
    );
  }
}
