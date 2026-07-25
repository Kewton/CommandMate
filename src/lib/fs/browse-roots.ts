/**
 * Allowed filesystem roots for directory browsing and repository registration.
 *
 * Issue #1517: `GET /api/fs/browse`, `POST /api/repositories/scan` and
 * `POST /api/repositories/validate-path` must agree on exactly which paths are
 * reachable. Three independent checks drift, and the drift is user-visible as
 * "the picker let me choose this folder but registration returns 400", so every
 * caller resolves through `resolveAllowedPath()` here.
 */

import path from 'path';
import { existsSync } from 'fs';
import { getEnv } from '@/lib/env';
import {
  validateWorktreePath,
  resolveAndValidateRealPath,
} from '@/lib/security/path-validator';
import { createLogger } from '@/lib/logger';

const logger = createLogger('fs/browse-roots');

/** Roots already warned about, so the warning does not repeat per request. */
const warnedRoots = new Set<string>();

/** Maximum directory entries returned for a single browse request. */
export const BROWSE_ENTRY_LIMIT = 500;

/** Why a path is not reachable through the allowed roots. */
export type PathRejectionReason =
  /** Empty, non-string, or null-byte-bearing input. */
  | 'invalid'
  /** Lexically outside every allowed root. */
  | 'outside-roots'
  /** Inside a root lexically, but its real path escapes via a symlink. */
  | 'symlink-escape';

export interface AllowedPathSuccess {
  ok: true;
  /** Absolute, decoded, normalized path. */
  resolvedPath: string;
  /** The allowed root that admitted this path. */
  root: string;
  roots: string[];
}

export interface AllowedPathFailure {
  ok: false;
  reason: PathRejectionReason;
  roots: string[];
}

export type AllowedPathResult = AllowedPathSuccess | AllowedPathFailure;

/**
 * The set of roots a client may browse and register from:
 * `CM_BROWSE_ROOTS` (comma-separated) united with `CM_ROOT_DIR`.
 *
 * `CM_ROOT_DIR` is always first so a relative input still resolves against the
 * managed scope, which is the behaviour `scan` had before Issue #1517.
 */
export function getAllowedBrowseRoots(): string[] {
  const { CM_ROOT_DIR } = getEnv();

  const extraRoots = (process.env.CM_BROWSE_ROOTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.includes('\x00'))
    .map((entry) => path.resolve(entry));

  const roots = [path.resolve(CM_ROOT_DIR), ...extraRoots];

  for (const root of roots) {
    if (root === path.parse(root).root && !warnedRoots.has(root)) {
      warnedRoots.add(root);
      logger.warn('browse-root:filesystem-root', {
        detail: 'An allowed browse root spans the whole filesystem; narrow CM_BROWSE_ROOTS.',
      });
    }
  }

  return Array.from(new Set(roots));
}

/**
 * Resolve a client-supplied path against the allowed roots.
 *
 * Layered exactly like the rest of the codebase: lexical containment via
 * `validateWorktreePath` (which also decodes URL escaping and rejects null
 * bytes), then `resolveAndValidateRealPath` so a symlink cannot hop out of the
 * root it appeared to be in.
 */
export function resolveAllowedPath(targetPath: unknown): AllowedPathResult {
  const roots = getAllowedBrowseRoots();

  if (
    typeof targetPath !== 'string'
    || targetPath.trim() === ''
    || targetPath.includes('\x00')
  ) {
    return { ok: false, reason: 'invalid', roots };
  }

  let lexicallyInsideSomeRoot = false;

  for (const root of roots) {
    // A root that does not exist cannot contain anything, and feeding it to
    // realpath would misreport "outside roots" as a symlink escape.
    if (!existsSync(root)) continue;

    let resolvedPath: string;
    try {
      resolvedPath = validateWorktreePath(targetPath, root);
    } catch {
      continue;
    }

    lexicallyInsideSomeRoot = true;

    if (resolveAndValidateRealPath(resolvedPath, root)) {
      return { ok: true, resolvedPath, root, roots };
    }
  }

  return {
    ok: false,
    reason: lexicallyInsideSomeRoot ? 'symlink-escape' : 'outside-roots',
    roots,
  };
}

/** Render the allowed roots for an error message shown to the operator. */
export function formatAllowedRoots(roots: string[]): string {
  return roots.join(', ');
}
