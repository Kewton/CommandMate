/**
 * Shared display vocabulary for the Skill Catalog UI (Issue #1232)
 *
 * Pure functions and lookup tables only, so list, detail and their tests read
 * the same mapping from a wire value to a badge, a label key and a filter
 * decision. Nothing here fetches or interprets a Catalog.
 *
 * @module components/skills/skill-vocabulary
 */

import type { BadgeVariant } from '@/components/ui';
import type {
  SkillCompatibilityStatus,
  SkillRecommendationReasonCode,
} from '@/lib/skills/compatibility';
import type { SkillAgentSupport, SkillRiskLevel } from '@/types/skills';
import type { SkillDiffChange, SkillDto } from './types';

/**
 * `unknown` is warning, never success.
 *
 * A verdict CommandMate could not reach must not share a colour with one it
 * confirmed — otherwise "unverified" reads as "compatible" (UX-07).
 */
export const COMPATIBILITY_BADGE_VARIANT: Record<SkillCompatibilityStatus, BadgeVariant> = {
  compatible: 'success',
  incompatible: 'error',
  unknown: 'warning',
};

export const COMPATIBILITY_LABEL_KEY: Record<SkillCompatibilityStatus, string> = {
  compatible: 'compatibility.status.compatible',
  incompatible: 'compatibility.status.incompatible',
  unknown: 'compatibility.status.unknown',
};

/**
 * Risk never renders as success: `low` is the publisher's lowest claim, not a
 * CommandMate endorsement, so it gets the neutral variant.
 */
export const RISK_BADGE_VARIANT: Record<SkillRiskLevel, BadgeVariant> = {
  low: 'gray',
  moderate: 'warning',
  high: 'error',
};

export const RISK_LABEL_KEY: Record<SkillRiskLevel, string> = {
  low: 'risk.level.low',
  moderate: 'risk.level.moderate',
  high: 'risk.level.high',
};

export const AGENT_SUPPORT_BADGE_VARIANT: Record<SkillAgentSupport, BadgeVariant> = {
  native: 'success',
  commandmate_runtime: 'info',
  unsupported: 'error',
  unknown: 'warning',
};

export const RECOMMENDATION_LABEL_KEY: Record<SkillRecommendationReasonCode, string> = {
  SKILL_RECOMMEND_HIGHEST_COMPATIBLE: 'detail.recommendation.highestCompatible',
  SKILL_RECOMMEND_LATEST_UNVERIFIED: 'detail.recommendation.latestUnverified',
  SKILL_RECOMMEND_NONE_COMPATIBLE: 'detail.recommendation.noneCompatible',
  SKILL_RECOMMEND_NO_VERSIONS: 'detail.recommendation.noVersions',
};

/**
 * How a planned file change reads (Issue #1431).
 *
 * `conflict` and `unmanaged` are errors, not warnings: each one is a path the
 * install refuses to touch, and colouring them like a caution would suggest the
 * install could proceed anyway.
 */
export const DIFF_CHANGE_BADGE_VARIANT: Record<SkillDiffChange, BadgeVariant> = {
  add: 'info',
  modify: 'warning',
  unchanged: 'gray',
  conflict: 'error',
  unmanaged: 'error',
};

export const DIFF_CHANGE_LABEL_KEY: Record<SkillDiffChange, string> = {
  add: 'plan.change.add',
  modify: 'plan.change.modify',
  unchanged: 'plan.change.unchanged',
  conflict: 'plan.change.conflict',
  unmanaged: 'plan.change.unmanaged',
};

/** Why the planner classified a path the way it did. Keyed by `SkillDiffReasonCode`. */
export const DIFF_REASON_LABEL_KEY: Record<string, string> = {
  SKILL_DIFF_NEW_FILE: 'plan.diffReason.newFile',
  SKILL_DIFF_CONTENT_IDENTICAL: 'plan.diffReason.contentIdentical',
  SKILL_DIFF_MANAGED_UPDATE: 'plan.diffReason.managedUpdate',
  SKILL_DIFF_LOCAL_MODIFICATION: 'plan.diffReason.localModification',
  SKILL_DIFF_UNMANAGED_SKILL: 'plan.diffReason.unmanagedSkill',
  SKILL_DIFF_RECEIPT_ORPHAN: 'plan.diffReason.receiptOrphan',
  SKILL_DIFF_NOT_A_REGULAR_FILE: 'plan.diffReason.notARegularFile',
};

/**
 * Manifest-declared permissions, keyed by `SkillDeclaredPermission`.
 *
 * Localized rather than shown as raw identifiers: the user is being asked to
 * approve what the Skill says it will do, and `credential_access` is not a
 * sentence anyone should have to decode under a confirmation prompt.
 */
export const PERMISSION_LABEL_KEY: Record<string, string> = {
  filesystem_read: 'plan.permission.filesystemRead',
  filesystem_write: 'plan.permission.filesystemWrite',
  network_access: 'plan.permission.networkAccess',
  process_execution: 'plan.permission.processExecution',
  environment_read: 'plan.permission.environmentRead',
  credential_access: 'plan.permission.credentialAccess',
};

/** State of the target's git HEAD, keyed by `SkillHeadState`. */
export const HEAD_STATE_LABEL_KEY: Record<string, string> = {
  attached: 'plan.headState.attached',
  detached: 'plan.headState.detached',
  unborn: 'plan.headState.unborn',
  unknown: 'plan.headState.unknown',
};

/** What an uninstall would do with a path, keyed by `SkillUninstallDisposition`. */
export const UNINSTALL_DISPOSITION_LABEL_KEY: Record<string, string> = {
  remove: 'uninstall.disposition.remove',
  modified: 'uninstall.disposition.modified',
  missing: 'uninstall.disposition.missing',
  unknown: 'uninstall.disposition.unknown',
  irregular: 'uninstall.disposition.irregular',
};

/**
 * Why an uninstall would keep or drop a path, keyed by `SkillUninstallReasonCode`.
 *
 * Mirrors `SKILL_UNINSTALL_REASON_MESSAGE_KEYS`, which lives in a module that
 * reads the filesystem and so cannot be imported here. The i18n guard asserts
 * the two agree, so a new reason code cannot land with no label.
 */
export const UNINSTALL_REASON_LABEL_KEY: Record<string, string> = {
  SKILL_UNINSTALL_MANAGED_UNCHANGED: 'uninstall.reason.managedUnchanged',
  SKILL_UNINSTALL_LOCAL_MODIFICATION: 'uninstall.reason.localModification',
  SKILL_UNINSTALL_RECEIPT_ORPHAN: 'uninstall.reason.receiptOrphan',
  SKILL_UNINSTALL_UNMANAGED_FILE: 'uninstall.reason.unmanagedFile',
  SKILL_UNINSTALL_NOT_A_REGULAR_FILE: 'uninstall.reason.notARegularFile',
  SKILL_UNINSTALL_NOT_INSTALLED: 'uninstall.reason.notInstalled',
  SKILL_UNINSTALL_RECEIPT_MISSING: 'uninstall.reason.receiptMissing',
  SKILL_UNINSTALL_RECEIPT_UNREADABLE: 'uninstall.reason.receiptUnreadable',
  SKILL_UNINSTALL_RECEIPT_FOREIGN: 'uninstall.reason.receiptForeign',
  SKILL_UNINSTALL_TREE_SCAN_TRUNCATED: 'uninstall.reason.treeScanTruncated',
};

/** Caveats the preview attaches to an otherwise installable plan. */
export const PREVIEW_WARNING_LABEL_KEY: Record<string, string> = {
  SKILL_PREVIEW_DETACHED_HEAD: 'plan.warning.detachedHead',
  SKILL_PREVIEW_UNBORN_HEAD: 'plan.warning.unbornHead',
  SKILL_PREVIEW_HEAD_UNRESOLVED: 'plan.warning.headUnresolved',
  SKILL_PREVIEW_WORKING_TREE_DIRTY: 'plan.warning.workingTreeDirty',
  SKILL_PREVIEW_PATH_GIT_IGNORED: 'plan.warning.pathGitIgnored',
  SKILL_PREVIEW_DIFF_TRUNCATED: 'plan.warning.diffTruncated',
  SKILL_PREVIEW_BINARY_CONTENT: 'plan.warning.binaryContent',
  SKILL_PREVIEW_LINE_ENDING_CRLF: 'plan.warning.lineEndingCrlf',
  SKILL_PREVIEW_TREE_SCAN_TRUNCATED: 'plan.warning.treeScanTruncated',
};

/**
 * Typed refusals from the plan and apply routes, in the user's words.
 *
 * Each entry says what state the worktree is in and what to do about it,
 * because "SKILL_PLAN_STALE" tells a user nothing about whether their files
 * were touched. Anything unmapped falls back to a message that shows the raw
 * code rather than inventing a diagnosis.
 */
export const OPERATION_ERROR_LABEL_KEY: Record<string, string> = {
  SKILL_PLAN_STALE: 'operation.error.planStale',
  SKILL_PLAN_EXPIRED: 'operation.error.planExpired',
  SKILL_PLAN_CONSUMED: 'operation.error.planConsumed',
  SKILL_PLAN_NOT_FOUND: 'operation.error.planNotFound',
  SKILL_PLAN_BINDING_MISMATCH: 'operation.error.planBindingMismatch',
  SKILL_PLAN_NOT_INSTALLABLE: 'operation.error.planNotInstallable',
  SKILL_PLAN_RISK_NOT_ACKNOWLEDGED: 'operation.error.planRiskNotAcknowledged',
  SKILL_INSTALL_LOCKED: 'operation.error.installLocked',
  SKILL_INSTALL_IN_PROGRESS: 'operation.error.installInProgress',
  SKILL_INSTALL_DESTINATION_EXISTS: 'operation.error.installDestinationExists',
  SKILL_INSTALL_DESTINATION_UNMANAGED: 'operation.error.installDestinationUnmanaged',
  SKILL_INSTALL_IDEMPOTENCY_CONFLICT: 'operation.error.installIdempotencyConflict',
  SKILL_INSTALL_FAILED: 'operation.error.installFailed',
  SKILL_UNINSTALL_LOCKED: 'operation.error.uninstallLocked',
  SKILL_UNINSTALL_IN_PROGRESS: 'operation.error.uninstallInProgress',
  SKILL_UNINSTALL_IDEMPOTENCY_CONFLICT: 'operation.error.uninstallIdempotencyConflict',
  SKILL_UNINSTALL_NOT_INSTALLED: 'operation.error.uninstallNotInstalled',
  SKILL_UNINSTALL_BLOCKED: 'operation.error.uninstallBlocked',
  SKILL_UNINSTALL_DRIFT: 'operation.error.uninstallDrift',
  SKILL_UNINSTALL_FILE_CHANGED: 'operation.error.uninstallFileChanged',
  SKILL_UNINSTALL_FAILED: 'operation.error.uninstallFailed',
  SKILL_REQUEST_FAILED: 'operation.error.requestFailed',
};

export function operationErrorLabelKey(code: string): string {
  return OPERATION_ERROR_LABEL_KEY[code] ?? 'operation.error.unexpected';
}

const CATALOG_REASON_LABEL_KEY: Record<string, string> = {
  SKILL_CATALOG_FETCH_FAILED: 'catalog.reason.fetchFailed',
  SKILL_CATALOG_RATE_LIMITED: 'catalog.reason.rateLimited',
  SKILL_CATALOG_OVERSIZED: 'catalog.reason.oversized',
  SKILL_CATALOG_MALFORMED: 'catalog.reason.malformed',
  SKILL_CATALOG_INVALID_SCHEMA: 'catalog.reason.invalidSchema',
};

/** Label key for a stale/failure code, falling back to an explicit "unknown". */
export function catalogReasonLabelKey(code: string | null): string {
  return (code && CATALOG_REASON_LABEL_KEY[code]) || 'catalog.reason.unknown';
}

/**
 * Strip the `skills.` prefix off a contract-supplied message key.
 *
 * `lib/skills` publishes fully-qualified keys (`skills.compatibility.native`)
 * so UI and CLI share one vocabulary, while `useTranslations('skills')` expects
 * them relative to the namespace.
 */
export function resolveSkillMessageKey(key: string): string {
  return key.startsWith('skills.') ? key.slice('skills.'.length) : key;
}

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const HTML_MEDIA_TAG = /<\/?(?:img|picture|source|video|audio|iframe|embed|object|track)\b[^>]*>/gi;

/**
 * Remove every construct that would make the renderer load a remote asset.
 *
 * The shared MarkdownPreview sanitizer allows `img[src]` over http(s), so
 * sanitization alone still lets Catalog text pull a tracking pixel from the
 * publisher's host. Removing the nodes before rendering is what actually keeps
 * browsing the Catalog from emitting outbound requests. Alt text is kept so the
 * changelog does not silently lose meaning.
 */
export function stripRemoteMedia(markdown: string): string {
  return markdown.replace(MARKDOWN_IMAGE, '$1').replace(HTML_MEDIA_TAG, '');
}

/** Case-insensitive match over the fields a user would search by. */
export function matchesSkillQuery(skill: SkillDto, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [skill.name, skill.summary, skill.id, skill.provider.name, ...skill.keywords].some(
    (field) => field.toLowerCase().includes(needle)
  );
}

/** Active filter selection. `all` means the dimension is not filtered. */
export interface SkillFilterState {
  query: string;
  compatibility: SkillCompatibilityStatus | 'all';
  risk: SkillRiskLevel | 'all';
  agent: string | 'all';
}

export const EMPTY_SKILL_FILTERS: SkillFilterState = {
  query: '',
  compatibility: 'all',
  risk: 'all',
  agent: 'all',
};

/**
 * Risk shown for an entry in the list: the recommended version's declaration,
 * falling back to the newest listed version. Null when nothing is listed.
 */
export function headlineDeclaredRisk(skill: SkillDto): SkillRiskLevel | null {
  const recommended = skill.versions.find((v) => v.version === skill.recommendedVersion);
  return (recommended ?? skill.versions[0])?.declaredRisk ?? null;
}

/** Agents any listed version claims to run on, natively or via the Runtime. */
export function supportedAgents(skill: SkillDto): string[] {
  const agents = new Set<string>();
  for (const version of skill.versions) {
    for (const agent of version.compatibility.agents) {
      if (agent.support === 'native' || agent.support === 'commandmate_runtime') {
        agents.add(agent.agent);
      }
    }
  }
  return [...agents].sort();
}

/** Apply search and every active filter. Order of the input list is preserved. */
export function filterSkills(skills: SkillDto[], filters: SkillFilterState): SkillDto[] {
  return skills.filter((skill) => {
    if (!matchesSkillQuery(skill, filters.query)) return false;
    if (filters.compatibility !== 'all' && skill.compatibility?.status !== filters.compatibility) {
      return false;
    }
    if (filters.risk !== 'all' && headlineDeclaredRisk(skill) !== filters.risk) return false;
    if (filters.agent !== 'all' && !supportedAgents(skill).includes(filters.agent)) return false;
    return true;
  });
}

/** Every agent named by any listed version, for the filter options. */
export function collectAgentOptions(skills: SkillDto[]): string[] {
  const agents = new Set<string>();
  for (const skill of skills) {
    for (const version of skill.versions) {
      for (const agent of version.compatibility.agents) agents.add(agent.agent);
    }
  }
  return [...agents].sort();
}
