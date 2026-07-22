/**
 * SkillCard (Issue #1232)
 *
 * One Catalog entry in the list. Presents a Skill as an installable capability:
 * what it is, who publishes it, whether it runs on the CommandMate in front of
 * the user, and what risk its publisher declares — never as a file bundle.
 *
 * Everything is rendered unconditionally; no badge or warning appears only on
 * hover, which would be permanently invisible on a touch device.
 *
 * @module components/skills/SkillCard
 */

'use client';

import React from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, Card } from '@/components/ui';
import { getCliToolDisplayNameSafe } from '@/lib/cli-tools/types';
import { SkillCompatibilityBadge, SkillRiskBadge } from './SkillBadges';
import { headlineDeclaredRisk, supportedAgents } from './skill-vocabulary';
import type { SkillDto } from './types';

export interface SkillCardProps {
  skill: SkillDto;
}

export function SkillCard({ skill }: SkillCardProps) {
  const t = useTranslations('skills');
  const declaredRisk = headlineDeclaredRisk(skill);
  const agents = supportedAgents(skill);

  return (
    <Link
      href={`/skills/${encodeURIComponent(skill.id)}`}
      className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
      data-testid={`skill-card-${skill.id}`}
    >
      <Card variant="interactive" className="h-full">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold text-foreground">{skill.name}</h3>
              <p className="truncate text-xs text-muted-foreground">
                {t('card.provider', { provider: skill.provider.name })}
              </p>
            </div>
            <span className="shrink-0 text-xs font-medium text-muted-foreground">
              {skill.recommendedVersion ?? t('card.noRecommendedVersion')}
            </span>
          </div>

          <p className="text-sm text-muted-foreground line-clamp-3">{skill.summary}</p>

          <div className="flex flex-wrap items-center gap-1.5">
            {skill.compatibility && <SkillCompatibilityBadge status={skill.compatibility.status} />}
            {declaredRisk && <SkillRiskBadge risk={declaredRisk} />}
            {agents.map((agent) => (
              <Badge key={agent} variant="gray">
                {getCliToolDisplayNameSafe(agent)}
              </Badge>
            ))}
          </div>
        </div>
      </Card>
    </Link>
  );
}

export default SkillCard;
