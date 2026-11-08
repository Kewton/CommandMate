/**
 * The mem settings as the screen changes them (Issue #4221, design §11). The only
 * way to change a mode: every write must carry the screen's mark
 * (`lib/security/screen-request.ts`), and the CLI has no route that writes them.
 *
 * @module lib/mem/settings-service
 */

import type Database from 'better-sqlite3';
import { getRepositoryById } from '@/lib/db/db-repository';
import {
  deleteMemBranchOverride,
  getMemSettings,
  isValidBranchName,
  MemSettingsConflictError,
  MemSettingsInvalidError,
  saveMemBranchOverride,
  saveMemSettings,
  validateBranchRules,
  validateFeatures,
} from '@/lib/db/mem-db';
import { createLogger } from '@/lib/logger';
import { isScreenRequest } from '@/lib/security/screen-request';
import { isMemMode, type MemBranchOverride } from '@/types/mem';
import { memError, type MemOutcome } from './service';

const logger = createLogger('mem-settings');

type ScreenRequest = Parameters<typeof isScreenRequest>[0];

const ok = (db: Database.Database, repositoryId: string): MemOutcome => ({
  status: 200,
  body: { ok: true, settings: getMemSettings(db, repositoryId) },
});

function guard(db: Database.Database, repositoryId: string, request: ScreenRequest | null): MemOutcome | null {
  if (request !== null && !isScreenRequest(request)) return memError('screen_only');
  if (!getRepositoryById(db, repositoryId)) return memError('not_found');
  return null;
}

function failure(error: unknown, db: Database.Database, repositoryId: string): MemOutcome {
  if (error instanceof MemSettingsConflictError) {
    return {
      status: 409,
      body: { ...(memError('version_conflict').body as object), currentVersion: error.currentVersion, settings: getMemSettings(db, repositoryId) },
    };
  }
  if (error instanceof MemSettingsInvalidError) return memError('invalid_request', { field: error.field });
  throw error;
}

const versionOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

export function readMemSettings(db: Database.Database, repositoryId: string): MemOutcome {
  const refused = guard(db, repositoryId, null);
  return refused ?? ok(db, repositoryId);
}

/** `PUT …/mem-settings` — `{ version, features, rules }`. */
export function writeMemSettings(
  db: Database.Database,
  repositoryId: string,
  request: ScreenRequest,
  body: Record<string, unknown>
): MemOutcome {
  const refused = guard(db, repositoryId, request);
  if (refused) return refused;
  const version = versionOf(body.version);
  if (version === null) return memError('version_required', { field: 'version' });
  try {
    saveMemSettings(db, repositoryId, {
      version,
      features: validateFeatures(body.features),
      rules: validateBranchRules(body.rules),
    });
  } catch (error) {
    return failure(error, db, repositoryId);
  }
  logger.info('mem-settings-updated', { repositoryId });
  return ok(db, repositoryId);
}

const optionalBool = (value: unknown): boolean | null | undefined =>
  value === null || value === undefined ? null : typeof value === 'boolean' ? value : undefined;

/** `PUT …/mem-settings/branches` — `{ version, branch, mode, injectOnStart?, promptOnEvents?, popup? }`. */
export function writeMemBranchOverride(
  db: Database.Database,
  repositoryId: string,
  request: ScreenRequest,
  body: Record<string, unknown>
): MemOutcome {
  const refused = guard(db, repositoryId, request);
  if (refused) return refused;
  const version = versionOf(body.version);
  if (version === null) return memError('version_required', { field: 'version' });
  if (!isValidBranchName(body.branch)) return memError('invalid_request', { field: 'branch' });
  if (body.mode !== null && body.mode !== undefined && !isMemMode(body.mode)) return memError('invalid_request', { field: 'mode' });
  const switches = [optionalBool(body.injectOnStart), optionalBool(body.promptOnEvents), optionalBool(body.popup)];
  if (switches.some((value) => value === undefined)) return memError('invalid_request', { field: 'features' });
  const override: MemBranchOverride = {
    branch: body.branch,
    mode: isMemMode(body.mode) ? body.mode : null,
    injectOnStart: switches[0] as boolean | null,
    promptOnEvents: switches[1] as boolean | null,
    popup: switches[2] as boolean | null,
  };
  try {
    saveMemBranchOverride(db, repositoryId, version, override);
  } catch (error) {
    return failure(error, db, repositoryId);
  }
  logger.info('mem-branch-override-updated', { repositoryId, branch: override.branch });
  return ok(db, repositoryId);
}

/** `DELETE …/mem-settings/branches?branch=<name>&version=<n>`. */
export function removeMemBranchOverride(
  db: Database.Database,
  repositoryId: string,
  request: ScreenRequest,
  branch: string | null,
  versionText: string | null
): MemOutcome {
  const refused = guard(db, repositoryId, request);
  if (refused) return refused;
  const version = versionText !== null && /^[0-9]+$/.test(versionText) ? Number(versionText) : null;
  if (version === null) return memError('version_required', { field: 'version' });
  if (!isValidBranchName(branch)) return memError('invalid_request', { field: 'branch' });
  try {
    deleteMemBranchOverride(db, repositoryId, version, branch);
  } catch (error) {
    return failure(error, db, repositoryId);
  }
  return ok(db, repositoryId);
}
