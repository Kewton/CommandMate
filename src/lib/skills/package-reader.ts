/**
 * Strict tar.gz table reader for Skill packages (Issue #1230)
 *
 * Reads a verified artifact snapshot (#1229) into an in-memory entry table.
 * Nothing is written to disk here and no archive library is used: a
 * general-purpose extractor decides for itself what a symlink, a hardlink or a
 * `..` component means, and those decisions are exactly the ones that have to
 * be ours.
 *
 * The reader parses *every* entry before returning, so a package is judged as a
 * whole. One forbidden entry rejects the package rather than being skipped,
 * which is what stops a partially-trusted payload from reaching a consumer.
 *
 * Only `ustar` regular files and directories are accepted. Symlinks, hardlinks,
 * devices, FIFOs, sockets, sparse/contiguous files and pax/GNU extension
 * records are refused by type, before their content is looked at. Ownership,
 * timestamps and permission metadata are read only to *reject* setuid/setgid/
 * sticky entries; nothing from the archive is ever applied to the filesystem.
 *
 * @module lib/skills/package-reader
 */

import { gunzipSync } from 'zlib';
import {
  SKILL_FILE_MAX_SIZE,
  SKILL_FILES_MAX_COUNT,
  SKILL_MANIFEST_FILENAME,
  foldSkillIdForCollision,
  validateSkillPayloadPath,
} from '@/lib/skills';
import { computeSha256Hex } from '@/lib/skills/integrity';

// =============================================================================
// Limits
// =============================================================================

/** Fixed tar block size. */
export const TAR_BLOCK_SIZE = 512;

/** Hard cap on the decompressed archive, independent of the compressed size. */
export const SKILL_PACKAGE_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/** Maximum decompressed-to-compressed ratio tolerated above the floor below. */
export const SKILL_PACKAGE_MAX_COMPRESSION_RATIO = 200;

/**
 * Ratio checking starts here.
 *
 * Tar pads every entry to 512 bytes and those pad bytes are zeros, so a small
 * legitimate package compresses at a ratio a bomb would also show. Below this
 * size the absolute caps are the meaningful guard.
 */
export const SKILL_PACKAGE_RATIO_FLOOR_BYTES = 1024 * 1024;

/** Maximum number of archive entries, directories included. */
export const SKILL_PACKAGE_MAX_ENTRIES = 1000;

// =============================================================================
// Error vocabulary
// =============================================================================

/**
 * Stable reason codes for a rejected package.
 *
 * Shared with `package-validator` so a caller sees one vocabulary from
 * decompression through materialization.
 */
export const SkillPackageErrorCode = {
  /** Bytes are not a readable gzip/ustar stream. */
  ARCHIVE_FORMAT: 'SKILL_PACKAGE_ARCHIVE_FORMAT',
  /** Archive ends in the middle of an entry. */
  ARCHIVE_TRUNCATED: 'SKILL_PACKAGE_ARCHIVE_TRUNCATED',
  /** Entry is not a regular file or a directory. */
  ENTRY_TYPE_FORBIDDEN: 'SKILL_PACKAGE_ENTRY_TYPE_FORBIDDEN',
  /** Entry path escapes the package root or is otherwise unsafe. */
  ENTRY_PATH_UNSAFE: 'SKILL_PACKAGE_ENTRY_PATH_UNSAFE',
  /** The same path appears twice. */
  ENTRY_DUPLICATE: 'SKILL_PACKAGE_ENTRY_DUPLICATE',
  /** Two paths differ only by case or Unicode form. */
  ENTRY_COLLISION: 'SKILL_PACKAGE_ENTRY_COLLISION',
  /** Entry carries setuid, setgid or sticky bits. */
  ENTRY_MODE_FORBIDDEN: 'SKILL_PACKAGE_ENTRY_MODE_FORBIDDEN',
  /** Archive holds more entries than the contract allows. */
  ENTRY_LIMIT_EXCEEDED: 'SKILL_PACKAGE_ENTRY_LIMIT_EXCEEDED',
  /** A single file or the whole payload exceeds its size cap. */
  SIZE_LIMIT_EXCEEDED: 'SKILL_PACKAGE_SIZE_LIMIT_EXCEEDED',
  /** Decompression ratio is outside the tolerated band. */
  COMPRESSION_RATIO_EXCEEDED: 'SKILL_PACKAGE_COMPRESSION_RATIO_EXCEEDED',
  /** Root layout, required entries or the package root directory are wrong. */
  LAYOUT_INVALID: 'SKILL_PACKAGE_LAYOUT_INVALID',
  /** Manifest is absent, or a second manifest is smuggled in a subdirectory. */
  MANIFEST_MISSING: 'SKILL_PACKAGE_MANIFEST_MISSING',
  /** Manifest does not parse or does not satisfy the #1228 contract. */
  MANIFEST_INVALID: 'SKILL_PACKAGE_MANIFEST_INVALID',
  /** Manifest disagrees with the package or with the Catalog coordinates. */
  MANIFEST_MISMATCH: 'SKILL_PACKAGE_MANIFEST_MISMATCH',
  /** A payload file carries the executable bit without declaring it. */
  UNDECLARED_EXECUTABLE: 'SKILL_PACKAGE_UNDECLARED_EXECUTABLE',
  /** A payload file is a script without declaring it. */
  UNDECLARED_SCRIPT: 'SKILL_PACKAGE_UNDECLARED_SCRIPT',
  /** A payload file's digest differs from the declared one. */
  DIGEST_MISMATCH: 'SKILL_PACKAGE_DIGEST_MISMATCH',
  /** A payload file's size differs from the declared one. */
  SIZE_MISMATCH: 'SKILL_PACKAGE_SIZE_MISMATCH',
  /** SKILL.md frontmatter is missing or disagrees with the manifest. */
  SKILL_MD_INVALID: 'SKILL_PACKAGE_SKILL_MD_INVALID',
  /** Staging directory could not be created, written or verified. */
  STAGING_IO: 'SKILL_PACKAGE_STAGING_IO',
  /** Caller aborted before the package was complete. */
  ABORTED: 'SKILL_PACKAGE_ABORTED',
} as const;

export type SkillPackageErrorCodeType =
  (typeof SkillPackageErrorCode)[keyof typeof SkillPackageErrorCode];

/** Coarse grouping a UI can branch on without knowing every code (UX-09). */
export type SkillPackageErrorCategory =
  | 'archive'
  | 'path'
  | 'limit'
  | 'integrity'
  | 'manifest'
  | 'staging';

const CATEGORIES: Record<SkillPackageErrorCodeType, SkillPackageErrorCategory> = {
  [SkillPackageErrorCode.ARCHIVE_FORMAT]: 'archive',
  [SkillPackageErrorCode.ARCHIVE_TRUNCATED]: 'archive',
  [SkillPackageErrorCode.ENTRY_TYPE_FORBIDDEN]: 'path',
  [SkillPackageErrorCode.ENTRY_PATH_UNSAFE]: 'path',
  [SkillPackageErrorCode.ENTRY_DUPLICATE]: 'path',
  [SkillPackageErrorCode.ENTRY_COLLISION]: 'path',
  [SkillPackageErrorCode.ENTRY_MODE_FORBIDDEN]: 'path',
  [SkillPackageErrorCode.ENTRY_LIMIT_EXCEEDED]: 'limit',
  [SkillPackageErrorCode.SIZE_LIMIT_EXCEEDED]: 'limit',
  [SkillPackageErrorCode.COMPRESSION_RATIO_EXCEEDED]: 'limit',
  [SkillPackageErrorCode.LAYOUT_INVALID]: 'manifest',
  [SkillPackageErrorCode.MANIFEST_MISSING]: 'manifest',
  [SkillPackageErrorCode.MANIFEST_INVALID]: 'manifest',
  [SkillPackageErrorCode.MANIFEST_MISMATCH]: 'manifest',
  [SkillPackageErrorCode.UNDECLARED_EXECUTABLE]: 'manifest',
  [SkillPackageErrorCode.UNDECLARED_SCRIPT]: 'manifest',
  [SkillPackageErrorCode.DIGEST_MISMATCH]: 'integrity',
  [SkillPackageErrorCode.SIZE_MISMATCH]: 'integrity',
  [SkillPackageErrorCode.SKILL_MD_INVALID]: 'manifest',
  [SkillPackageErrorCode.STAGING_IO]: 'staging',
  [SkillPackageErrorCode.ABORTED]: 'staging',
};

const MESSAGES: Record<SkillPackageErrorCodeType, string> = {
  [SkillPackageErrorCode.ARCHIVE_FORMAT]: 'Skill package is not a readable tar.gz archive',
  [SkillPackageErrorCode.ARCHIVE_TRUNCATED]: 'Skill package archive is truncated',
  [SkillPackageErrorCode.ENTRY_TYPE_FORBIDDEN]: 'Skill package contains a forbidden entry type',
  [SkillPackageErrorCode.ENTRY_PATH_UNSAFE]: 'Skill package contains an unsafe entry path',
  [SkillPackageErrorCode.ENTRY_DUPLICATE]: 'Skill package declares the same entry twice',
  [SkillPackageErrorCode.ENTRY_COLLISION]: 'Skill package contains colliding entry paths',
  [SkillPackageErrorCode.ENTRY_MODE_FORBIDDEN]: 'Skill package entry carries forbidden mode bits',
  [SkillPackageErrorCode.ENTRY_LIMIT_EXCEEDED]: 'Skill package contains too many entries',
  [SkillPackageErrorCode.SIZE_LIMIT_EXCEEDED]: 'Skill package exceeds a size limit',
  [SkillPackageErrorCode.COMPRESSION_RATIO_EXCEEDED]:
    'Skill package decompression ratio exceeds the limit',
  [SkillPackageErrorCode.LAYOUT_INVALID]: 'Skill package layout does not match the contract',
  [SkillPackageErrorCode.MANIFEST_MISSING]: 'Skill package manifest is missing or misplaced',
  [SkillPackageErrorCode.MANIFEST_INVALID]: 'Skill package manifest is not valid',
  [SkillPackageErrorCode.MANIFEST_MISMATCH]: 'Skill package manifest does not match the package',
  [SkillPackageErrorCode.UNDECLARED_EXECUTABLE]: 'Skill package contains an undeclared executable',
  [SkillPackageErrorCode.UNDECLARED_SCRIPT]: 'Skill package contains an undeclared script',
  [SkillPackageErrorCode.DIGEST_MISMATCH]: 'Skill package file digest does not match the manifest',
  [SkillPackageErrorCode.SIZE_MISMATCH]: 'Skill package file size does not match the manifest',
  [SkillPackageErrorCode.SKILL_MD_INVALID]: 'Skill package SKILL.md is missing or inconsistent',
  [SkillPackageErrorCode.STAGING_IO]: 'Skill package staging could not be prepared',
  [SkillPackageErrorCode.ABORTED]: 'Skill package processing was aborted',
};

/** Bounded, non-sensitive context attached to a rejection. */
export type SkillPackageErrorDetail = Record<string, string | number | boolean>;

/** A rejected Skill package. Safe to surface to API clients and logs. */
export class SkillPackageError extends Error {
  readonly code: SkillPackageErrorCodeType;
  readonly category: SkillPackageErrorCategory;
  readonly detail?: SkillPackageErrorDetail;

  constructor(code: SkillPackageErrorCodeType, detail?: SkillPackageErrorDetail) {
    super(MESSAGES[code]);
    this.name = 'SkillPackageError';
    this.code = code;
    this.category = CATEGORIES[code];
    if (detail) this.detail = detail;
  }
}

/** Narrow an unknown thrown value to a {@link SkillPackageError}. */
export function isSkillPackageError(value: unknown): value is SkillPackageError {
  return value instanceof SkillPackageError;
}

/**
 * Render an archive-supplied path so it is safe to put in an error detail.
 *
 * Percent-encodes everything outside a conservative allow-list and truncates,
 * so a crafted entry name cannot inject control characters into a log line or
 * smuggle markup into a UI. Machine-absolute paths never reach this function:
 * only archive-relative names do.
 */
export function encodeEntryPathForError(value: string): string {
  const encoded = value.replace(/[^A-Za-z0-9._/-]/g, (ch) =>
    [...ch]
      .map((c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
      .join('')
  );
  return encoded.length > 120 ? `${encoded.slice(0, 120)}…` : encoded;
}

function fail(
  code: SkillPackageErrorCodeType,
  detail?: SkillPackageErrorDetail
): never {
  throw new SkillPackageError(code, detail);
}

// =============================================================================
// Types
// =============================================================================

/** One regular payload file, as read from the archive. */
export interface SkillPackageFileEntry {
  /** POSIX path relative to the package root, after the root prefix is stripped. */
  readonly path: string;
  readonly size: number;
  /** Lowercase hex SHA-256 over the file bytes. */
  readonly sha256: string;
  /** Whether the archive entry carried any executable bit. */
  readonly executable: boolean;
  readonly bytes: Uint8Array;
}

/** Everything the archive declared, parsed and bounded but not yet reconciled. */
export interface SkillPackageTable {
  /** Single top-level directory that was stripped, or null when there was none. */
  readonly rootName: string | null;
  readonly files: readonly SkillPackageFileEntry[];
  /** Directory paths relative to the package root, root prefix stripped. */
  readonly directories: readonly string[];
  readonly compressedSize: number;
  readonly decompressedSize: number;
}

/** Coordinates the package is expected to belong to, from the Catalog. */
export interface SkillPackageReadOptions {
  skillId: string;
  version: string;
}

// =============================================================================
// tar header decoding
// =============================================================================

/** A regular file is typeflag `0`; historic writers use NUL for the same thing. */
const TYPEFLAG_REGULAR = new Set(['0', '\u0000']);
const TYPEFLAG_DIRECTORY = '5';

/**
 * Read a NUL-terminated text field.
 *
 * Bytes after the terminator must be NUL: a name that continues past its own
 * terminator is a header hand-built to be read differently by two parsers. The
 * decoded text must also round-trip, so an invalid UTF-8 name cannot slip
 * through as replacement characters.
 */
function readField(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  let end = slice.indexOf(0);
  if (end === -1) end = slice.length;
  for (let i = end; i < slice.length; i++) {
    if (slice[i] !== 0) fail(SkillPackageErrorCode.ARCHIVE_FORMAT, { field: 'padding' });
  }
  const raw = Buffer.from(slice.subarray(0, end));
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw)) {
    fail(SkillPackageErrorCode.ARCHIVE_FORMAT, { field: 'encoding' });
  }
  return text;
}

/**
 * Read an octal numeric field.
 *
 * Only octal digits, spaces and NULs are accepted; writers disagree about which
 * padding they use, but none of them needs another character. GNU base-256
 * encoding (high bit set) is refused rather than decoded: every value this
 * reader cares about is bounded well below the point where base-256 is needed,
 * so its presence only ever means a hand-built header.
 */
function readOctal(block: Uint8Array, offset: number, length: number): number {
  if ((block[offset] & 0x80) !== 0) {
    fail(SkillPackageErrorCode.ARCHIVE_FORMAT, { field: 'numeric-encoding' });
  }
  let digits = '';
  for (let i = offset; i < offset + length; i++) {
    const byte = block[i];
    if (byte === 0 || byte === 0x20) continue;
    if (byte < 0x30 || byte > 0x37) {
      fail(SkillPackageErrorCode.ARCHIVE_FORMAT, { field: 'numeric' });
    }
    digits += String.fromCharCode(byte);
  }
  if (digits === '') return 0;
  const value = parseInt(digits, 8);
  if (!Number.isSafeInteger(value)) {
    fail(SkillPackageErrorCode.ARCHIVE_FORMAT, { field: 'numeric-range' });
  }
  return value;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
  return true;
}

/** Verify the header checksum, accepting both the unsigned and signed sums. */
function verifyChecksum(block: Uint8Array, declared: number): void {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : block[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (declared !== unsigned && declared !== signed) {
    fail(SkillPackageErrorCode.ARCHIVE_FORMAT, { field: 'checksum' });
  }
}

interface RawEntry {
  name: string;
  isDirectory: boolean;
  mode: number;
  size: number;
  bytes: Uint8Array;
}

/** Decode the whole tar stream into raw entries, rejecting every other type. */
function readTarEntries(tar: Uint8Array): RawEntry[] {
  if (tar.byteLength === 0 || tar.byteLength % TAR_BLOCK_SIZE !== 0) {
    fail(SkillPackageErrorCode.ARCHIVE_TRUNCATED, { field: 'alignment' });
  }

  const entries: RawEntry[] = [];
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= tar.byteLength) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (isZeroBlock(header)) {
      for (let i = offset; i < tar.byteLength; i++) {
        if (tar[i] !== 0) fail(SkillPackageErrorCode.ARCHIVE_FORMAT, { field: 'trailer' });
      }
      return entries;
    }

    verifyChecksum(header, readOctal(header, 148, 8));

    // POSIX writes `ustar\0`, GNU writes `ustar ` — both are the same format here.
    if (readField(header, 257, 6).trim() !== 'ustar') {
      fail(SkillPackageErrorCode.ARCHIVE_FORMAT, { field: 'magic' });
    }

    const typeflag = readField(header, 156, 1) || '\u0000';
    const isDirectory = typeflag === TYPEFLAG_DIRECTORY;
    if (!isDirectory && !TYPEFLAG_REGULAR.has(typeflag)) {
      fail(SkillPackageErrorCode.ENTRY_TYPE_FORBIDDEN, { typeflag: encodeEntryPathForError(typeflag) });
    }
    if (readField(header, 157, 100) !== '') {
      fail(SkillPackageErrorCode.ENTRY_TYPE_FORBIDDEN, { typeflag: 'link' });
    }

    const mode = readOctal(header, 100, 8);
    if ((mode & 0o7000) !== 0) {
      fail(SkillPackageErrorCode.ENTRY_MODE_FORBIDDEN, { bits: (mode & 0o7000).toString(8) });
    }

    const prefix = readField(header, 345, 155);
    const name = readField(header, 0, 100);
    const fullName = prefix === '' ? name : `${prefix}/${name}`;

    const size = readOctal(header, 124, 12);
    if (isDirectory && size !== 0) {
      fail(SkillPackageErrorCode.ARCHIVE_FORMAT, { field: 'directory-size' });
    }
    if (size > SKILL_FILE_MAX_SIZE) {
      fail(SkillPackageErrorCode.SIZE_LIMIT_EXCEEDED, { limit: SKILL_FILE_MAX_SIZE });
    }

    const contentStart = offset + TAR_BLOCK_SIZE;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.byteLength) fail(SkillPackageErrorCode.ARCHIVE_TRUNCATED);

    entries.push({
      name: fullName,
      isDirectory,
      mode,
      size,
      bytes: isDirectory ? new Uint8Array(0) : tar.subarray(contentStart, contentEnd),
    });
    if (entries.length > SKILL_PACKAGE_MAX_ENTRIES) {
      fail(SkillPackageErrorCode.ENTRY_LIMIT_EXCEEDED, { limit: SKILL_PACKAGE_MAX_ENTRIES });
    }

    offset = contentStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  // A well-formed archive ends with zero blocks; running off the end does not.
  return fail(SkillPackageErrorCode.ARCHIVE_TRUNCATED, { field: 'trailer' });
}

// =============================================================================
// Path normalization
// =============================================================================

/**
 * Reduce an archive name to the form the root resolver and the payload-path
 * validator expect: no `./` prefix, no trailing slash, never empty.
 *
 * Everything else — traversal, absolute and drive paths, control characters,
 * depth and length — is left to `validateSkillPayloadPath`, which runs on the
 * final root-relative path. Checking here as well would only add a guard no
 * test could distinguish from the real one.
 */
function normalizeRawName(raw: string): { path: string; trailingSlash: boolean } {
  let value = raw;
  if (value.startsWith('./')) value = value.slice(2);
  const trailingSlash = value.endsWith('/');
  if (trailingSlash) value = value.slice(0, -1);
  if (value === '') fail(SkillPackageErrorCode.ENTRY_PATH_UNSAFE, { reason: 'empty' });
  return { path: value, trailingSlash };
}

/**
 * Strip the single top-level directory a conventional tarball carries.
 *
 * Only `<skill-id>` and `<skill-id>-<version>` are accepted as that directory,
 * so a package cannot install itself under a name the Catalog never named.
 */
function resolveRootName(paths: readonly string[], options: SkillPackageReadOptions): string | null {
  const allowed = [options.skillId, `${options.skillId}-${options.version}`];
  const firstSegments = new Set(paths.map((p) => p.split('/')[0]));
  if (firstSegments.size !== 1) return null;

  const candidate = [...firstSegments][0];
  const hasNested = paths.some((p) => p.startsWith(`${candidate}/`));
  if (!hasNested) return null;
  if (!allowed.includes(candidate)) {
    fail(SkillPackageErrorCode.LAYOUT_INVALID, {
      reason: 'root-directory',
      entry: encodeEntryPathForError(candidate),
    });
  }
  return candidate;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Decompress and parse a Skill package into a bounded entry table.
 *
 * The caller is expected to have verified the artifact digest already (#1229);
 * this step answers the separate question of whether the bytes are a package
 * this build is willing to look at.
 *
 * @param artifact Verified artifact bytes from the snapshot store
 * @param options Catalog coordinates the package must belong to
 * @throws SkillPackageError for every rejection
 */
export function readSkillPackage(
  artifact: Uint8Array,
  options: SkillPackageReadOptions
): SkillPackageTable {
  if (artifact.byteLength < 2 || artifact[0] !== 0x1f || artifact[1] !== 0x8b) {
    fail(SkillPackageErrorCode.ARCHIVE_FORMAT, { field: 'gzip-magic' });
  }

  let tar: Buffer;
  try {
    tar = gunzipSync(artifact, { maxOutputLength: SKILL_PACKAGE_MAX_DECOMPRESSED_BYTES });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      fail(SkillPackageErrorCode.SIZE_LIMIT_EXCEEDED, {
        limit: SKILL_PACKAGE_MAX_DECOMPRESSED_BYTES,
      });
    }
    fail(SkillPackageErrorCode.ARCHIVE_FORMAT, { field: 'gzip' });
  }

  if (
    tar.byteLength > SKILL_PACKAGE_RATIO_FLOOR_BYTES &&
    tar.byteLength / artifact.byteLength > SKILL_PACKAGE_MAX_COMPRESSION_RATIO
  ) {
    fail(SkillPackageErrorCode.COMPRESSION_RATIO_EXCEEDED, {
      limit: SKILL_PACKAGE_MAX_COMPRESSION_RATIO,
    });
  }

  const raw = readTarEntries(tar);
  const normalized = raw.map((entry) => ({ entry, ...normalizeRawName(entry.name) }));
  const rootName = resolveRootName(
    normalized.map((item) => item.path),
    options
  );

  const files: SkillPackageFileEntry[] = [];
  const directories: string[] = [];
  const byPath = new Map<string, boolean>();
  const byFold = new Map<string, string>();
  let payloadBytes = 0;

  for (const item of normalized) {
    let relative = item.path;
    if (rootName !== null) {
      if (relative === rootName) continue;
      relative = relative.slice(rootName.length + 1);
    }

    const isDirectory = item.entry.isDirectory || item.trailingSlash;
    const pathResult = validateSkillPayloadPath(relative, '/entry');
    if (!pathResult.ok) {
      fail(SkillPackageErrorCode.ENTRY_PATH_UNSAFE, {
        entry: encodeEntryPathForError(relative),
        reason: pathResult.errors[0].message,
      });
    }

    if (byPath.has(relative)) {
      fail(SkillPackageErrorCode.ENTRY_DUPLICATE, { entry: encodeEntryPathForError(relative) });
    }
    const folded = relative
      .split('/')
      .map((segment) => foldSkillIdForCollision(segment))
      .join('/');
    const collidesWith = byFold.get(folded);
    if (collidesWith !== undefined) {
      fail(SkillPackageErrorCode.ENTRY_COLLISION, { entry: encodeEntryPathForError(relative) });
    }
    byPath.set(relative, isDirectory);
    byFold.set(folded, relative);

    if (isDirectory) {
      directories.push(relative);
      continue;
    }

    payloadBytes += item.entry.size;
    if (payloadBytes > SKILL_PACKAGE_MAX_DECOMPRESSED_BYTES) {
      fail(SkillPackageErrorCode.SIZE_LIMIT_EXCEEDED, {
        limit: SKILL_PACKAGE_MAX_DECOMPRESSED_BYTES,
      });
    }
    const bytes = new Uint8Array(item.entry.bytes);
    files.push({
      path: relative,
      size: item.entry.size,
      sha256: computeSha256Hex(bytes),
      executable: (item.entry.mode & 0o111) !== 0,
      bytes,
    });
  }

  const payloadCount = files.filter((file) => file.path !== SKILL_MANIFEST_FILENAME).length;
  if (payloadCount > SKILL_FILES_MAX_COUNT) {
    fail(SkillPackageErrorCode.ENTRY_LIMIT_EXCEEDED, { limit: SKILL_FILES_MAX_COUNT });
  }

  // A file entry may not also be claimed as a directory by another entry.
  for (const directory of directories) {
    if (files.some((file) => file.path === directory)) {
      fail(SkillPackageErrorCode.ENTRY_DUPLICATE, { entry: encodeEntryPathForError(directory) });
    }
  }
  for (const file of files) {
    const parents = file.path.split('/').slice(0, -1);
    let walked = '';
    for (const segment of parents) {
      walked = walked === '' ? segment : `${walked}/${segment}`;
      if (files.some((other) => other.path === walked)) {
        fail(SkillPackageErrorCode.ENTRY_PATH_UNSAFE, {
          entry: encodeEntryPathForError(file.path),
          reason: 'parent-is-file',
        });
      }
    }
  }

  return {
    rootName,
    files,
    directories,
    compressedSize: artifact.byteLength,
    decompressedSize: tar.byteLength,
  };
}
