/**
 * Full package/manifest reconciliation and safe materialization (Issue #1230)
 *
 * Second half of the inspect-then-materialize boundary. `package-reader` decides
 * whether the bytes are an archive we are willing to look at; this module
 * decides whether the archive is *the package the manifest describes*, and only
 * then writes it into an isolated staging directory.
 *
 * Reconciliation is exact in both directions. Every regular payload file except
 * the manifest itself must be declared, every declaration must be present, and
 * each one must agree on size, digest, kind, executable bit and script status.
 * A partial match is a rejection: "mostly the manifest the user reviewed" is
 * how an undeclared script gets installed.
 *
 * Nothing in the package is executed, at any point, by any code path here.
 *
 * @module lib/skills/package-validator
 */

import { randomBytes } from 'crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'fs';
import path from 'path';
import { isSystemDirectory } from '@/config/system-directories';
import {
  REQUIRED_PACKAGE_ENTRIES,
  SKILL_MANIFEST_FILENAME,
  SKILL_MD_FILENAME,
  computeSkillRisk,
  resolveEffectiveSkillRisk,
  validateManifestFileSet,
  validateSkillIdentityConsistency,
  validateSkillManifest,
} from '@/lib/skills';
import { computeSha256Hex, digestMatches } from '@/lib/skills/integrity';
import {
  SkillPackageError,
  SkillPackageErrorCode,
  encodeEntryPathForError,
  readSkillPackage,
  type SkillPackageErrorDetail,
  type SkillPackageErrorCodeType,
  type SkillPackageFileEntry,
  type SkillPackageTable,
} from '@/lib/skills/package-reader';
import { isSkillYamlError, parseSkillFrontmatter, parseSkillYaml } from '@/lib/skills/safe-yaml';
import type {
  SkillFileKind,
  SkillInstalledFile,
  SkillManifest,
  SkillPackageInspection,
  SkillRiskLevel,
} from '@/types/skills';

// =============================================================================
// Staging policy
// =============================================================================

/** Staging directories are private to the service account. */
export const SKILL_STAGING_DIR_MODE = 0o700;

/** Non-executable payload files land read/write for the owner only. */
export const SKILL_STAGED_FILE_MODE = 0o600;

/** Declared executables additionally get the owner execute bit. Nothing else. */
export const SKILL_STAGED_EXECUTABLE_MODE = 0o700;

/** Prefix of a staging directory, used to recognize orphans after a restart. */
export const SKILL_STAGING_ENTRY_PREFIX = 'pkg-';

const STAGING_ENTRY_PATTERN = /^pkg-[0-9a-f]{32}$/;

/** `O_NOFOLLOW` is POSIX-only; on platforms without it the flag is a no-op. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

// =============================================================================
// Script classification
// =============================================================================

/**
 * Extensions treated as scripts regardless of content.
 *
 * Classification is deliberately over-broad: a file wrongly called a script
 * only forces the publisher to declare it, while a missed one would install an
 * interpreted payload the user never saw listed.
 */
export const SKILL_SCRIPT_EXTENSIONS: readonly string[] = [
  '.bash',
  '.bat',
  '.cjs',
  '.cmd',
  '.fish',
  '.js',
  '.lua',
  '.mjs',
  '.php',
  '.pl',
  '.ps1',
  '.py',
  '.rb',
  '.sh',
  '.ts',
  '.zsh',
];

const INSTRUCTION_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.rst', '.txt'];

function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** Whether a payload file is an interpreted script, by extension or shebang. */
export function isSkillScriptPayload(filePath: string, bytes: Uint8Array): boolean {
  if (SKILL_SCRIPT_EXTENSIONS.includes(extensionOf(filePath))) return true;
  return bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21;
}

/** Role CommandMate derives for a payload file, independent of the declaration. */
export function deriveSkillFileKind(filePath: string, bytes: Uint8Array): SkillFileKind {
  if (filePath === SKILL_MD_FILENAME) return 'skill_md';
  if (isSkillScriptPayload(filePath, bytes)) return 'script';
  return INSTRUCTION_EXTENSIONS.includes(extensionOf(filePath)) ? 'instruction' : 'asset';
}

// =============================================================================
// Types
// =============================================================================

/**
 * A package that matched its manifest exactly.
 *
 * Immutable and path-free: consumers address files by their package-relative
 * path, and {@link SkillPackageSnapshot.readFile} hands back a copy, so the
 * bytes a plan was computed from cannot change under it (#1233).
 */
export interface SkillPackageSnapshot {
  readonly skillId: string;
  readonly version: string;
  readonly manifest: SkillManifest;
  /** Every regular payload file, manifest and SKILL.md included, sorted by path. */
  readonly files: readonly SkillInstalledFile[];
  readonly directories: readonly string[];
  readonly inspection: SkillPackageInspection;
  readonly declaredRisk: SkillRiskLevel;
  readonly computedRisk: SkillRiskLevel;
  readonly effectiveRisk: SkillRiskLevel;
  /** Copy of one file's bytes. Throws for a path the package does not contain. */
  readFile(filePath: string): Uint8Array;
}

/** Where and under what supervision a package may be written. */
export interface SkillMaterializeOptions {
  /** Service-owned directory the isolated staging directory is created under. */
  stagingRoot: string;
  signal?: AbortSignal;
}

/** A package written to an isolated staging directory. */
export interface SkillStagedPackage {
  readonly skillId: string;
  readonly version: string;
  /**
   * Absolute path of the staging directory.
   *
   * Identifies the machine's data root: for the installer only, never for an
   * API response, a log line or an error message.
   *
   * @internal
   */
  readonly stagingDir: string;
  /** What landed, in the same order and shape a receipt will record. */
  readonly inventory: readonly SkillInstalledFile[];
  /** Remove the staging directory. Safe to call more than once. */
  dispose(): void;
}

// =============================================================================
// Helpers
// =============================================================================

function fail(code: SkillPackageErrorCodeType, detail?: SkillPackageErrorDetail): never {
  throw new SkillPackageError(code, detail);
}

function findFile(
  table: SkillPackageTable,
  filePath: string
): SkillPackageFileEntry | undefined {
  return table.files.find((file) => file.path === filePath);
}

// =============================================================================
// Manifest reconciliation
// =============================================================================

function readManifest(table: SkillPackageTable): SkillManifest {
  const manifestEntry = findFile(table, SKILL_MANIFEST_FILENAME);
  if (!manifestEntry) fail(SkillPackageErrorCode.MANIFEST_MISSING, { reason: 'absent' });

  for (const file of table.files) {
    if (file.path !== SKILL_MANIFEST_FILENAME && file.path.endsWith(`/${SKILL_MANIFEST_FILENAME}`)) {
      fail(SkillPackageErrorCode.LAYOUT_INVALID, {
        reason: 'nested-manifest',
        entry: encodeEntryPathForError(file.path),
      });
    }
  }

  let parsed: unknown;
  try {
    parsed = parseSkillYaml(manifestEntry.bytes);
  } catch (error) {
    if (isSkillYamlError(error)) {
      fail(SkillPackageErrorCode.MANIFEST_INVALID, { reason: error.code });
    }
    throw error;
  }

  const result = validateSkillManifest(parsed);
  if (!result.ok) {
    const first = result.errors[0];
    fail(SkillPackageErrorCode.MANIFEST_INVALID, { reason: first.code, field: first.path });
  }
  return result.value;
}

function assertRequiredEntries(table: SkillPackageTable): void {
  for (const required of REQUIRED_PACKAGE_ENTRIES) {
    if (!findFile(table, required)) {
      fail(SkillPackageErrorCode.LAYOUT_INVALID, {
        reason: 'missing-required-entry',
        entry: required,
      });
    }
  }
}

function assertSkillMdConsistency(table: SkillPackageTable, manifest: SkillManifest): void {
  const skillMd = findFile(table, SKILL_MD_FILENAME);
  if (!skillMd) fail(SkillPackageErrorCode.SKILL_MD_INVALID, { reason: 'absent' });

  let frontmatter: unknown;
  try {
    frontmatter = parseSkillFrontmatter(Buffer.from(skillMd.bytes).toString('utf8'));
  } catch (error) {
    if (isSkillYamlError(error)) {
      fail(SkillPackageErrorCode.SKILL_MD_INVALID, { reason: error.code });
    }
    throw error;
  }
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    fail(SkillPackageErrorCode.SKILL_MD_INVALID, { reason: 'frontmatter-missing' });
  }

  const name = (frontmatter as Record<string, unknown>)['name'];
  if (typeof name !== 'string') {
    fail(SkillPackageErrorCode.SKILL_MD_INVALID, { reason: 'frontmatter-name-missing' });
  }

  const consistency = validateSkillIdentityConsistency({
    directoryName: manifest.id,
    skillMdName: name,
    manifestId: manifest.id,
    manifestName: manifest.name,
  });
  if (!consistency.ok) {
    fail(SkillPackageErrorCode.SKILL_MD_INVALID, { reason: consistency.errors[0].code });
  }
}

/**
 * Both directions of the file-set comparison.
 *
 * Self-declaration and duplicate declarations are already refused by
 * `validateSkillManifest` (#1228); what is left for this step is the package
 * the manifest is being compared against.
 */
function assertFileSetMatches(table: SkillPackageTable, manifest: SkillManifest): void {
  const result = validateManifestFileSet(
    manifest,
    table.files.map((file) => file.path)
  );
  if (!result.ok) {
    const first = result.errors[0];
    fail(SkillPackageErrorCode.MANIFEST_MISMATCH, {
      reason: first.message,
      entry: encodeEntryPathForError(String(first.detail?.['path'] ?? '')),
    });
  }
}

/** Cross-check one payload file against its declaration on every axis. */
function assertDeclarationMatches(entry: SkillPackageFileEntry, manifest: SkillManifest): void {
  const declared = manifest.files.find((file) => file.path === entry.path);
  if (!declared) {
    fail(SkillPackageErrorCode.MANIFEST_MISMATCH, {
      reason: 'undeclared-file',
      entry: encodeEntryPathForError(entry.path),
    });
  }
  const detail = { entry: encodeEntryPathForError(entry.path) };

  if (declared.size !== entry.size) fail(SkillPackageErrorCode.SIZE_MISMATCH, detail);
  if (!digestMatches(declared.sha256, entry.sha256)) {
    fail(SkillPackageErrorCode.DIGEST_MISMATCH, detail);
  }

  const derivedKind = deriveSkillFileKind(entry.path, entry.bytes);
  const isScript = isSkillScriptPayload(entry.path, entry.bytes);

  if (isScript && (!declared.script || declared.kind !== 'script')) {
    fail(SkillPackageErrorCode.UNDECLARED_SCRIPT, detail);
  }
  if (declared.kind === 'script' && !declared.script) {
    fail(SkillPackageErrorCode.MANIFEST_MISMATCH, { ...detail, reason: 'kind-script-not-declared' });
  }
  if ((derivedKind === 'skill_md') !== (declared.kind === 'skill_md')) {
    fail(SkillPackageErrorCode.MANIFEST_MISMATCH, { ...detail, reason: 'kind-mismatch' });
  }
  if (entry.executable && !declared.executable) {
    fail(SkillPackageErrorCode.UNDECLARED_EXECUTABLE, detail);
  }
  if (!entry.executable && declared.executable) {
    fail(SkillPackageErrorCode.MANIFEST_MISMATCH, { ...detail, reason: 'executable-not-present' });
  }
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Reconcile a parsed package with its manifest and the Catalog coordinates.
 *
 * @param table Entry table from `readSkillPackage`
 * @param options Coordinates the Catalog published this version under
 * @returns An immutable snapshot, or throws before any consumer can see it
 * @throws SkillPackageError for every rejection
 */
export function validateSkillPackage(
  table: SkillPackageTable,
  options: { skillId: string; version: string }
): SkillPackageSnapshot {
  assertRequiredEntries(table);
  const manifest = readManifest(table);

  if (manifest.id !== options.skillId) {
    fail(SkillPackageErrorCode.MANIFEST_MISMATCH, { reason: 'id' });
  }
  if (manifest.version !== options.version) {
    fail(SkillPackageErrorCode.MANIFEST_MISMATCH, { reason: 'version' });
  }

  assertSkillMdConsistency(table, manifest);
  assertFileSetMatches(table, manifest);

  for (const entry of table.files) {
    if (entry.path === SKILL_MANIFEST_FILENAME) continue;
    assertDeclarationMatches(entry, manifest);
  }

  const executablePaths = manifest.files.filter((f) => f.executable).map((f) => f.path).sort();
  const scriptPaths = manifest.files.filter((f) => f.script).map((f) => f.path).sort();
  const inspection: SkillPackageInspection = {
    executable_paths: executablePaths,
    script_paths: scriptPaths,
    network_hosts: [...manifest.requirements.network_hosts],
    declared_permissions: [...manifest.declared_permissions],
  };
  const computedRisk = computeSkillRisk(inspection);

  const byPath = new Map(table.files.map((file) => [file.path, file.bytes]));
  const files: SkillInstalledFile[] = table.files
    .map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      executable: file.executable,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return Object.freeze({
    skillId: options.skillId,
    version: options.version,
    manifest,
    files: Object.freeze(files),
    directories: Object.freeze([...table.directories].sort()),
    inspection: Object.freeze(inspection),
    declaredRisk: manifest.declared_risk,
    computedRisk,
    effectiveRisk: resolveEffectiveSkillRisk(manifest.declared_risk, computedRisk),
    readFile(filePath: string): Uint8Array {
      const bytes = byPath.get(filePath);
      if (!bytes) {
        fail(SkillPackageErrorCode.MANIFEST_MISMATCH, {
          reason: 'unknown-file',
          entry: encodeEntryPathForError(filePath),
        });
      }
      return new Uint8Array(bytes);
    },
  });
}

/**
 * Read and reconcile an artifact in one step.
 *
 * The two halves are separately testable but must always run together: a table
 * that was read but not reconciled is not a package, and nothing downstream
 * should be able to obtain one.
 *
 * @throws SkillPackageError for every rejection
 */
export function inspectSkillPackage(
  artifact: Uint8Array,
  options: { skillId: string; version: string }
): SkillPackageSnapshot {
  return validateSkillPackage(readSkillPackage(artifact, options), options);
}

// =============================================================================
// Materialization
// =============================================================================

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail(SkillPackageErrorCode.ABORTED);
}

/** Create a directory that must not already exist and must not be a symlink. */
function createDirectory(target: string): void {
  try {
    mkdirSync(target, { mode: SKILL_STAGING_DIR_MODE });
  } catch {
    fail(SkillPackageErrorCode.STAGING_IO, { reason: 'mkdir' });
  }
  const stats = lstatSync(target);
  if (!stats.isDirectory()) fail(SkillPackageErrorCode.STAGING_IO, { reason: 'not-a-directory' });
}

/**
 * Write one payload file.
 *
 * `O_CREAT|O_EXCL|O_NOFOLLOW` means the write either creates the file itself or
 * fails: a symlink or an existing file planted between the directory scan and
 * this call cannot be written through. The digest is re-read afterwards, so a
 * file that changed underneath us never reaches the inventory.
 */
function writePayloadFile(
  target: string,
  snapshot: SkillPackageSnapshot,
  file: SkillInstalledFile
): void {
  const bytes = snapshot.readFile(file.path);
  const declared = snapshot.manifest.files.find((entry) => entry.path === file.path);
  const mode = declared?.executable ? SKILL_STAGED_EXECUTABLE_MODE : SKILL_STAGED_FILE_MODE;

  let fd: number;
  try {
    fd = openSync(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      mode
    );
  } catch {
    fail(SkillPackageErrorCode.STAGING_IO, { reason: 'open' });
  }
  try {
    let written = 0;
    while (written < bytes.byteLength) {
      written += writeSync(fd, bytes, written, bytes.byteLength - written);
    }
  } catch {
    closeSync(fd);
    fail(SkillPackageErrorCode.STAGING_IO, { reason: 'write' });
  }
  closeSync(fd);

  const stats = lstatSync(target);
  if (!stats.isFile() || stats.nlink !== 1 || stats.size !== bytes.byteLength) {
    fail(SkillPackageErrorCode.STAGING_IO, { reason: 'verify-stat' });
  }
  if (!digestMatches(computeSha256Hex(readFileSync(target)), file.sha256)) {
    fail(SkillPackageErrorCode.DIGEST_MISMATCH, { reason: 'staged-readback' });
  }
}

/**
 * Write a validated package into a fresh, private staging directory.
 *
 * Nothing outside the new directory is touched and nothing from the archive
 * (owner, timestamps, mode) is applied: directories and files get fixed modes,
 * and only files the manifest declared executable get an execute bit.
 *
 * On any failure — including an abort — the whole staging directory is removed
 * before the error propagates, so no consumer can ever observe a partial
 * package.
 *
 * @throws SkillPackageError with `STAGING_IO`, `ABORTED` or `DIGEST_MISMATCH`
 */
export function materializeSkillPackage(
  snapshot: SkillPackageSnapshot,
  options: SkillMaterializeOptions
): SkillStagedPackage {
  const root = path.resolve(options.stagingRoot);
  if (isSystemDirectory(root)) fail(SkillPackageErrorCode.STAGING_IO, { reason: 'system-directory' });

  try {
    mkdirSync(root, { recursive: true, mode: SKILL_STAGING_DIR_MODE });
  } catch {
    fail(SkillPackageErrorCode.STAGING_IO, { reason: 'mkdir-root' });
  }

  const stagingDir = path.join(
    root,
    `${SKILL_STAGING_ENTRY_PREFIX}${randomBytes(16).toString('hex')}`
  );
  createDirectory(stagingDir);

  try {
    assertNotAborted(options.signal);

    const directories = new Set<string>(snapshot.directories);
    for (const file of snapshot.files) {
      const parents = file.path.split('/').slice(0, -1);
      let walked = '';
      for (const segment of parents) {
        walked = walked === '' ? segment : `${walked}/${segment}`;
        directories.add(walked);
      }
    }
    for (const directory of [...directories].sort()) {
      createDirectory(path.join(stagingDir, directory));
    }

    for (const file of snapshot.files) {
      assertNotAborted(options.signal);
      writePayloadFile(path.join(stagingDir, file.path), snapshot, file);
    }
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  let disposed = false;
  return {
    skillId: snapshot.skillId,
    version: snapshot.version,
    stagingDir,
    inventory: snapshot.files,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      rmSync(stagingDir, { recursive: true, force: true });
    },
  };
}

/**
 * Remove staging directories left behind by a crashed or killed process.
 *
 * Only entries this module creates are removed, so pointing it at a directory
 * that holds anything else cannot destroy that content.
 *
 * @returns Number of staging directories removed
 */
export function cleanupSkillStagingRoot(stagingRoot: string): number {
  const root = path.resolve(stagingRoot);
  if (isSystemDirectory(root) || !existsSync(root)) return 0;

  let removed = 0;
  for (const entry of readdirSync(root)) {
    if (!STAGING_ENTRY_PATTERN.test(entry)) continue;
    rmSync(path.join(root, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
