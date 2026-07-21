/**
 * Service-owned state layout for Skill operations (Issue #1234)
 *
 * Two staging areas exist and must not be confused:
 * - *Package* staging is service-owned. It lives under the CommandMate config
 *   root (0700), never inside a repository, and is never visible to an Agent.
 * - *Install commit* staging is worktree-local, because the commit point is an
 *   atomic rename and rename only works within one filesystem. It uses the
 *   reserved `.agents/skills/.commandmate-staging/` namespace, which callers
 *   must exclude from Skill discovery, installed status and diff previews.
 *
 * Every file written here is 0600 under a 0700 directory and is written through
 * a temp+rename so a crash can never leave a half-parsed record behind.
 *
 * @module lib/skills/operation-store
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import {
  SKILL_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIXES,
  SKILL_STAGING_DIRNAME,
} from '@/lib/skills/constants';
import { ensureConfigDir } from '@/cli/utils/install-context';

/** Directory under the config root that holds all Skill operation state. */
export const SKILL_STATE_DIRNAME = 'skills';

/** Sub-directory holding one lock file per (worktree, skill) pair. */
export const SKILL_LOCK_DIRNAME = 'locks';

/** Sub-directory holding one journal file per operation. */
export const SKILL_JOURNAL_DIRNAME = 'journal';

/** Sub-directory holding service-owned package staging (downloads, extraction). */
export const SKILL_PACKAGE_STAGING_DIRNAME = 'package-staging';

/** Owner-only directory mode. */
export const SKILL_STATE_DIR_MODE = 0o700;

/** Owner-only file mode. */
export const SKILL_STATE_FILE_MODE = 0o600;

/** Maximum length of any redacted string persisted to a journal or audit row. */
export const SKILL_REDACTED_TEXT_MAX_LENGTH = 500;

/** Options accepted by every module that reads or writes operation state. */
export interface SkillOperationStoreOptions {
  /** Override the service-owned state root. Tests pass a temp directory. */
  root?: string;
}

/**
 * Root of all Skill operation state, inside the CommandMate config directory.
 * Never inside a repository, so nothing here is reachable as Skill payload.
 */
export function getSkillStateRoot(options: SkillOperationStoreOptions = {}): string {
  return options.root ?? join(ensureConfigDir(), SKILL_STATE_DIRNAME);
}

/** Create (if needed) and return a 0700 directory under the state root. */
export function ensureSkillStateDir(
  segment: string,
  options: SkillOperationStoreOptions = {}
): string {
  const dir = join(getSkillStateRoot(options), segment);
  mkdirSync(dir, { recursive: true, mode: SKILL_STATE_DIR_MODE });
  // mkdir's mode is masked by umask, so a 0022 umask would leave 0755 behind.
  chmodSync(dir, SKILL_STATE_DIR_MODE);
  return dir;
}

/** Service-owned package staging directory (downloads and extraction). */
export function getSkillPackageStagingRoot(options: SkillOperationStoreOptions = {}): string {
  return ensureSkillStateDir(SKILL_PACKAGE_STAGING_DIRNAME, options);
}

/**
 * Worktree-local install commit staging root, under one install root prefix.
 *
 * Each install root gets its own staging namespace so the atomic rename stays on
 * the same filesystem as *that* root's destination (#1460). The default is the
 * primary `.agents/skills` root, preserving the single-root callers.
 *
 * @param worktreePath - Absolute path of a *server-resolved* worktree. Callers
 *   must never pass a client-supplied path.
 * @param rootPrefix - Install root prefix; defaults to the primary root.
 */
export function getSkillInstallStagingRoot(
  worktreePath: string,
  rootPrefix: string = SKILL_INSTALL_ROOT_PREFIX
): string {
  return join(worktreePath, rootPrefix, SKILL_STAGING_DIRNAME);
}

/** Repository-relative form of the reserved install staging root (primary). */
export const SKILL_INSTALL_STAGING_REL_PATH = `${SKILL_INSTALL_ROOT_PREFIX}/${SKILL_STAGING_DIRNAME}`;

/** Repository-relative staging namespace under every install root prefix (#1460). */
export const SKILL_INSTALL_STAGING_REL_PATHS: readonly string[] = SKILL_INSTALL_ROOT_PREFIXES.map(
  (prefix) => `${prefix}/${SKILL_STAGING_DIRNAME}`
);

/**
 * Whether a repository-relative path belongs to a reserved install staging
 * namespace under any install root. Slash-command loading, installed status and
 * diff previews must treat a true result as "not payload".
 */
export function isSkillInstallStagingPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return SKILL_INSTALL_STAGING_REL_PATHS.some(
    (rel) => normalized === rel || normalized.startsWith(`${rel}/`)
  );
}

/**
 * Strip secrets and machine identity from free text before it is persisted.
 *
 * Journals and audit rows are read by support flows and may be exported, so a
 * signed URL query, a bearer token or a home directory path must not survive
 * into them. Structured fields (digests, refs) are stored in their own columns
 * and never routed through here.
 */
export function redactSkillOperationText(value: string): string {
  let text = value;

  // URLs first: keep origin+path (useful for diagnosis), drop userinfo, query
  // and fragment (where signed-URL credentials live).
  text = text.replace(/https?:\/\/\S+/gi, (match) => {
    try {
      const url = new URL(match);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return '[url]';
    }
  });

  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]');
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '[redacted]');
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, '[redacted]');
  text = text.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted]');
  text = text.replace(
    /\b(token|secret|password|api[_-]?key|authorization)\s*[=:]\s*\S+/gi,
    '$1=[redacted]'
  );

  // Machine-absolute paths. The leading boundary keeps this from re-matching the
  // pathname of a URL already normalized above.
  text = text.replace(/(^|[\s"'(\[<])(\/[A-Za-z0-9._@+-]+){2,}\/?/g, '$1[path]');
  text = text.replace(/(^|[\s"'(\[<])[A-Za-z]:\\[^\s"'\])>]*/g, '$1[path]');

  return text.length > SKILL_REDACTED_TEXT_MAX_LENGTH
    ? `${text.slice(0, SKILL_REDACTED_TEXT_MAX_LENGTH)}…`
    : text;
}

/** Write JSON atomically as a 0600 file. */
export function writeSkillStateFile(filePath: string, payload: unknown): void {
  const tempPath = `${filePath}.tmp-${randomBytes(8).toString('hex')}`;
  writeFileSync(tempPath, JSON.stringify(payload), { mode: SKILL_STATE_FILE_MODE });
  chmodSync(tempPath, SKILL_STATE_FILE_MODE);
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best effort: the temp file is namespaced and reconciliation ignores it.
    }
    throw error;
  }
}

/** Read and parse a state file. Returns null when absent or malformed. */
export function readSkillStateFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}
