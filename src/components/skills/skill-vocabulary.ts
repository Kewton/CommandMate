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
import type { SkillDto } from './types';

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
