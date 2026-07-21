/**
 * Wire types the Skill Catalog UI consumes (Issue #1232, #1431)
 *
 * Type-only re-export of the #1231 serialization contract. `export type` is
 * erased at compile time, so nothing from `lib/api/skills-api` (which imports
 * `next/server`) reaches the client bundle.
 *
 * The write-path shapes (#1431) are re-exported from the route modules that
 * define them rather than copied, so a change to what the API returns fails
 * type-check here instead of silently drifting into a hand-written mirror.
 *
 * @module components/skills/types
 */

export type {
  SkillApiErrorResponse,
  SkillArtifactDto,
  SkillCatalogMetaDto,
  SkillDetailResponse,
  SkillDto,
  SkillListResponse,
  SkillVersionDto,
} from '@/lib/api/skills-api';

export type {
  SkillDiffChange,
  SkillDiffEntry,
  SkillDiffStats,
  SkillPreviewWarningCode,
} from '@/lib/skills/preview-diff';

export type {
  SkillInstallPlanDto,
  SkillPlanSkillDto,
  SkillPlanTargetDto,
} from '@/lib/skills/install-plan';

export type {
  SkillUninstallBlocker,
  SkillUninstallFileEntry,
  SkillUninstallPlanDto,
} from '@/lib/skills/uninstall-plan';

export type { SkillInstallPlanResponse } from '@/app/api/worktrees/[id]/skills/[skillId]/plan/route';
export type {
  SkillInstallReplayResponse,
  SkillInstallResponse,
} from '@/app/api/worktrees/[id]/skills/[skillId]/install/route';
export type { SkillUninstallPlanResponse } from '@/app/api/worktrees/[id]/skills/[skillId]/uninstall-plan/route';
export type {
  SkillUninstallReplayResponse,
  SkillUninstallResponse,
} from '@/app/api/worktrees/[id]/skills/[skillId]/uninstall/route';
export type {
  InstalledSkillDto,
  InstalledSkillListResponse,
} from '@/app/api/worktrees/[id]/skills/route';

import type {
  SkillInstallReplayResponse,
  SkillInstallResponse,
} from '@/app/api/worktrees/[id]/skills/[skillId]/install/route';
import type {
  SkillUninstallReplayResponse,
  SkillUninstallResponse,
} from '@/app/api/worktrees/[id]/skills/[skillId]/uninstall/route';

/**
 * What an apply request can answer with.
 *
 * A retried request is served from the operation index, which records that the
 * install happened but not the per-file inventory, so the replay body is
 * strictly narrower. Keeping both in one union forces the screen to check
 * before reading a field a replay does not carry.
 */
export type SkillInstallApplyResponse = SkillInstallResponse | SkillInstallReplayResponse;
export type SkillUninstallApplyResponse = SkillUninstallResponse | SkillUninstallReplayResponse;
