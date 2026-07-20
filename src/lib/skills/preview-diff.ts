/**
 * Virtual install diff between a verified Skill package and a live worktree (Issue #1233)
 *
 * Answers one question before anything is written: if this exact package landed
 * in `.agents/skills/<skill-id>` right now, which files would appear, which
 * would change, and which already-present file would be overwritten.
 *
 * Three properties the rest of the install flow depends on:
 * - Nothing here writes. Every path is derived from a server-resolved worktree
 *   path plus a validated Skill ID; no caller-supplied path reaches the disk.
 * - A state that could mislead is named rather than smoothed over: a detached or
 *   unborn HEAD, a binary or truncated body, a CRLF payload and a git-ignored
 *   destination each get an explicit field, because silently rendering them as
 *   an ordinary diff is how a user approves something they did not see.
 * - An existing file is never classified as a clean overwrite. It is either
 *   provably the same managed content (`unchanged`/`modify`) or it is a
 *   conflict, and conflicts make the plan non-installable.
 *
 * @module lib/skills/preview-diff
 */

import { createHash } from 'crypto';
import { lstatSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { execFileAsync, execGitCommand } from '@/lib/git/git-exec';
import {
  SKILL_FILE_MAX_SIZE,
  SKILL_ID_MAX_LENGTH,
  SKILL_ID_PATTERN,
  SKILL_INSTALL_ROOT_PREFIX,
} from '@/lib/skills/constants';
import { computeSha256Hex } from '@/lib/skills/integrity';
import { isSkillInstallStagingPath } from '@/lib/skills/operation-store';

// =============================================================================
// Limits
// =============================================================================

/** Maximum bytes of diff text kept for a single file. */
export const SKILL_DIFF_MAX_FILE_BYTES = 64 * 1024;

/** Maximum bytes of diff text kept across a whole plan. */
export const SKILL_DIFF_MAX_TOTAL_BYTES = 512 * 1024;

/** Maximum diff lines emitted for a single file. */
export const SKILL_DIFF_MAX_LINES = 400;

/** Context lines around the changed region of a modified file. */
export const SKILL_DIFF_CONTEXT_LINES = 3;

/** Maximum entries walked when scanning the existing target directory. */
export const SKILL_TREE_SCAN_MAX_ENTRIES = 2000;

/** Maximum directory depth walked under the target root. */
export const SKILL_TREE_SCAN_MAX_DEPTH = 16;

/** Bytes inspected when deciding whether content is binary. */
const BINARY_SNIFF_BYTES = 8000;

// =============================================================================
// Vocabulary
// =============================================================================

/** What installing would do to one path. */
export type SkillDiffChange = 'add' | 'modify' | 'unchanged' | 'conflict' | 'unmanaged';

/** Why an entry was classified the way it was. Stable machine codes. */
export const SkillDiffReason = {
  /** Path does not exist in the worktree. */
  NEW_FILE: 'SKILL_DIFF_NEW_FILE',
  /** Present, recorded by the install receipt, and byte-identical to the package. */
  CONTENT_IDENTICAL: 'SKILL_DIFF_CONTENT_IDENTICAL',
  /** Present, matches what the receipt recorded, and the package supersedes it. */
  MANAGED_UPDATE: 'SKILL_DIFF_MANAGED_UPDATE',
  /** Present and recorded, but its bytes no longer match the receipt. */
  LOCAL_MODIFICATION: 'SKILL_DIFF_LOCAL_MODIFICATION',
  /** Present under the install root with no receipt recording it. */
  UNMANAGED_SKILL: 'SKILL_DIFF_UNMANAGED_SKILL',
  /** Recorded by the receipt but absent from the package being installed. */
  RECEIPT_ORPHAN: 'SKILL_DIFF_RECEIPT_ORPHAN',
  /** Present as a symlink, a directory or another non-regular entry. */
  NOT_A_REGULAR_FILE: 'SKILL_DIFF_NOT_A_REGULAR_FILE',
} as const;

export type SkillDiffReasonCode = (typeof SkillDiffReason)[keyof typeof SkillDiffReason];

/** Line terminator style observed in a payload. */
export type SkillLineEnding = 'lf' | 'crlf' | 'mixed' | 'none';

/** Where HEAD points in the target worktree. */
export type SkillHeadState = 'attached' | 'detached' | 'unborn' | 'unknown';

/** Plan-level conditions a user must be told about before approving. */
export const SkillPreviewWarning = {
  /** HEAD is not on a branch; the install would land on a detached checkout. */
  DETACHED_HEAD: 'SKILL_PREVIEW_DETACHED_HEAD',
  /** The repository has no commit yet, so there is no HEAD to pin the plan to. */
  UNBORN_HEAD: 'SKILL_PREVIEW_UNBORN_HEAD',
  /** HEAD could not be resolved at all. */
  HEAD_UNRESOLVED: 'SKILL_PREVIEW_HEAD_UNRESOLVED',
  /** The worktree has uncommitted changes. */
  WORKING_TREE_DIRTY: 'SKILL_PREVIEW_WORKING_TREE_DIRTY',
  /** At least one destination path is ignored or excluded by git. */
  PATH_GIT_IGNORED: 'SKILL_PREVIEW_PATH_GIT_IGNORED',
  /** At least one diff body was cut short. */
  DIFF_TRUNCATED: 'SKILL_PREVIEW_DIFF_TRUNCATED',
  /** At least one file has no textual diff because its content is binary. */
  BINARY_CONTENT: 'SKILL_PREVIEW_BINARY_CONTENT',
  /** At least one payload file uses CRLF or mixed terminators. */
  LINE_ENDING_CRLF: 'SKILL_PREVIEW_LINE_ENDING_CRLF',
  /** The existing target directory could not be scanned completely. */
  TREE_SCAN_TRUNCATED: 'SKILL_PREVIEW_TREE_SCAN_TRUNCATED',
} as const;

export type SkillPreviewWarningCode =
  (typeof SkillPreviewWarning)[keyof typeof SkillPreviewWarning];

// =============================================================================
// Shapes
// =============================================================================

/** One planned write, described against the file currently at that path. */
export interface SkillDiffEntry {
  /** Repository-relative POSIX path. Never absolute. */
  path: string;
  change: SkillDiffChange;
  reason: SkillDiffReasonCode;
  /** The receipt CommandMate generates, as opposed to a publisher payload file. */
  generated: boolean;
  /** Digest and size of what would be written; null when nothing would be written. */
  sha256: string | null;
  size: number | null;
  executable: boolean;
  /** Digest and size of what is there now; null when the path is free. */
  currentSha256: string | null;
  currentSize: number | null;
  binary: boolean;
  lineEnding: SkillLineEnding;
  /** Destination is ignored or excluded by git, so the write would be invisible to status. */
  gitIgnored: boolean;
  /** Unified diff body, or null for a binary file or a path with no textual change. */
  diff: string | null;
  diffTruncated: boolean;
  additions: number;
  deletions: number;
}

/** One file that exists under the install root right now. */
export interface SkillExistingFile {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
  bytes: Uint8Array;
}

/** Result of scanning the install root before any write. */
export interface SkillExistingTree {
  /** The install root exists as a directory. */
  present: boolean;
  files: readonly SkillExistingFile[];
  /** Paths present but not regular files (symlink, socket, nested directory entry). */
  irregularPaths: readonly string[];
  /** The walk hit a bound and stopped; the listing is incomplete. */
  truncated: boolean;
}

/** Live git facts the plan is pinned to. */
export interface SkillGitTargetState {
  headState: SkillHeadState;
  /** Branch name, or null when HEAD is detached or unresolved. */
  branch: string | null;
  /** Full 40-hex HEAD commit, or null on an unborn HEAD. */
  headCommit: string | null;
  /** The worktree has uncommitted changes. */
  dirty: boolean;
}

/** A file the package would write, as the diff builder needs it. */
export interface SkillPlannedFile {
  /** Path relative to the install root. */
  relativePath: string;
  sha256: string;
  size: number;
  executable: boolean;
  bytes: Uint8Array;
  /** True for `.commandmate-receipt.json`, which CommandMate authors. */
  generated: boolean;
}

/** Aggregate counts, so a caller does not re-derive them from the entry list. */
export interface SkillDiffStats {
  added: number;
  modified: number;
  unchanged: number;
  conflicted: number;
  unmanaged: number;
  binaryFiles: number;
  truncatedFiles: number;
  diffBytes: number;
}

/** The complete virtual diff for one plan. */
export interface SkillPreviewDiff {
  /** Repository-relative install root, always `.agents/skills/<skill-id>`. */
  installRoot: string;
  entries: readonly SkillDiffEntry[];
  stats: SkillDiffStats;
  warnings: readonly SkillPreviewWarningCode[];
  /** Tree hash of the install root as it is now. */
  currentTreeHash: string;
  /** Tree hash the install root would have afterwards, receipt included. */
  plannedTreeHash: string;
}

// =============================================================================
// Paths
// =============================================================================

/** Repository-relative install root for a validated Skill ID. */
export function skillInstallRoot(skillId: string): string {
  return `${SKILL_INSTALL_ROOT_PREFIX}/${skillId}`;
}

/**
 * Absolute install root inside a server-resolved worktree.
 *
 * The ID is re-checked against the slug grammar rather than only comparing the
 * joined result: `path.join` normalizes `..` away, so `.agents/skills/../x`
 * and `.agents/x` compare equal and a containment check alone would accept an
 * ID that walked out of the Skills directory. Rejecting the grammar first makes
 * traversal unrepresentable; the containment check then covers the rest.
 */
export function resolveSkillInstallRoot(worktreePath: string, skillId: string): string {
  if (!SKILL_ID_PATTERN.test(skillId) || skillId.length > SKILL_ID_MAX_LENGTH) {
    throw new Error('Skill ID is not a valid install root segment');
  }
  const root = path.resolve(worktreePath);
  const target = path.resolve(root, SKILL_INSTALL_ROOT_PREFIX, skillId);
  const relative = path.relative(root, target);
  if (
    relative !== path.join(SKILL_INSTALL_ROOT_PREFIX, skillId) ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Skill install root escapes the worktree');
  }
  return target;
}

// =============================================================================
// Content classification
// =============================================================================

/** Content is treated as binary when a NUL byte appears near the start. */
export function isBinaryContent(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** Terminator style of a payload, so a CRLF file is not silently normalized. */
export function detectLineEnding(bytes: Uint8Array): SkillLineEnding {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0x0a) continue;
    if (i > 0 && bytes[i - 1] === 0x0d) crlf += 1;
    else lf += 1;
  }
  if (crlf > 0 && lf > 0) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (lf > 0) return 'lf';
  return 'none';
}

/**
 * Split into lines without normalizing terminators.
 *
 * A trailing `\r` is kept on the line, so a CRLF file diffs as CRLF rather than
 * appearing identical to its LF twin.
 */
function splitLines(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString('utf-8');
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// =============================================================================
// Tree hash
// =============================================================================

interface TreeHashInput {
  path: string;
  sha256: string;
  executable: boolean;
}

/**
 * Order-independent digest of a file set.
 *
 * Apply re-computes this over the live directory and refuses when it differs,
 * so the mode bit is part of the input: a payload that gained an execute bit
 * between plan and apply is drift, not a detail.
 */
export function computeSkillTreeHash(files: readonly TreeHashInput[]): string {
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\x00${file.sha256}\x00${file.executable ? '1' : '0'}`)
    .join('\n');
  return createHash('sha256').update(`skill-tree-v1\n${canonical}`).digest('hex');
}

// =============================================================================
// Existing tree
// =============================================================================

function isExecutableMode(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

/**
 * List the install root as it is right now.
 *
 * `lstat` rather than `stat` throughout: a symlink under the install root is
 * reported as an irregular path instead of being followed, so a planted link
 * cannot make the preview describe a file outside the worktree.
 */
export function readExistingSkillTree(installRootAbs: string): SkillExistingTree {
  let rootStats;
  try {
    rootStats = lstatSync(installRootAbs);
  } catch {
    return { present: false, files: [], irregularPaths: [], truncated: false };
  }
  if (!rootStats.isDirectory()) {
    return { present: true, files: [], irregularPaths: [''], truncated: false };
  }

  const files: SkillExistingFile[] = [];
  const irregularPaths: string[] = [];
  let truncated = false;
  let scanned = 0;

  const walk = (dirAbs: string, relPrefix: string, depth: number): void => {
    if (truncated) return;
    if (depth > SKILL_TREE_SCAN_MAX_DEPTH) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      truncated = true;
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (truncated) return;
      scanned += 1;
      if (scanned > SKILL_TREE_SCAN_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const relative = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const absolute = path.join(dirAbs, entry.name);

      if (entry.isDirectory()) {
        walk(absolute, relative, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        irregularPaths.push(relative);
        continue;
      }
      let stats;
      try {
        stats = lstatSync(absolute);
      } catch {
        irregularPaths.push(relative);
        continue;
      }
      if (!stats.isFile() || stats.size > SKILL_FILE_MAX_SIZE) {
        irregularPaths.push(relative);
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(absolute);
      } catch {
        irregularPaths.push(relative);
        continue;
      }
      files.push({
        path: relative,
        sha256: computeSha256Hex(bytes),
        size: bytes.byteLength,
        executable: isExecutableMode(stats.mode),
        bytes,
      });
    }
  };

  walk(installRootAbs, '', 0);
  return { present: true, files, irregularPaths, truncated };
}

// =============================================================================
// Git state
// =============================================================================

/**
 * Resolve branch, HEAD and dirtiness of a server-resolved worktree.
 *
 * The two failure modes are deliberately distinguished rather than collapsed
 * into "no branch": a detached HEAD has a commit to pin the plan to, an unborn
 * HEAD has none, and apply must be able to tell those apart.
 */
export async function readSkillGitTargetState(
  worktreePath: string
): Promise<SkillGitTargetState> {
  const [branch, headCommit, status] = await Promise.all([
    execGitCommand(['symbolic-ref', '--quiet', '--short', 'HEAD'], worktreePath),
    execGitCommand(['rev-parse', 'HEAD'], worktreePath),
    execGitCommand(['status', '--porcelain'], worktreePath),
  ]);

  const commit = headCommit && /^[0-9a-f]{40}$/.test(headCommit) ? headCommit : null;
  let headState: SkillHeadState;
  if (branch && commit) headState = 'attached';
  else if (!branch && commit) headState = 'detached';
  else if (branch && !commit) headState = 'unborn';
  else headState = 'unknown';

  return {
    headState,
    branch: branch && branch.length > 0 ? branch : null,
    headCommit: commit,
    dirty: status !== null && status.length > 0,
  };
}

/**
 * Which destination paths git would ignore.
 *
 * `check-ignore` exits 1 when nothing matched, which `execFile` surfaces as a
 * rejection, so the non-zero exit is read for stdout rather than treated as a
 * failure. Paths already in the index are not reported, which is the answer we
 * want: a tracked file stays visible to git regardless of ignore rules.
 */
export async function findGitIgnoredPaths(
  worktreePath: string,
  relativePaths: readonly string[]
): Promise<Set<string>> {
  if (relativePaths.length === 0) return new Set();
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['check-ignore', '-z', '--', ...relativePaths],
      { cwd: worktreePath, timeout: 3000 }
    );
    return parseNulSeparated(stdout);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    return typeof stdout === 'string' ? parseNulSeparated(stdout) : new Set();
  }
}

function parseNulSeparated(stdout: string): Set<string> {
  return new Set(stdout.split('\0').filter((value) => value.length > 0));
}

// =============================================================================
// Unified diff
// =============================================================================

interface DiffBudget {
  remainingBytes: number;
}

interface DiffBody {
  text: string | null;
  truncated: boolean;
  additions: number;
  deletions: number;
}

function emptyBody(): DiffBody {
  return { text: null, truncated: false, additions: 0, deletions: 0 };
}

/**
 * Build a single-hunk unified diff.
 *
 * The changed region is found by trimming the common prefix and suffix rather
 * than by running an LCS: the result is a correct, honest diff at linear cost,
 * and a preview does not gain anything from splitting one edit into several
 * hunks it would render adjacently anyway.
 */
export function buildUnifiedDiff(
  before: Uint8Array | null,
  after: Uint8Array | null,
  budget: DiffBudget
): DiffBody {
  if (before === null && after === null) return emptyBody();

  const beforeLines = before ? splitLines(before) : [];
  const afterLines = after ? splitLines(after) : [];

  let prefix = 0;
  const maxPrefix = Math.min(beforeLines.length, afterLines.length);
  while (prefix < maxPrefix && beforeLines[prefix] === afterLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < maxPrefix - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  if (removed.length === 0 && added.length === 0) return emptyBody();

  const contextStart = Math.max(0, prefix - SKILL_DIFF_CONTEXT_LINES);
  const leadingContext = beforeLines.slice(contextStart, prefix);
  const trailingContext = beforeLines.slice(
    beforeLines.length - suffix,
    Math.min(beforeLines.length, beforeLines.length - suffix + SKILL_DIFF_CONTEXT_LINES)
  );

  const beforeCount = leadingContext.length + removed.length + trailingContext.length;
  const afterCount = leadingContext.length + added.length + trailingContext.length;
  const beforeStart = beforeCount === 0 ? 0 : contextStart + 1;
  const afterStart = afterCount === 0 ? 0 : contextStart + 1;

  const lines: string[] = [`@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`];
  let truncated = false;
  let bytes = lines[0].length + 1;

  const push = (prefixChar: string, value: string): boolean => {
    if (lines.length >= SKILL_DIFF_MAX_LINES + 1) return false;
    const line = `${prefixChar}${value}`;
    const cost = line.length + 1;
    if (bytes + cost > SKILL_DIFF_MAX_FILE_BYTES || cost > budget.remainingBytes - bytes) {
      return false;
    }
    lines.push(line);
    bytes += cost;
    return true;
  };

  for (const value of leadingContext) {
    if (!push(' ', value)) { truncated = true; break; }
  }
  if (!truncated) {
    for (const value of removed) {
      if (!push('-', value)) { truncated = true; break; }
    }
  }
  if (!truncated) {
    for (const value of added) {
      if (!push('+', value)) { truncated = true; break; }
    }
  }
  if (!truncated) {
    for (const value of trailingContext) {
      if (!push(' ', value)) { truncated = true; break; }
    }
  }

  if (truncated) lines.push('… diff truncated');
  const text = lines.join('\n');
  budget.remainingBytes = Math.max(0, budget.remainingBytes - text.length);

  return { text, truncated, additions: added.length, deletions: removed.length };
}

// =============================================================================
// Assembly
// =============================================================================

interface BuildPreviewInput {
  skillId: string;
  worktreePath: string;
  /** Everything the install would write, receipt included. */
  plannedFiles: readonly SkillPlannedFile[];
  existing: SkillExistingTree;
  /** Files the install receipt currently in the worktree recorded, if any. */
  receiptFiles: ReadonlyMap<string, { sha256: string; executable: boolean }> | null;
  git: SkillGitTargetState;
  gitIgnoredPaths: ReadonlySet<string>;
}

function classify(
  planned: SkillPlannedFile | null,
  existing: SkillExistingFile | null,
  recorded: { sha256: string; executable: boolean } | null
): { change: SkillDiffChange; reason: SkillDiffReasonCode } {
  if (!existing) {
    return planned
      ? { change: 'add', reason: SkillDiffReason.NEW_FILE }
      : { change: 'unchanged', reason: SkillDiffReason.RECEIPT_ORPHAN };
  }
  if (!recorded) {
    return { change: 'unmanaged', reason: SkillDiffReason.UNMANAGED_SKILL };
  }
  if (existing.sha256 !== recorded.sha256 || existing.executable !== recorded.executable) {
    return { change: 'conflict', reason: SkillDiffReason.LOCAL_MODIFICATION };
  }
  if (!planned) {
    return { change: 'unmanaged', reason: SkillDiffReason.RECEIPT_ORPHAN };
  }
  if (planned.sha256 === existing.sha256 && planned.executable === existing.executable) {
    return { change: 'unchanged', reason: SkillDiffReason.CONTENT_IDENTICAL };
  }
  return { change: 'modify', reason: SkillDiffReason.MANAGED_UPDATE };
}

/**
 * Assemble the virtual diff.
 *
 * Every planned write appears, including the generated receipt, and every file
 * already under the install root appears even when the package does not mention
 * it — an existing Skill the user installed by hand must be visible as
 * something the install would collide with, not omitted because the package is
 * unaware of it.
 */
export function buildSkillPreviewDiff(input: BuildPreviewInput): SkillPreviewDiff {
  const installRoot = skillInstallRoot(input.skillId);
  const plannedByPath = new Map(input.plannedFiles.map((file) => [file.relativePath, file]));
  const existingByPath = new Map(input.existing.files.map((file) => [file.path, file]));

  const allPaths = [
    ...new Set([
      ...plannedByPath.keys(),
      ...existingByPath.keys(),
      ...(input.receiptFiles ? [...input.receiptFiles.keys()] : []),
    ]),
  ]
    .filter((relative) => !isSkillInstallStagingPath(`${installRoot}/${relative}`))
    .sort();

  const budget: DiffBudget = { remainingBytes: SKILL_DIFF_MAX_TOTAL_BYTES };
  const entries: SkillDiffEntry[] = [];
  const stats: SkillDiffStats = {
    added: 0,
    modified: 0,
    unchanged: 0,
    conflicted: 0,
    unmanaged: 0,
    binaryFiles: 0,
    truncatedFiles: 0,
    diffBytes: 0,
  };
  let anyCrlf = false;

  for (const relative of allPaths) {
    const planned = plannedByPath.get(relative) ?? null;
    const existing = existingByPath.get(relative) ?? null;
    const recorded = input.receiptFiles?.get(relative) ?? null;
    const { change, reason } = classify(planned, existing, recorded);

    const repoPath = `${installRoot}/${relative}`;
    const source = planned?.bytes ?? existing?.bytes ?? null;
    const binary =
      (planned ? isBinaryContent(planned.bytes) : false) ||
      (existing ? isBinaryContent(existing.bytes) : false);
    const lineEnding = source ? detectLineEnding(source) : 'none';
    if (planned && (lineEnding === 'crlf' || lineEnding === 'mixed')) anyCrlf = true;

    const body =
      binary || change === 'unchanged'
        ? emptyBody()
        : buildUnifiedDiff(existing?.bytes ?? null, planned?.bytes ?? null, budget);

    entries.push({
      path: repoPath,
      change,
      reason,
      generated: planned?.generated ?? false,
      sha256: planned?.sha256 ?? null,
      size: planned?.size ?? null,
      executable: planned?.executable ?? existing?.executable ?? false,
      currentSha256: existing?.sha256 ?? null,
      currentSize: existing?.size ?? null,
      binary,
      lineEnding,
      gitIgnored: input.gitIgnoredPaths.has(repoPath),
      diff: body.text,
      diffTruncated: body.truncated,
      additions: body.additions,
      deletions: body.deletions,
    });

    if (change === 'add') stats.added += 1;
    else if (change === 'modify') stats.modified += 1;
    else if (change === 'unchanged') stats.unchanged += 1;
    else if (change === 'conflict') stats.conflicted += 1;
    else stats.unmanaged += 1;
    if (binary) stats.binaryFiles += 1;
    if (body.truncated) stats.truncatedFiles += 1;
    stats.diffBytes += body.text?.length ?? 0;
  }

  for (const irregular of input.existing.irregularPaths) {
    const repoPath = irregular ? `${installRoot}/${irregular}` : installRoot;
    entries.push({
      path: repoPath,
      change: 'conflict',
      reason: SkillDiffReason.NOT_A_REGULAR_FILE,
      generated: false,
      sha256: null,
      size: null,
      executable: false,
      currentSha256: null,
      currentSize: null,
      binary: false,
      lineEnding: 'none',
      gitIgnored: input.gitIgnoredPaths.has(repoPath),
      diff: null,
      diffTruncated: false,
      additions: 0,
      deletions: 0,
    });
    stats.conflicted += 1;
  }

  const warnings = collectWarnings(input, entries, stats, anyCrlf);

  // The planned tree keeps every file the install would not remove, so the hash
  // describes the directory apply must produce — not just the package.
  const plannedTree: TreeHashInput[] = input.plannedFiles.map((file) => ({
    path: file.relativePath,
    sha256: file.sha256,
    executable: file.executable,
  }));
  for (const existing of input.existing.files) {
    if (!plannedByPath.has(existing.path)) {
      plannedTree.push({
        path: existing.path,
        sha256: existing.sha256,
        executable: existing.executable,
      });
    }
  }

  return {
    installRoot,
    entries: entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    stats,
    warnings,
    currentTreeHash: computeSkillTreeHash(input.existing.files),
    plannedTreeHash: computeSkillTreeHash(plannedTree),
  };
}

function collectWarnings(
  input: BuildPreviewInput,
  entries: readonly SkillDiffEntry[],
  stats: SkillDiffStats,
  anyCrlf: boolean
): SkillPreviewWarningCode[] {
  const warnings: SkillPreviewWarningCode[] = [];
  if (input.git.headState === 'detached') warnings.push(SkillPreviewWarning.DETACHED_HEAD);
  if (input.git.headState === 'unborn') warnings.push(SkillPreviewWarning.UNBORN_HEAD);
  if (input.git.headState === 'unknown') warnings.push(SkillPreviewWarning.HEAD_UNRESOLVED);
  if (input.git.dirty) warnings.push(SkillPreviewWarning.WORKING_TREE_DIRTY);
  if (entries.some((entry) => entry.gitIgnored)) warnings.push(SkillPreviewWarning.PATH_GIT_IGNORED);
  if (stats.truncatedFiles > 0) warnings.push(SkillPreviewWarning.DIFF_TRUNCATED);
  if (stats.binaryFiles > 0) warnings.push(SkillPreviewWarning.BINARY_CONTENT);
  if (anyCrlf) warnings.push(SkillPreviewWarning.LINE_ENDING_CRLF);
  if (input.existing.truncated) warnings.push(SkillPreviewWarning.TREE_SCAN_TRUNCATED);
  return warnings;
}
