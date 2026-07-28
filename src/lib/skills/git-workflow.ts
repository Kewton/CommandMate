/**
 * Skill install Git workflow (Issue #1247)
 *
 * Turns "a Skill was installed into this worktree" into something a reviewer can
 * approve: a dedicated branch, a commit that contains the Skill payload and
 * nothing else, a push, and a draft PR whose body carries the provenance a
 * reviewer needs.
 *
 * Two properties define the module.
 *
 * The first is that the index is never used as an input. `git add .` and "commit
 * whatever is staged" would take the user's unrelated — possibly secret-bearing —
 * work along with the Skill, so staging is driven exclusively by the receipt: the
 * pathspec is the install root set the receipt records, and the staged result is
 * re-read and checked against the receipt inventory before a commit is created.
 * A pre-existing staged change is a reason to stop, never something to sweep up.
 *
 * The second is that branch selection happens *before* the Install Plan exists.
 * A plan is bound to the branch and HEAD it was built against (#1233), so
 * checking out afterwards would guarantee `SKILL_PLAN_STALE`. {@link
 * prepareSkillGitWorkflow} therefore runs first and fixes the target; the caller
 * then builds and applies the plan; {@link applySkillGitWorkflow} commits it.
 *
 * Nothing here executes a shell, and no client-supplied path ever reaches git:
 * every pathspec is derived from the receipt, and `gh` is confined to
 * {@link module:lib/skills/pull-request-service}.
 *
 * @module lib/skills/git-workflow
 */

import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { GIT_WRITE_TIMEOUT_MS } from '@/config/git-status-config';
import { createLogger } from '@/lib/logger';
import { execGitCommand, execGitCommandTyped, runSerializedWrite } from '@/lib/git/git-exec';
import { createBranch } from '@/lib/git/git-branches';
import { stageFiles, gitCommit } from '@/lib/git/git-commit';
import { gitPush } from '@/lib/git/git-remote';
import { resolveDefaultBranchName } from '@/lib/git/git-default-branch';
import { GitNothingToCommitError } from '@/lib/git/git-errors';
import { SKILL_MANIFEST_FILENAME } from '@/lib/skills/constants';
import { readSkillGitTargetState, resolveSkillInstallRoot } from '@/lib/skills/preview-diff';
import { SKILL_RECEIPT_FILENAME, receiptInstallRoots } from '@/lib/skills/install-plan';
import { redactSkillOperationText } from '@/lib/skills/operation-store';
import {
  createDraftPullRequest,
  findOpenPullRequest,
} from '@/lib/skills/pull-request-service';
import { parseSkillYaml } from '@/lib/skills/safe-yaml';
import { validateSkillInstallReceipt, validateSkillManifest } from '@/lib/skills/schema';
import type {
  SkillInstallReceipt,
  SkillManifest,
  SkillRiskLevel,
} from '@/types/skills';

const logger = createLogger('skills/git-workflow');

/** Upper bound on the PR body, so a pathological manifest cannot build a huge argv. */
const PR_BODY_MAX_LENGTH = 60000;

// =============================================================================
// Mode
// =============================================================================

/**
 * Which Git side effects the user explicitly asked for.
 *
 * There is no default. UX-09 requires the Git consequences to be chosen
 * separately from the install confirmation, so the caller must name one.
 */
export type SkillGitWorkflowMode = 'current_branch' | 'dedicated_branch';

// =============================================================================
// Errors
// =============================================================================

/** Client-safe reasons the Git workflow refuses to start or continue. */
export const SkillGitWorkflowErrorCode = {
  /** Something unrelated is already staged; stashing it is out of scope. */
  INDEX_NOT_CLEAN: 'SKILL_GIT_INDEX_NOT_CLEAN',
  /** HEAD is detached, unborn or unreadable, so there is no branch to commit to. */
  HEAD_UNSUPPORTED: 'SKILL_GIT_HEAD_UNSUPPORTED',
  /** The dedicated branch name is already taken in this repository. */
  BRANCH_EXISTS: 'SKILL_GIT_BRANCH_EXISTS',
  /** An Agent session is live in this worktree; switching branches under it is refused. */
  ACTIVE_SESSION: 'SKILL_GIT_ACTIVE_SESSION',
  /** The push target is the repository's default branch. */
  PROTECTED_BRANCH: 'SKILL_GIT_PROTECTED_BRANCH',
  /** The requested remote is not configured. */
  REMOTE_MISSING: 'SKILL_GIT_REMOTE_MISSING',
  /** The branch moved between prepare and apply, so the approved target is gone. */
  TARGET_DRIFTED: 'SKILL_GIT_TARGET_DRIFTED',
  /** Staging produced a path the receipt does not own. Nothing is committed. */
  UNOWNED_STAGED_PATH: 'SKILL_GIT_UNOWNED_STAGED_PATH',
  /** No install receipt is present, so the owned file set cannot be derived. */
  RECEIPT_UNREADABLE: 'SKILL_GIT_RECEIPT_UNREADABLE',
  /** The push itself failed. The commit is already local. */
  PUSH_FAILED: 'SKILL_GIT_PUSH_FAILED',
  /** `gh` is not installed, so a PR cannot be opened from here. */
  PR_TOOL_MISSING: 'SKILL_GIT_PR_TOOL_MISSING',
  /** `gh pr create` failed. The commit is pushed. */
  PR_FAILED: 'SKILL_GIT_PR_FAILED',
} as const;

export type SkillGitWorkflowErrorCodeType =
  (typeof SkillGitWorkflowErrorCode)[keyof typeof SkillGitWorkflowErrorCode];

/** HTTP status each reason maps to, so every caller answers alike. */
export const SKILL_GIT_WORKFLOW_ERROR_STATUS: Record<SkillGitWorkflowErrorCodeType, number> = {
  [SkillGitWorkflowErrorCode.INDEX_NOT_CLEAN]: 409,
  [SkillGitWorkflowErrorCode.HEAD_UNSUPPORTED]: 409,
  [SkillGitWorkflowErrorCode.BRANCH_EXISTS]: 409,
  [SkillGitWorkflowErrorCode.ACTIVE_SESSION]: 409,
  [SkillGitWorkflowErrorCode.PROTECTED_BRANCH]: 409,
  [SkillGitWorkflowErrorCode.REMOTE_MISSING]: 409,
  [SkillGitWorkflowErrorCode.TARGET_DRIFTED]: 409,
  [SkillGitWorkflowErrorCode.UNOWNED_STAGED_PATH]: 409,
  [SkillGitWorkflowErrorCode.RECEIPT_UNREADABLE]: 409,
  [SkillGitWorkflowErrorCode.PUSH_FAILED]: 502,
  [SkillGitWorkflowErrorCode.PR_TOOL_MISSING]: 409,
  [SkillGitWorkflowErrorCode.PR_FAILED]: 502,
};

/**
 * A Git workflow rejection.
 *
 * The message is built from the code alone. `detail` carries only
 * repository-relative paths, branch names and counts — never a machine-absolute
 * path, a remote URL or raw git stderr.
 */
export class SkillGitWorkflowError extends Error {
  constructor(
    readonly code: SkillGitWorkflowErrorCodeType,
    readonly detail?: Record<string, string | number | boolean>
  ) {
    super(`Skill git workflow rejected: ${code}`);
    this.name = 'SkillGitWorkflowError';
  }

  get status(): number {
    return SKILL_GIT_WORKFLOW_ERROR_STATUS[this.code];
  }
}

export function isSkillGitWorkflowError(value: unknown): value is SkillGitWorkflowError {
  return value instanceof SkillGitWorkflowError;
}

function fail(
  code: SkillGitWorkflowErrorCodeType,
  detail?: Record<string, string | number | boolean>
): never {
  throw new SkillGitWorkflowError(code, detail);
}

// =============================================================================
// Branch naming
// =============================================================================

/** Namespace every Skill install branch lives under, so they are recognisable. */
export const SKILL_INSTALL_BRANCH_PREFIX = 'skills/install';

/**
 * Branch name for one Skill install.
 *
 * The Skill ID is already a strict lowercase slug, but a version is a semver
 * string that may carry build metadata (`+`) or prerelease dots, so it is
 * reduced to the ref-safe alphabet here rather than trusted. The result is
 * checked against the same rules `git check-ref-format` applies, so a name this
 * function returns is always creatable.
 */
export function buildSkillInstallBranchName(skillId: string, version: string): string {
  const safeVersion = version
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');
  const name = `${SKILL_INSTALL_BRANCH_PREFIX}-${skillId}${safeVersion ? `-v${safeVersion}` : ''}`;
  if (
    name.length > 200 ||
    name.includes('..') ||
    name.endsWith('.lock') ||
    /[\s~^:?*[\\]/.test(name)
  ) {
    // Unreachable for a validated Skill ID; kept so a future ID grammar change
    // fails here rather than at `git branch`.
    throw new SkillGitWorkflowError(SkillGitWorkflowErrorCode.BRANCH_EXISTS, { branch: name });
  }
  return name;
}

// =============================================================================
// Owned paths
// =============================================================================

/** The repository-relative install roots plus the file inventory inside each. */
export interface SkillOwnedPaths {
  /** Every install root the receipt records, primary first. */
  roots: string[];
  /** Every repository-relative file the receipt accounts for, sorted. */
  files: string[];
}

/**
 * Repository-relative paths this install owns, across every root.
 *
 * The root set comes from the receipt rather than from a constant: an install
 * written before #1460 records one root, a current one records both
 * (`.agents/skills/<id>` and `.claude/skills/<id>`), and staging only the
 * constant's first entry would leave half the payload out of the commit.
 */
export function resolveSkillOwnedPaths(receipt: SkillInstallReceipt): SkillOwnedPaths {
  const roots = receiptInstallRoots(receipt);
  const files: string[] = [];
  for (const root of roots) {
    files.push(`${root}/${SKILL_RECEIPT_FILENAME}`);
    for (const file of receipt.files) {
      files.push(`${root}/${file.path}`);
    }
  }
  return { roots: [...roots], files: files.sort() };
}

/** Whether a repository-relative path lies inside one of the owned roots. */
function isUnderOwnedRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** The receipt and manifest an install left in the worktree. */
export interface InstalledSkillArtifacts {
  receipt: SkillInstallReceipt;
  /** Null when the manifest is absent or fails validation; the PR degrades to receipt facts. */
  manifest: SkillManifest | null;
}

/**
 * Read what the install actually wrote, from the primary root.
 *
 * The receipt on disk — not the index row, not the Catalog — is the truth about
 * which roots and files this install owns (#1235), so the pathspec is derived
 * from it directly. A missing or invalid receipt means there is no owned set to
 * commit, which is a refusal rather than a guess.
 */
export function readInstalledSkillArtifacts(
  worktreePath: string,
  skillId: string
): InstalledSkillArtifacts {
  let installRoot: string;
  try {
    installRoot = resolveSkillInstallRoot(worktreePath, skillId);
  } catch {
    fail(SkillGitWorkflowErrorCode.RECEIPT_UNREADABLE, { skillId });
  }

  let receiptRaw: unknown;
  try {
    receiptRaw = JSON.parse(readFileSync(path.join(installRoot, SKILL_RECEIPT_FILENAME), 'utf8'));
  } catch {
    fail(SkillGitWorkflowErrorCode.RECEIPT_UNREADABLE, { skillId });
  }
  const receipt = validateSkillInstallReceipt(receiptRaw);
  if (!receipt.ok) {
    fail(SkillGitWorkflowErrorCode.RECEIPT_UNREADABLE, { skillId });
  }

  let manifest: SkillManifest | null = null;
  try {
    const parsed = parseSkillYaml(
      readFileSync(path.join(installRoot, SKILL_MANIFEST_FILENAME), 'utf8')
    );
    const validated = validateSkillManifest(parsed);
    manifest = validated.ok ? validated.value : null;
  } catch {
    // The PR body falls back to receipt-only facts; a manifest that no longer
    // parses must not block committing a payload that is already on disk.
    manifest = null;
  }

  return { receipt: receipt.value, manifest };
}

// =============================================================================
// Git reads
// =============================================================================

/** Split NUL-terminated git output into non-empty records. */
function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0);
}

/** Repository-relative paths currently staged (index vs HEAD). */
async function readStagedPaths(worktreePath: string): Promise<string[]> {
  const stdout = await execGitCommandTyped(
    ['diff', '--cached', '--name-only', '-z'],
    worktreePath,
    GIT_WRITE_TIMEOUT_MS
  );
  return splitNul(stdout);
}

/** Staged entries with their status letter, so deletions can be told from additions. */
async function readStagedNameStatus(
  worktreePath: string
): Promise<Array<{ status: string; path: string }>> {
  const stdout = await execGitCommandTyped(
    ['diff', '--cached', '--name-status', '-z'],
    worktreePath,
    GIT_WRITE_TIMEOUT_MS
  );
  // `-z` emits status and path as separate NUL-terminated records; a rename
  // emits status, old path, new path.
  const records = splitNul(stdout);
  const entries: Array<{ status: string; path: string }> = [];
  for (let i = 0; i < records.length; ) {
    const status = records[i];
    const isRename = status.startsWith('R') || status.startsWith('C');
    if (isRename) {
      // Both sides matter: the old path leaving the tree is as much a change as
      // the new one arriving, and both must be owned.
      if (records[i + 1] !== undefined) entries.push({ status: 'D', path: records[i + 1] });
      if (records[i + 2] !== undefined) entries.push({ status: 'A', path: records[i + 2] });
      i += 3;
    } else {
      if (records[i + 1] !== undefined) entries.push({ status, path: records[i + 1] });
      i += 2;
    }
  }
  return entries;
}

/** Whether a local branch already exists. */
async function localBranchExists(worktreePath: string, branch: string): Promise<boolean> {
  const result = await execGitCommand(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    worktreePath
  );
  return result !== null && result.length > 0;
}

/** Configured remote names. */
async function readRemotes(worktreePath: string): Promise<string[]> {
  const stdout = await execGitCommand(['remote'], worktreePath);
  if (stdout === null) return [];
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// =============================================================================
// Prepare
// =============================================================================

export interface SkillGitWorkflowPrepareInput {
  worktreePath: string;
  skillId: string;
  version: string;
  mode: SkillGitWorkflowMode;
  /**
   * Agent instance IDs with a live tmux session in this worktree.
   *
   * Resolved by the caller, which owns the session/DB layer. A non-empty list
   * blocks `dedicated_branch`: checking out under a running Agent would change
   * the tree beneath it.
   */
  activeSessions: readonly string[];
  /** Whether the caller intends to push, so a protected target fails before install. */
  push: boolean;
  remote?: string;
}

/** The Git target the Install Plan must then be built against. */
export interface SkillGitWorkflowTarget {
  mode: SkillGitWorkflowMode;
  /** Branch the commit will land on. */
  branch: string;
  /** Branch a PR would merge into: the branch we forked from, or the default. */
  baseBranch: string | null;
  /** HEAD at the moment the target was fixed. */
  headCommit: string;
  /** True when this call created and checked out {@link branch}. */
  branchCreated: boolean;
  remote: string;
}

/**
 * Fix the branch the install will be committed to.
 *
 * Runs *before* the Install Plan is generated. Any branch change belongs here:
 * once a plan exists it is bound to a branch and HEAD, and moving either
 * afterwards makes `SKILL_PLAN_STALE` the guaranteed outcome rather than the
 * exceptional one.
 *
 * `current_branch` inspects and validates; `dedicated_branch` additionally
 * creates the branch and switches to it. The switch is safe over a dirty working
 * tree because the new branch starts at the current HEAD, so no file content
 * changes — which is why it does not go through `checkoutBranch`, whose
 * clean-tree guard exists for switches *between* commits.
 */
export async function prepareSkillGitWorkflow(
  input: SkillGitWorkflowPrepareInput
): Promise<SkillGitWorkflowTarget> {
  const { worktreePath, skillId, version, mode, activeSessions } = input;
  const remote = input.remote ?? 'origin';

  const state = await readSkillGitTargetState(worktreePath);
  if (state.headState !== 'attached' || state.branch === null || state.headCommit === null) {
    fail(SkillGitWorkflowErrorCode.HEAD_UNSUPPORTED, { headState: state.headState });
  }

  // Nothing may be staged yet: the commit this workflow builds is defined by the
  // receipt, and an inherited staged change would ride along inside it.
  const staged = await readStagedPaths(worktreePath);
  if (staged.length > 0) {
    fail(SkillGitWorkflowErrorCode.INDEX_NOT_CLEAN, { stagedCount: staged.length });
  }

  if (input.push) {
    const remotes = await readRemotes(worktreePath);
    if (!remotes.includes(remote)) {
      fail(SkillGitWorkflowErrorCode.REMOTE_MISSING, { remote });
    }
  }

  const defaultBranch = await resolveDefaultBranchName(worktreePath);

  if (mode === 'current_branch') {
    // Committing here is fine; pushing the default branch is not, and finding
    // that out after the install would leave the user with a commit they cannot
    // publish the way they asked.
    if (input.push && defaultBranch !== null && defaultBranch === state.branch) {
      fail(SkillGitWorkflowErrorCode.PROTECTED_BRANCH, { branch: state.branch });
    }
    return {
      mode,
      branch: state.branch,
      baseBranch: defaultBranch,
      headCommit: state.headCommit,
      branchCreated: false,
      remote,
    };
  }

  if (activeSessions.length > 0) {
    fail(SkillGitWorkflowErrorCode.ACTIVE_SESSION, { sessionCount: activeSessions.length });
  }

  const branch = buildSkillInstallBranchName(skillId, version);
  if (await localBranchExists(worktreePath, branch)) {
    fail(SkillGitWorkflowErrorCode.BRANCH_EXISTS, { branch });
  }

  const baseBranch = state.branch;
  await createBranch(worktreePath, { name: branch, from: state.headCommit });
  await runSerializedWrite(worktreePath, async () => {
    await execGitCommandTyped(['switch', branch, '--'], worktreePath, GIT_WRITE_TIMEOUT_MS);
  });

  return {
    mode,
    branch,
    baseBranch,
    headCommit: state.headCommit,
    branchCreated: true,
    remote,
  };
}

// =============================================================================
// Prepared-target store
// =============================================================================

/** Token grammar; anything else is rejected before the store is consulted. */
export const SKILL_GIT_WORKFLOW_TOKEN_PATTERN = /^[0-9a-f]{48}$/;

/** How long a prepared target stays usable. Covers a download plus an install. */
export const SKILL_GIT_WORKFLOW_TTL_MS = 30 * 60 * 1000;

/** Bound on concurrently prepared targets. Oldest is evicted first. */
const SKILL_GIT_WORKFLOW_MAX_ENTRIES = 32;

interface StoredTarget {
  worktreeId: string;
  skillId: string;
  target: SkillGitWorkflowTarget;
  expiresAt: number;
}

/**
 * Prepared targets, held server-side.
 *
 * The apply request names a token, never a branch. A client that could send its
 * own branch could redirect the commit at a branch the user never approved,
 * which is the whole failure mode the prepare step exists to close.
 */
const preparedTargets = new Map<string, StoredTarget>();

function sweepPreparedTargets(now: number): void {
  for (const [token, entry] of preparedTargets) {
    if (entry.expiresAt <= now) preparedTargets.delete(token);
  }
  while (preparedTargets.size >= SKILL_GIT_WORKFLOW_MAX_ENTRIES) {
    const oldest = preparedTargets.keys().next();
    if (oldest.done) break;
    preparedTargets.delete(oldest.value);
  }
}

/** Store a prepared target and return the token that spends it. */
export function issueSkillGitWorkflowToken(
  worktreeId: string,
  skillId: string,
  target: SkillGitWorkflowTarget
): string {
  const now = Date.now();
  sweepPreparedTargets(now);
  const token = randomBytes(24).toString('hex');
  preparedTargets.set(token, {
    worktreeId,
    skillId,
    target,
    expiresAt: now + SKILL_GIT_WORKFLOW_TTL_MS,
  });
  return token;
}

/**
 * Read a prepared target back.
 *
 * Not single-use: applying is retryable by design (a failed push must be
 * repeatable without re-preparing, which would try to create the branch again),
 * so the token survives until its TTL. It is still bound to the worktree and
 * Skill it was issued for.
 */
export function consumeSkillGitWorkflowTarget(
  token: string,
  binding: { worktreeId: string; skillId: string }
): SkillGitWorkflowTarget {
  if (!SKILL_GIT_WORKFLOW_TOKEN_PATTERN.test(token)) {
    fail(SkillGitWorkflowErrorCode.TARGET_DRIFTED, { reason: 'unknown_token' });
  }
  const entry = preparedTargets.get(token);
  if (
    entry === undefined ||
    entry.expiresAt <= Date.now() ||
    entry.worktreeId !== binding.worktreeId ||
    entry.skillId !== binding.skillId
  ) {
    preparedTargets.delete(token);
    fail(SkillGitWorkflowErrorCode.TARGET_DRIFTED, { reason: 'unknown_token' });
  }
  return entry.target;
}

/** Drop every prepared target. Test-only. */
export function resetSkillGitWorkflowTargetsForTesting(): void {
  preparedTargets.clear();
}

// =============================================================================
// Commit message
// =============================================================================

/**
 * Commit message for one Skill install.
 *
 * Carries the three coordinates that make the commit auditable without the
 * artifact in hand: the Skill and version, the source commit the package was
 * built from, and the artifact digest that was verified before anything was
 * written. Every root the payload landed in is listed, so a reader can tell a
 * dual-root install from a legacy single-root one.
 */
export function buildSkillInstallCommitMessage(receipt: SkillInstallReceipt): string {
  const roots = receiptInstallRoots(receipt);
  return [
    `feat(skills): install ${receipt.skill_id} v${receipt.version}`,
    '',
    `Skill: ${receipt.skill_id}`,
    `Version: ${receipt.version}`,
    `Source: ${receipt.source.repository}@${receipt.source.ref}`,
    `Source commit: ${receipt.source.commit}`,
    `Artifact SHA-256: ${receipt.artifact.sha256}`,
    `Effective risk: ${receipt.effective_risk}`,
    `Install roots: ${roots.join(', ')}`,
  ].join('\n');
}

// =============================================================================
// Pull request body
// =============================================================================

/** Optional verification the caller can attach, e.g. the targeted test run. */
export interface SkillPullRequestValidation {
  /** Short label, e.g. `npm run test:unit`. */
  label: string;
  /** Outcome as the caller observed it. */
  outcome: 'passed' | 'failed' | 'skipped';
}

export interface SkillPullRequestBodyInput {
  receipt: SkillInstallReceipt;
  /** Installed manifest, when it could be read: supplies the capability wording. */
  manifest: SkillManifest | null;
  target: SkillGitWorkflowTarget;
  /** Repository-relative paths the commit touches. */
  changedPaths: readonly string[];
  validations?: readonly SkillPullRequestValidation[];
}

const RISK_LABELS: Record<SkillRiskLevel, string> = {
  low: 'low（低）',
  moderate: 'moderate（中）',
  high: 'high（高）',
};

/**
 * Scrub one free-text field before it reaches the PR body.
 *
 * Applied per field rather than to the assembled body, because the shared
 * redactor also truncates at {@link SKILL_REDACTED_TEXT_MAX_LENGTH} — a bound
 * meant for a log line, which would silently cut a PR body off mid-section and
 * take the provenance block with it.
 */
function scrub(value: string): string {
  return redactSkillOperationText(value);
}

function bulletList(items: readonly string[], empty: string): string {
  if (items.length === 0) return empty;
  return items.map((item) => `- ${scrub(item)}`).join('\n');
}

/** PR title. Follows the repository's `<type>: <description>` rule. */
export function buildSkillInstallPullRequestTitle(receipt: SkillInstallReceipt): string {
  return `feat: install Skill ${receipt.skill_id} v${receipt.version}`;
}

/**
 * PR body a reviewer can decide from without leaving the page.
 *
 * Contains what the Skill lets you do, what it declares it needs, where the
 * bytes came from, the digests that were checked, and the exact file list. It
 * deliberately contains no diff *content*: a payload hunk in a PR body would
 * republish whatever the package carries into a place the review UI renders,
 * and the file list plus digests already identify the change. Every path it
 * names is repository-relative by construction, and each publisher-controlled
 * free-text field is scrubbed on the way in, so a token or a home directory
 * smuggled through a manifest string does not reach the PR.
 */
export function buildSkillInstallPullRequestBody(input: SkillPullRequestBodyInput): string {
  const { receipt, manifest, target, changedPaths } = input;
  const roots = receiptInstallRoots(receipt);
  const scripts = receipt.files.filter((file) => file.executable).map((file) => file.path);
  const manifestScripts =
    manifest?.files.filter((file) => file.script).map((file) => file.path) ?? [];
  const allScripts = [...new Set([...scripts, ...manifestScripts])].sort();

  const sections: string[] = [];

  sections.push(
    [
      '## 導入するSkill',
      '',
      `- **Skill**: ${scrub(manifest?.name ?? receipt.skill_id)} (\`${receipt.skill_id}\`)`,
      `- **バージョン**: ${receipt.version}`,
      `- **提供元**: ${scrub(manifest?.provider.name ?? '（manifest未読み取り）')}`,
      manifest ? `- **概要**: ${scrub(manifest.summary)}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n')
  );

  sections.push(
    ['## できるようになること', '', bulletList(manifest?.capabilities ?? [], '- （manifestを読み取れませんでした）')].join('\n')
  );

  if (manifest && manifest.expected_outcomes.length > 0) {
    sections.push(['## 期待効果', '', bulletList(manifest.expected_outcomes, '')].join('\n'));
  }

  sections.push(
    [
      '## リスクと権限',
      '',
      `- **宣言リスク**: ${RISK_LABELS[receipt.declared_risk]}`,
      `- **算出リスク**: ${RISK_LABELS[receipt.computed_risk]}`,
      `- **実効リスク**: ${RISK_LABELS[receipt.effective_risk]}`,
      manifest ? `- **リスク根拠**: ${scrub(manifest.risk_rationale)}` : null,
      '',
      '**宣言された権限**（宣言であり強制ではありません）',
      '',
      bulletList(receipt.declared_permissions, '- なし'),
      '',
      '**スクリプト**',
      '',
      bulletList(allScripts, '- なし'),
    ]
      .filter((line): line is string => line !== null)
      .join('\n')
  );

  sections.push(
    [
      '## 提供元と検証',
      '',
      `- **リポジトリ**: ${receipt.source.repository}`,
      `- **ref**: ${receipt.source.ref}`,
      `- **source commit**: \`${receipt.source.commit}\``,
      `- **アーティファクト**: ${receipt.artifact.asset_name} (${receipt.artifact.format}, ${receipt.artifact.size} bytes)`,
      `- **artifact SHA-256**: \`${receipt.artifact.sha256}\``,
      '',
      'インストール前に artifact のダイジェストとパッケージ構造を検証済みです。パッケージ内のスクリプトは導入時に実行されません。',
    ].join('\n')
  );

  const validationLines = (input.validations ?? []).map(
    (validation) => `${validation.label}: ${validation.outcome}`
  );
  sections.push(
    [
      '## テスト結果',
      '',
      bulletList(validationLines, '- 自動テストは実行していません（導入操作のみ）'),
    ].join('\n')
  );

  sections.push(
    [
      '## 差分サマリ',
      '',
      `- **ブランチ**: \`${target.branch}\`${target.baseBranch ? ` ← base \`${target.baseBranch}\`` : ''}`,
      `- **導入先**: ${roots.map((root) => `\`${root}\``).join(', ')}`,
      `- **変更ファイル数**: ${changedPaths.length}`,
      '',
      bulletList(
        // Scrubbed before the backticks go on: the redactor anchors on a
        // whitespace/quote boundary, which a leading backtick is not.
        changedPaths.map((changed) => `\`${scrub(changed)}\``),
        '- （変更なし）'
      ),
    ].join('\n')
  );

  sections.push(
    [
      '## Agent互換性',
      '',
      bulletList(
        receipt.agent_compatibility.map(
          (entry) => `${entry.agent}: ${entry.support}${entry.evidence ? ` — ${entry.evidence}` : ''}`
        ),
        '- 情報なし'
      ),
    ].join('\n')
  );

  const body = sections.join('\n\n');
  return body.length > PR_BODY_MAX_LENGTH ? `${body.slice(0, PR_BODY_MAX_LENGTH)}\n…` : body;
}

// =============================================================================
// Apply
// =============================================================================

export interface SkillGitWorkflowApplyInput {
  worktreePath: string;
  target: SkillGitWorkflowTarget;
  receipt: SkillInstallReceipt;
  manifest: SkillManifest | null;
  push: boolean;
  createPullRequest: boolean;
  validations?: readonly SkillPullRequestValidation[];
}

/** What actually happened, stage by stage, so a partial run is legible. */
export interface SkillGitWorkflowOutcome {
  branch: string;
  baseBranch: string | null;
  /** Repository-relative paths the commit contains. */
  changedPaths: string[];
  /** False when the owned paths were already committed (a retry). */
  committed: boolean;
  commitSha: string;
  pushed: boolean;
  pullRequestUrl: string | null;
  /** True when an open PR for this branch already existed. */
  pullRequestExisted: boolean;
}

/**
 * Commit the installed payload, then optionally push and open a draft PR.
 *
 * Safe to retry. Each stage is a no-op when it already happened: an empty staged
 * set means the commit is in, a push of an unchanged branch succeeds trivially,
 * and an existing open PR is returned rather than duplicated. That is what lets
 * "installed but not committed", "committed but not pushed" and "pushed but no
 * PR" be distinct, recoverable states instead of one opaque failure.
 */
export async function applySkillGitWorkflow(
  input: SkillGitWorkflowApplyInput
): Promise<SkillGitWorkflowOutcome> {
  const { worktreePath, target, receipt } = input;
  const owned = resolveSkillOwnedPaths(receipt);
  const ownedFiles = new Set(owned.files);

  const state = await readSkillGitTargetState(worktreePath);
  if (state.headState !== 'attached' || state.branch === null || state.headCommit === null) {
    fail(SkillGitWorkflowErrorCode.HEAD_UNSUPPORTED, { headState: state.headState });
  }
  // HEAD may legitimately have moved (a retry after a successful commit), but the
  // branch may not: committing onto a branch the user did not approve is exactly
  // what the prepare step exists to prevent.
  if (state.branch !== target.branch) {
    fail(SkillGitWorkflowErrorCode.TARGET_DRIFTED, {
      expected: target.branch,
      actual: state.branch,
    });
  }

  // Unlike prepare, a staged *owned* path is expected here: a retry after a
  // failed commit leaves exactly that. Anything else still stops the run.
  const preexisting = await readStagedPaths(worktreePath);
  const foreign = preexisting.filter((path) => !isUnderOwnedRoot(path, owned.roots));
  if (foreign.length > 0) {
    fail(SkillGitWorkflowErrorCode.INDEX_NOT_CLEAN, { stagedCount: foreign.length });
  }

  await stageFiles(worktreePath, owned.roots);

  const entries = await readStagedNameStatus(worktreePath);
  for (const entry of entries) {
    if (!isUnderOwnedRoot(entry.path, owned.roots)) {
      fail(SkillGitWorkflowErrorCode.UNOWNED_STAGED_PATH, { path: entry.path });
    }
    // A deletion inside an owned root is a stale file from an earlier version
    // going away, which the current receipt cannot list. Additions and
    // modifications must be accounted for.
    if (entry.status !== 'D' && !ownedFiles.has(entry.path)) {
      fail(SkillGitWorkflowErrorCode.UNOWNED_STAGED_PATH, { path: entry.path });
    }
  }

  const changedPaths = entries.map((entry) => entry.path).sort();
  let committed = false;
  if (changedPaths.length > 0) {
    try {
      await gitCommit(worktreePath, buildSkillInstallCommitMessage(receipt), false);
      committed = true;
    } catch (error) {
      if (!(error instanceof GitNothingToCommitError)) throw error;
    }
  }

  const commitSha =
    (await execGitCommand(['rev-parse', 'HEAD'], worktreePath)) ?? state.headCommit;

  const outcome: SkillGitWorkflowOutcome = {
    branch: target.branch,
    baseBranch: target.baseBranch,
    changedPaths,
    committed,
    commitSha,
    pushed: false,
    pullRequestUrl: null,
    pullRequestExisted: false,
  };

  if (!input.push) return outcome;

  const defaultBranch = await resolveDefaultBranchName(worktreePath);
  if (defaultBranch !== null && defaultBranch === target.branch) {
    fail(SkillGitWorkflowErrorCode.PROTECTED_BRANCH, { branch: target.branch });
  }
  const remotes = await readRemotes(worktreePath);
  if (!remotes.includes(target.remote)) {
    fail(SkillGitWorkflowErrorCode.REMOTE_MISSING, { remote: target.remote });
  }

  try {
    // No force, ever: this workflow only ever adds a commit to a branch it owns
    // or the user explicitly chose.
    await gitPush(worktreePath, {
      remote: target.remote,
      branch: target.branch,
      setUpstream: true,
    });
  } catch (error) {
    logger.warn('skill-git-push-failed', {
      branch: target.branch,
      error: redactSkillOperationText(messageOf(error)),
    });
    fail(SkillGitWorkflowErrorCode.PUSH_FAILED, { branch: target.branch });
  }
  outcome.pushed = true;

  if (!input.createPullRequest) return outcome;

  const existing = await findOpenPullRequest(worktreePath, target.branch);
  if (existing !== null) {
    outcome.pullRequestUrl = existing;
    outcome.pullRequestExisted = true;
    return outcome;
  }

  const created = await createDraftPullRequest({
    worktreePath,
    head: target.branch,
    base: target.baseBranch,
    title: buildSkillInstallPullRequestTitle(receipt),
    body: buildSkillInstallPullRequestBody({
      receipt,
      manifest: input.manifest,
      target,
      changedPaths,
      validations: input.validations,
    }),
  });
  if (!created.ok) {
    logger.warn('skill-git-pr-create-failed', {
      branch: target.branch,
      reason: created.reason,
      error: redactSkillOperationText(created.detail),
    });
    fail(
      created.reason === 'tool_missing'
        ? SkillGitWorkflowErrorCode.PR_TOOL_MISSING
        : SkillGitWorkflowErrorCode.PR_FAILED,
      { branch: target.branch }
    );
  }
  outcome.pullRequestUrl = created.url;
  return outcome;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
