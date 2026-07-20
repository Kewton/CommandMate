/**
 * Wire types the Skill Catalog UI consumes (Issue #1232)
 *
 * Type-only re-export of the #1231 serialization contract. `export type` is
 * erased at compile time, so nothing from `lib/api/skills-api` (which imports
 * `next/server`) reaches the client bundle.
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
