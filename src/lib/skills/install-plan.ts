/**
 * Install Plan: a time-boxed, single-use commitment to one exact install (Issue #1233)
 *
 * A plan freezes everything apply is allowed to act on — the resolved worktree,
 * the live branch and HEAD, the verified artifact snapshot, the exact receipt
 * bytes and the tree hash of the destination — and hands back an opaque token.
 * Apply presents the token, the server re-reads the same facts, and any
 * divergence is `SKILL_PLAN_STALE` rather than a write against a directory that
 * has moved on. The client therefore has nothing it could restate and have
 * honoured: not a path, not a URL, not a file list.
 *
 * Why the state is server-side rather than a signed blob: the plan carries the
 * diff bodies, which must not be persisted, and the token must be usable
 * exactly once. Both are properties of a store, not of a token format, and a
 * random opaque key into that store is what makes the token tamper-proof — it
 * encodes nothing an attacker could rewrite.
 *
 * Apply itself is #1235. This module defines the contract it must satisfy.
 *
 * @module lib/skills/install-plan
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type {
  SkillAgentCompatibility,
  SkillCatalogVersion,
  SkillDeclaredPermission,
  SkillInstallReceipt,
  SkillInstalledFile,
  SkillRiskLevel,
} from '@/types/skills';
import type { SkillPackageSnapshot } from '@/lib/skills/package-validator';
import type { SkillCommandMateCompatibility } from '@/lib/skills/compatibility';
import { canonicalizeSkillReceipt } from '@/lib/skills/schema';
import {
  SKILL_INSTALL_ROOT_PREFIX,
  SKILL_SCHEMA_VERSION,
} from '@/lib/skills/constants';
import { releaseSkillSnapshot } from '@/lib/skills/snapshot-store';
import {
  buildSkillPreviewDiff,
  findGitIgnoredPaths,
  readExistingSkillTree,
  readSkillGitTargetState,
  resolveSkillInstallRootFor,
  skillInstallRootFor,
  type SkillDiffEntry,
  type SkillDiffStats,
  type SkillGitTargetState,
  type SkillPlannedFile,
  type SkillPreviewWarningCode,
} from '@/lib/skills/preview-diff';

// =============================================================================
// Layout and limits
// =============================================================================

/**
 * Receipt filename inside the install root.
 *
 * Dot-prefixed so it falls outside the Skill ID grammar and can never be
 * mistaken for a Skill directory by Agent discovery.
 */
export const SKILL_RECEIPT_FILENAME = '.commandmate-receipt.json';

/** How long a plan stays usable. Short enough that drift is the exception. */
export const SKILL_PLAN_TTL_MS = 10 * 60 * 1000;

/** Maximum plans held at once. Oldest is evicted first. */
export const SKILL_PLAN_MAX_ENTRIES = 32;

/** Bytes of plan token entropy. */
const SKILL_PLAN_TOKEN_BYTES = 24;

/** Token grammar. Anything else is rejected before the store is consulted. */
export const SKILL_PLAN_TOKEN_PATTERN = /^[0-9a-f]{48}$/;

// =============================================================================
// Errors
// =============================================================================

/** Client-safe reasons a plan cannot be created, read or applied. */
export const SkillPlanErrorCode = {
  /** No plan is stored for this token, or it was already evicted. */
  NOT_FOUND: 'SKILL_PLAN_NOT_FOUND',
  /** The plan existed but its expiry has passed. */
  EXPIRED: 'SKILL_PLAN_EXPIRED',
  /** The plan was already applied. Tokens are single-use. */
  CONSUMED: 'SKILL_PLAN_CONSUMED',
  /** Branch, HEAD or the destination tree changed since the plan was built. */
  STALE: 'SKILL_PLAN_STALE',
  /** The token was presented for a different actor, operation, target or version. */
  BINDING_MISMATCH: 'SKILL_PLAN_BINDING_MISMATCH',
  /** The plan describes writes that would overwrite content CommandMate does not manage. */
  NOT_INSTALLABLE: 'SKILL_PLAN_NOT_INSTALLABLE',
  /** Effective risk is high and the request did not acknowledge it. */
  RISK_NOT_ACKNOWLEDGED: 'SKILL_PLAN_RISK_NOT_ACKNOWLEDGED',
  /** The install root could not be resolved inside the worktree. */
  TARGET_UNSAFE: 'SKILL_PLAN_TARGET_UNSAFE',
} as const;

export type SkillPlanErrorCodeType = (typeof SkillPlanErrorCode)[keyof typeof SkillPlanErrorCode];

/** HTTP status each reason maps to, so every route answers alike. */
export const SKILL_PLAN_ERROR_STATUS: Record<SkillPlanErrorCodeType, number> = {
  [SkillPlanErrorCode.NOT_FOUND]: 404,
  [SkillPlanErrorCode.EXPIRED]: 410,
  [SkillPlanErrorCode.CONSUMED]: 409,
  [SkillPlanErrorCode.STALE]: 409,
  [SkillPlanErrorCode.BINDING_MISMATCH]: 409,
  [SkillPlanErrorCode.NOT_INSTALLABLE]: 409,
  [SkillPlanErrorCode.RISK_NOT_ACKNOWLEDGED]: 409,
  [SkillPlanErrorCode.TARGET_UNSAFE]: 400,
};

/** A plan rejection. Message is built from the code only — never from a path. */
export class SkillPlanError extends Error {
  constructor(
    readonly code: SkillPlanErrorCodeType,
    readonly detail?: Record<string, string | number | boolean>
  ) {
    super(`Skill install plan rejected: ${code}`);
    this.name = 'SkillPlanError';
  }

  get status(): number {
    return SKILL_PLAN_ERROR_STATUS[this.code];
  }
}

export function isSkillPlanError(value: unknown): value is SkillPlanError {
  return value instanceof SkillPlanError;
}

// =============================================================================
// Binding
// =============================================================================

/** Who asked. Mirrors the audit actor (#1234); carries no credential material. */
export interface SkillPlanActor {
  type: 'user' | 'cli' | 'system';
  /** Stable identifier from the auth context, or null for the shared local token. */
  id: string | null;
}

/**
 * Everything a token is bound to.
 *
 * Presenting the token for any other combination is `BINDING_MISMATCH`, so a
 * token leaked from one worktree cannot install into another, and a token
 * issued for 1.2.0 cannot apply 1.3.0.
 */
export interface SkillPlanBinding {
  actor: SkillPlanActor;
  operation: 'install';
  worktreeId: string;
  skillId: string;
  version: string;
  /** Lowercase hex SHA-256 of the artifact the plan was computed from. */
  artifactSha256: string;
  /** Verified read-only artifact snapshot the bytes came from. */
  snapshotId: string;
  branch: string | null;
  headCommit: string | null;
  currentTreeHash: string;
  plannedTreeHash: string;
  /** Digest of the exact receipt bytes the plan fixed. */
  receiptDigest: string;
  riskAcknowledged: boolean;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Digest of a binding, used to compare two of them without leaking either. */
export function computeSkillPlanBindingHash(binding: SkillPlanBinding): string {
  return createHash('sha256').update(canonicalJson(binding)).digest('hex');
}

// =============================================================================
// Receipt
// =============================================================================

/** Inputs the deterministic receipt is derived from. */
export interface SkillReceiptInput {
  snapshot: SkillPackageSnapshot;
  version: SkillCatalogVersion;
  /**
   * Root prefixes the package is placed into, primary first (#1460), e.g.
   * `['.agents/skills', '.claude/skills']`. Defaults to the single primary root,
   * which omits `install_roots` from the receipt so a single-root install stays
   * byte-identical to a pre-#1460 one.
   */
  rootPrefixes?: readonly string[];
}

/**
 * The roots a receipt records, primary first (#1460).
 *
 * A pre-#1460 receipt has no `install_roots`; it is read as the single root it
 * names in `install_root`.
 */
export function receiptInstallRoots(receipt: SkillInstallReceipt): string[] {
  return receipt.install_roots && receipt.install_roots.length > 0
    ? [...receipt.install_roots]
    : [receipt.install_root];
}

/**
 * Build the receipt this install would leave behind.
 *
 * Deterministic by construction: no timestamp, no actor, no absolute path and
 * no artifact URL. That is what lets the exact bytes be fixed at plan time and
 * diffed like any other file, instead of appearing out of nowhere at apply.
 */
export function buildSkillInstallReceipt(input: SkillReceiptInput): SkillInstallReceipt {
  const { snapshot, version } = input;
  const files: SkillInstalledFile[] = snapshot.files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    size: file.size,
    executable: file.executable,
  }));
  const agents: SkillAgentCompatibility[] = version.compatibility.agents.map((agent) => ({
    agent: agent.agent,
    support: agent.support,
    evidence: agent.evidence,
  }));

  // Primary first; the primary root stays `install_root` for backward
  // compatibility. `install_roots` is recorded only for a genuine multi-root
  // install (#1460) so a single-root receipt is byte-identical to a pre-#1460 one.
  const rootPrefixes =
    input.rootPrefixes && input.rootPrefixes.length > 0
      ? [...input.rootPrefixes]
      : [SKILL_INSTALL_ROOT_PREFIX];
  const installRoots = rootPrefixes.map((prefix) => skillInstallRootFor(prefix, snapshot.skillId));

  return {
    schema_version: SKILL_SCHEMA_VERSION,
    skill_id: snapshot.skillId,
    version: snapshot.version,
    install_root: installRoots[0],
    ...(installRoots.length > 1 ? { install_roots: installRoots } : {}),
    source: {
      repository: version.source.repository,
      ref: version.source.ref,
      commit: version.source.commit,
    },
    artifact: {
      asset_name: version.artifact.asset_name,
      sha256: version.artifact.sha256,
      size: version.artifact.size,
      format: version.artifact.format,
    },
    files,
    declared_risk: snapshot.declaredRisk,
    computed_risk: snapshot.computedRisk,
    effective_risk: snapshot.effectiveRisk,
    declared_permissions: [...snapshot.inspection.declared_permissions],
    agent_compatibility: agents,
  };
}

/** The exact bytes the receipt file would contain. */
export function serializeSkillInstallReceipt(receipt: SkillInstallReceipt): Uint8Array {
  return Buffer.from(canonicalizeSkillReceipt(receipt), 'utf-8');
}

/** Parse a receipt found in a worktree. Returns null for anything unreadable. */
export function parseInstalledReceipt(bytes: Uint8Array): SkillInstallReceipt | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<SkillInstallReceipt>;
    if (typeof candidate.skill_id !== 'string' || !Array.isArray(candidate.files)) return null;
    return candidate as SkillInstallReceipt;
  } catch {
    return null;
  }
}

// =============================================================================
// Plan shape
// =============================================================================

/** The install target, described without a machine-absolute path. */
export interface SkillPlanTargetDto {
  worktreeId: string;
  worktreeName: string;
  repositoryName: string;
  /** Branch snapshot recorded at worktree sync time; may lag the live branch. */
  syncedBranch: string | null;
  /** Live branch, or null when HEAD is detached or unresolved. */
  branch: string | null;
  headState: SkillGitTargetState['headState'];
  headCommit: string | null;
  workingTreeDirty: boolean;
  /** Repository-relative primary install root (`.agents/skills/<id>`). */
  installRoot: string;
  /** Every repository-relative root the package will be placed into, primary first (#1460). */
  installRoots: string[];
  currentTreeHash: string;
  plannedTreeHash: string;
  /** Version and receipt digest of an install already present, if any. */
  existingInstall: { version: string; receiptDigest: string } | null;
}

/**
 * What the package declares and what inspection computed.
 *
 * These are exactly the fields the Catalog cannot supply, which the Catalog UI
 * (#1232) currently renders as "not available until the package is downloaded".
 * A plan is the first point they exist, so they are served here.
 */
export interface SkillPlanSkillDto {
  id: string;
  name: string;
  version: string;
  summary: string;
  description: string;
  capabilities: string[];
  expectedOutcomes: string[];
  provider: { name: string; url?: string; contact?: string };
  license: string;
  homepage: string | null;
  declaredPermissions: SkillDeclaredPermission[];
  requirements: {
    commands: Array<{ name: string; versionRange: string | null }>;
    networkHosts: string[];
  };
  declaredRisk: SkillRiskLevel;
  computedRisk: SkillRiskLevel;
  effectiveRisk: SkillRiskLevel;
  riskRationale: string;
  executablePaths: string[];
  scriptPaths: string[];
  compatibility: {
    commandmate: SkillCommandMateCompatibility;
    agents: SkillAgentCompatibility[];
  };
  source: { repository: string; ref: string; commit: string };
  /** Artifact identity without its URL, matching the receipt's omission. */
  artifact: { assetName: string; sha256: string; size: number; format: string };
}

/** The plan as served to a client. Contains no path outside the repository. */
export interface SkillInstallPlanDto {
  token: string;
  /** RFC 3339 UTC instant after which the token is refused. */
  expiresAt: string;
  /** No conflicting or unmanaged file stands in the way. */
  installable: boolean;
  /** Effective risk is high, so apply requires an explicit acknowledgement. */
  requiresRiskAcknowledgement: boolean;
  riskAcknowledged: boolean;
  /** i18n key for the extra confirmation shown before a high-risk apply. */
  riskAcknowledgementMessageKey: string | null;
  blockers: Array<{ code: string; path: string | null }>;
  warnings: SkillPreviewWarningCode[];
  target: SkillPlanTargetDto;
  skill: SkillPlanSkillDto;
  receipt: {
    path: string;
    sha256: string;
    size: number;
  };
  files: SkillDiffEntry[];
  stats: SkillDiffStats;
}

/** Server-side plan record. Never serialized. */
export interface SkillInstallPlanRecord {
  token: string;
  binding: SkillPlanBinding;
  bindingHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  /** Server-resolved worktree path. Apply's only source of truth for where to write. */
  worktreePath: string;
  /** Root prefixes apply must write, primary first (#1460). */
  rootPrefixes: string[];
  receipt: SkillInstallReceipt;
  receiptBytes: Uint8Array;
  dto: SkillInstallPlanDto;
}

// =============================================================================
// Plan cache
// =============================================================================

interface PlanCacheState {
  records: Map<string, SkillInstallPlanRecord>;
}

declare global {
  // eslint-disable-next-line no-var -- globalThis cache pattern for hot-reload persistence (snapshot-store.ts precedent)
  var __skillInstallPlans: PlanCacheState | undefined;
}

const cache: PlanCacheState =
  globalThis.__skillInstallPlans ?? (globalThis.__skillInstallPlans = { records: new Map() });

function dropRecord(record: SkillInstallPlanRecord): void {
  cache.records.delete(record.token);
  // The snapshot reference was taken for this plan; an unconsumed plan must not
  // pin artifact bytes past its own lifetime.
  if (record.consumedAt === null) releaseSkillSnapshot(record.binding.snapshotId);
}

/**
 * Drop every expired plan, releasing the snapshot each one pinned.
 *
 * @param keep Token to leave in place so its own lookup can still answer
 *   `EXPIRED` rather than the ambiguous `NOT_FOUND`
 * @returns Number of plans dropped
 */
function sweepExpired(now: number, keep?: string): number {
  let dropped = 0;
  for (const record of [...cache.records.values()]) {
    if (record.token !== keep && now >= record.expiresAt) {
      dropRecord(record);
      dropped += 1;
    }
  }
  return dropped;
}

function sweep(now: number): void {
  sweepExpired(now);
  while (cache.records.size >= SKILL_PLAN_MAX_ENTRIES) {
    const oldest = [...cache.records.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    dropRecord(oldest);
  }
}

/**
 * Reclaim expired plans without creating one.
 *
 * Creating a plan is not the only thing that should free a snapshot: a plan
 * left unapplied would otherwise pin its artifact bytes for the life of the
 * process. Called from every token access and from the background sweeper.
 *
 * @returns Number of plans dropped
 */
export function sweepSkillInstallPlans(options: { now?: number } = {}): number {
  return sweepExpired(options.now ?? Date.now());
}

/**
 * Look a token up without spending it.
 *
 * The token is compared in constant time against the stored value: the map
 * lookup already leaks nothing (the key is the token), but the equality check
 * keeps the pattern honest for callers that re-verify.
 */
function requireRecord(token: string, now: number): SkillInstallPlanRecord {
  if (!SKILL_PLAN_TOKEN_PATTERN.test(token)) {
    throw new SkillPlanError(SkillPlanErrorCode.NOT_FOUND);
  }
  const record = cache.records.get(token);
  // Every token access reclaims the siblings that expired meanwhile, so a plan
  // nobody applies is not held until the next plan is created.
  sweepExpired(now, token);
  if (!record) throw new SkillPlanError(SkillPlanErrorCode.NOT_FOUND);

  const presented = Buffer.from(token, 'utf-8');
  const stored = Buffer.from(record.token, 'utf-8');
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    throw new SkillPlanError(SkillPlanErrorCode.NOT_FOUND);
  }
  if (now >= record.expiresAt) {
    dropRecord(record);
    throw new SkillPlanError(SkillPlanErrorCode.EXPIRED);
  }
  if (record.consumedAt !== null) throw new SkillPlanError(SkillPlanErrorCode.CONSUMED);
  return record;
}

/** Read a stored plan. Does not spend the token. */
export function getSkillInstallPlan(
  token: string,
  options: { now?: number } = {}
): SkillInstallPlanRecord {
  return requireRecord(token, options.now ?? Date.now());
}

/** Facts apply must observe again before it is allowed to write. */
export interface SkillPlanObservation {
  branch: string | null;
  headCommit: string | null;
  currentTreeHash: string;
}

/**
 * Reject a plan whose world moved.
 *
 * Branch, HEAD and the destination tree are all re-read by the caller; any one
 * of them differing means the preview the user approved no longer describes
 * what would happen.
 */
export function assertSkillPlanCurrent(
  record: SkillInstallPlanRecord,
  observed: SkillPlanObservation
): void {
  const { binding } = record;
  if (
    observed.branch !== binding.branch ||
    observed.headCommit !== binding.headCommit ||
    observed.currentTreeHash !== binding.currentTreeHash
  ) {
    throw new SkillPlanError(SkillPlanErrorCode.STALE);
  }
}

/**
 * Spend a token.
 *
 * Binding equality is checked before staleness so a token presented for the
 * wrong target is never told anything about the right one. The record is marked
 * consumed rather than deleted, so a replay is answered `CONSUMED` instead of
 * the ambiguous `NOT_FOUND`.
 *
 * The caller inherits the artifact snapshot reference and must release it.
 */
export function consumeSkillInstallPlan(
  token: string,
  expected: {
    actor: SkillPlanActor;
    worktreeId: string;
    skillId: string;
    version: string;
    riskAcknowledged: boolean;
  },
  observed: SkillPlanObservation,
  options: { now?: number } = {}
): SkillInstallPlanRecord {
  const now = options.now ?? Date.now();
  const record = requireRecord(token, now);
  const { binding } = record;

  const sameActor =
    binding.actor.type === expected.actor.type && binding.actor.id === expected.actor.id;
  if (
    !sameActor ||
    binding.worktreeId !== expected.worktreeId ||
    binding.skillId !== expected.skillId ||
    binding.version !== expected.version
  ) {
    throw new SkillPlanError(SkillPlanErrorCode.BINDING_MISMATCH);
  }
  if (!record.dto.installable) throw new SkillPlanError(SkillPlanErrorCode.NOT_INSTALLABLE);
  if (record.dto.requiresRiskAcknowledgement && !expected.riskAcknowledged) {
    throw new SkillPlanError(SkillPlanErrorCode.RISK_NOT_ACKNOWLEDGED);
  }

  assertSkillPlanCurrent(record, observed);

  record.consumedAt = now;
  return record;
}

/** Drop a plan and release its artifact reference. Safe to call twice. */
export function discardSkillInstallPlan(token: string): void {
  const record = cache.records.get(token);
  if (record) dropRecord(record);
}

/** @internal */
export function resetSkillInstallPlanCacheForTesting(): void {
  cache.records.clear();
}

/** @internal Number of plans currently held. */
export function getSkillInstallPlanCount(): number {
  return cache.records.size;
}

// =============================================================================
// Plan construction
// =============================================================================

/** i18n key for the extra confirmation a high-risk install requires. */
export const SKILL_PLAN_HIGH_RISK_MESSAGE_KEY = 'skills.plan.highRiskAcknowledgement';

/** Everything the plan builder needs. All of it server-resolved. */
export interface CreateSkillInstallPlanInput {
  actor: SkillPlanActor;
  worktree: {
    id: string;
    name: string;
    /** Server-resolved absolute path from the worktree row. Never client-supplied. */
    path: string;
    repositoryName: string;
    /** Branch recorded at the last worktree sync. */
    syncedBranch: string | null;
  };
  snapshot: SkillPackageSnapshot;
  /** Catalog version the artifact was published under. */
  version: SkillCatalogVersion;
  /** Snapshot ID the verified artifact bytes are stored under (#1229). */
  snapshotId: string;
  compatibility: SkillCommandMateCompatibility;
  /** The request already acknowledged a high effective risk. */
  riskAcknowledged?: boolean;
  /**
   * Root prefixes to place the package into, primary first (#1460). Defaults to
   * the single primary root; the route passes the full product set so a user
   * install lands in both `.agents/skills` and `.claude/skills`.
   */
  targets?: readonly string[];
  now?: number;
}

/**
 * Build a plan and register it under a fresh token.
 *
 * The order matters: the receipt bytes are fixed first, so the receipt takes
 * part in the inventory, in the virtual diff and in the planned tree hash like
 * any other file. A receipt that only materialized at apply time would be a
 * write the user never previewed.
 */
export async function createSkillInstallPlan(
  input: CreateSkillInstallPlanInput
): Promise<SkillInstallPlanRecord> {
  const now = input.now ?? Date.now();
  const { snapshot } = input;

  const rootPrefixes =
    input.targets && input.targets.length > 0
      ? [...input.targets]
      : [SKILL_INSTALL_ROOT_PREFIX];

  // Every root's absolute path is derived and containment-checked up front, so a
  // malformed target fails the plan before any tree is read (#1460).
  let rootTargets: Array<{ prefix: string; abs: string; rel: string }>;
  try {
    rootTargets = rootPrefixes.map((prefix) => ({
      prefix,
      abs: resolveSkillInstallRootFor(input.worktree.path, prefix, snapshot.skillId),
      rel: skillInstallRootFor(prefix, snapshot.skillId),
    }));
  } catch {
    throw new SkillPlanError(SkillPlanErrorCode.TARGET_UNSAFE);
  }

  // The receipt is byte-identical across roots and records the full root set.
  const receipt = buildSkillInstallReceipt({ snapshot, version: input.version, rootPrefixes });
  const receiptBytes = serializeSkillInstallReceipt(receipt);
  const receiptDigest = createHash('sha256').update(receiptBytes).digest('hex');

  const plannedFiles: SkillPlannedFile[] = [
    ...snapshot.files.map((file) => ({
      relativePath: file.path,
      sha256: file.sha256,
      size: file.size,
      executable: file.executable,
      bytes: snapshot.readFile(file.path),
      generated: false,
    })),
    {
      relativePath: SKILL_RECEIPT_FILENAME,
      sha256: receiptDigest,
      size: receiptBytes.byteLength,
      executable: false,
      bytes: receiptBytes,
      generated: true,
    },
  ];

  const git = await readSkillGitTargetState(input.worktree.path);
  const gitIgnoredPaths = await findGitIgnoredPaths(
    input.worktree.path,
    rootTargets.flatMap((root) =>
      plannedFiles.map((file) => `${root.rel}/${file.relativePath}`)
    )
  );

  // One preview per root. The payload is identical, but each root has its own
  // existing tree, its own receipt and its own conflicts (#1460).
  const perRoot = rootTargets.map((root) => {
    const existing = readExistingSkillTree(root.abs);
    const installedReceipt = readInstalledReceipt(existing);
    const receiptFiles = installedReceipt
      ? new Map(
          [
            ...installedReceipt.receipt.files.map(
              (file) => [file.path, { sha256: file.sha256, executable: file.executable }] as const
            ),
            // The receipt does not list itself, but it is CommandMate-managed:
            // without this the previous receipt would read as an unmanaged file
            // and block every legitimate re-install.
            [
              SKILL_RECEIPT_FILENAME,
              { sha256: installedReceipt.digest, executable: false },
            ] as const,
          ]
        )
      : null;
    const preview = buildSkillPreviewDiff({
      skillId: snapshot.skillId,
      worktreePath: input.worktree.path,
      installRootPrefix: root.prefix,
      plannedFiles,
      existing,
      receiptFiles,
      git,
      gitIgnoredPaths,
    });
    return { root, installedReceipt, preview };
  });

  // The primary root anchors the binding's tree hashes and the receipt path; the
  // route re-reads the primary tree before spending the token.
  const primary = perRoot[0];
  const installRootRel = primary.root.rel;
  const installedReceipt = primary.installedReceipt;
  const installRoots = rootTargets.map((root) => root.rel);

  const mergedEntries: SkillDiffEntry[] = perRoot
    .flatMap((r) => [...r.preview.entries])
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const mergedStats: SkillDiffStats = perRoot.reduce(
    (acc, r) => ({
      added: acc.added + r.preview.stats.added,
      modified: acc.modified + r.preview.stats.modified,
      unchanged: acc.unchanged + r.preview.stats.unchanged,
      conflicted: acc.conflicted + r.preview.stats.conflicted,
      unmanaged: acc.unmanaged + r.preview.stats.unmanaged,
      binaryFiles: acc.binaryFiles + r.preview.stats.binaryFiles,
      truncatedFiles: acc.truncatedFiles + r.preview.stats.truncatedFiles,
      diffBytes: acc.diffBytes + r.preview.stats.diffBytes,
    }),
    { added: 0, modified: 0, unchanged: 0, conflicted: 0, unmanaged: 0, binaryFiles: 0, truncatedFiles: 0, diffBytes: 0 }
  );
  const mergedWarnings = [...new Set(perRoot.flatMap((r) => [...r.preview.warnings]))];

  const blockers: SkillInstallPlanDto['blockers'] = mergedEntries
    .filter((entry) => entry.change === 'conflict' || entry.change === 'unmanaged')
    .map((entry) => ({ code: entry.reason as string, path: entry.path }));
  if (input.compatibility.status !== 'compatible') {
    blockers.push({ code: input.compatibility.messageKey, path: null });
  }

  const requiresRiskAcknowledgement = snapshot.effectiveRisk === 'high';
  const riskAcknowledged = input.riskAcknowledged === true;
  const token = randomBytes(SKILL_PLAN_TOKEN_BYTES).toString('hex');
  const expiresAt = now + SKILL_PLAN_TTL_MS;

  const binding: SkillPlanBinding = {
    actor: input.actor,
    operation: 'install',
    worktreeId: input.worktree.id,
    skillId: snapshot.skillId,
    version: snapshot.version,
    artifactSha256: input.version.artifact.sha256,
    snapshotId: input.snapshotId,
    branch: git.branch,
    headCommit: git.headCommit,
    currentTreeHash: primary.preview.currentTreeHash,
    plannedTreeHash: primary.preview.plannedTreeHash,
    receiptDigest,
    riskAcknowledged,
  };

  const dto: SkillInstallPlanDto = {
    token,
    expiresAt: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    installable: blockers.length === 0,
    requiresRiskAcknowledgement,
    riskAcknowledged,
    riskAcknowledgementMessageKey: requiresRiskAcknowledgement
      ? SKILL_PLAN_HIGH_RISK_MESSAGE_KEY
      : null,
    blockers,
    warnings: mergedWarnings,
    target: {
      worktreeId: input.worktree.id,
      worktreeName: input.worktree.name,
      repositoryName: input.worktree.repositoryName,
      syncedBranch: input.worktree.syncedBranch,
      branch: git.branch,
      headState: git.headState,
      headCommit: git.headCommit,
      workingTreeDirty: git.dirty,
      installRoot: primary.preview.installRoot,
      installRoots,
      currentTreeHash: primary.preview.currentTreeHash,
      plannedTreeHash: primary.preview.plannedTreeHash,
      existingInstall: installedReceipt
        ? { version: installedReceipt.receipt.version, receiptDigest: installedReceipt.digest }
        : null,
    },
    skill: toSkillPlanSkillDto(input),
    receipt: {
      path: `${installRootRel}/${SKILL_RECEIPT_FILENAME}`,
      sha256: receiptDigest,
      size: receiptBytes.byteLength,
    },
    files: mergedEntries,
    stats: mergedStats,
  };

  const record: SkillInstallPlanRecord = {
    token,
    binding,
    bindingHash: computeSkillPlanBindingHash(binding),
    createdAt: now,
    expiresAt,
    consumedAt: null,
    worktreePath: input.worktree.path,
    rootPrefixes,
    receipt,
    receiptBytes,
    dto,
  };

  sweep(now);
  cache.records.set(token, record);
  return record;
}

function readInstalledReceipt(
  existing: ReturnType<typeof readExistingSkillTree>
): { receipt: SkillInstallReceipt; digest: string } | null {
  const file = existing.files.find((entry) => entry.path === SKILL_RECEIPT_FILENAME);
  if (!file) return null;
  const receipt = parseInstalledReceipt(file.bytes);
  return receipt ? { receipt, digest: file.sha256 } : null;
}

function toSkillPlanSkillDto(input: CreateSkillInstallPlanInput): SkillPlanSkillDto {
  const { manifest } = input.snapshot;
  return {
    id: input.snapshot.skillId,
    name: manifest.name,
    version: input.snapshot.version,
    summary: manifest.summary,
    description: manifest.description,
    capabilities: [...manifest.capabilities],
    expectedOutcomes: [...manifest.expected_outcomes],
    provider: { ...manifest.provider },
    license: manifest.license,
    homepage: manifest.homepage ?? null,
    declaredPermissions: [...input.snapshot.inspection.declared_permissions],
    requirements: {
      commands: manifest.requirements.commands.map((command) => ({
        name: command.name,
        versionRange: command.version_range ?? null,
      })),
      networkHosts: [...manifest.requirements.network_hosts],
    },
    declaredRisk: input.snapshot.declaredRisk,
    computedRisk: input.snapshot.computedRisk,
    effectiveRisk: input.snapshot.effectiveRisk,
    riskRationale: manifest.risk_rationale,
    executablePaths: [...input.snapshot.inspection.executable_paths],
    scriptPaths: [...input.snapshot.inspection.script_paths],
    compatibility: {
      commandmate: input.compatibility,
      agents: input.version.compatibility.agents.map((agent) => ({ ...agent })),
    },
    source: {
      repository: input.version.source.repository,
      ref: input.version.source.ref,
      commit: input.version.source.commit,
    },
    artifact: {
      assetName: input.version.artifact.asset_name,
      sha256: input.version.artifact.sha256,
      size: input.version.artifact.size,
      format: input.version.artifact.format,
    },
  };
}
