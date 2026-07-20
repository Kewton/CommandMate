/**
 * Badges for the Skill Catalog vocabulary (Issue #1232)
 *
 * Every badge carries a text label and, where it signals a hazard, an icon —
 * colour alone never distinguishes "compatible" from "unverified" or "low" from
 * "high" risk (受入条件: high riskが視覚・アクセシビリティ上識別できる).
 *
 * @module components/skills/SkillBadges
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui';
import { getCliToolDisplayNameSafe } from '@/lib/cli-tools/types';
import type { SkillCompatibilityStatus } from '@/lib/skills/compatibility';
import type { SkillRiskLevel } from '@/types/skills';
import {
  AGENT_SUPPORT_BADGE_VARIANT,
  COMPATIBILITY_BADGE_VARIANT,
  COMPATIBILITY_LABEL_KEY,
  RISK_BADGE_VARIANT,
  RISK_LABEL_KEY,
  resolveSkillMessageKey,
} from './skill-vocabulary';
import type { SkillVersionDto } from './types';

export interface SkillCompatibilityBadgeProps {
  status: SkillCompatibilityStatus;
  className?: string;
}

/** CommandMate compatibility verdict. `unknown` is styled as a warning, never success. */
export function SkillCompatibilityBadge({ status, className }: SkillCompatibilityBadgeProps) {
  const t = useTranslations('skills');
  return (
    <Badge
      variant={COMPATIBILITY_BADGE_VARIANT[status]}
      className={className}
      data-testid={`skill-compatibility-${status}`}
    >
      {t(COMPATIBILITY_LABEL_KEY[status])}
    </Badge>
  );
}

export interface SkillRiskBadgeProps {
  risk: SkillRiskLevel;
  className?: string;
}

/**
 * Publisher-declared risk. The label always names it as declared so it is never
 * mistaken for the risk CommandMate computes from the package contents.
 */
export function SkillRiskBadge({ risk, className }: SkillRiskBadgeProps) {
  const t = useTranslations('skills');
  return (
    <Badge
      variant={RISK_BADGE_VARIANT[risk]}
      className={className}
      data-testid={`skill-declared-risk-${risk}`}
    >
      {risk === 'high' && <ShieldAlert size={12} aria-hidden="true" className="mr-1 shrink-0" />}
      {t('risk.declaredLabel', { level: t(RISK_LABEL_KEY[risk]) })}
    </Badge>
  );
}

export interface AgentSupportBadgeProps {
  agent: SkillVersionDto['compatibility']['agents'][number];
}

/** One Agent support claim, using the label key the contract publishes (UX-05). */
export function AgentSupportBadge({ agent }: AgentSupportBadgeProps) {
  const t = useTranslations('skills');
  return (
    <Badge
      variant={AGENT_SUPPORT_BADGE_VARIANT[agent.support]}
      data-testid={`skill-agent-${agent.agent}-${agent.support}`}
    >
      {getCliToolDisplayNameSafe(agent.agent)}: {t(resolveSkillMessageKey(agent.labelKey))}
    </Badge>
  );
}
