/**
 * CompatibilityEvidence (Issue #1246)
 *
 * Renders what stands behind an Agent support badge: the publisher's claim, the
 * measurement CommandMate took against a real CLI, and — separately — whether
 * that Agent finds the Skill and whether it offers it as a slash command.
 *
 * The two axes stay visually separate because they are separate facts. Codex CLI
 * 0.145.0 finds a Skill and does not list it; folding that into one line would
 * either hide a working install or promise a palette entry that is not there.
 *
 * An Agent CommandMate never measured says so, with the reason, rather than
 * rendering an empty evidence block a reader would complete as "fine".
 *
 * @module components/skills/CompatibilityEvidence
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { getCliToolDisplayNameSafe } from '@/lib/cli-tools/types';
import type {
  SkillAgentAxisView,
  SkillAgentCompatibilityView,
} from '@/lib/skills/compatibility';
import { SkillNotice } from './SkillNotice';
import { resolveSkillMessageKey } from './skill-vocabulary';

function Axis({ axis, agentName }: { axis: SkillAgentAxisView; agentName: string }) {
  const t = useTranslations('skills');
  return (
    <li className="text-xs text-muted-foreground" data-testid={`skill-agent-axis-${axis.axis}`}>
      <span className="font-medium text-foreground">{t(resolveSkillMessageKey(axis.axisKey))}</span>
      {': '}
      <span data-testid={`skill-agent-axis-${axis.axis}-${axis.outcome}`}>
        {t(resolveSkillMessageKey(axis.outcomeKey))}
      </span>
      {' — '}
      {t(resolveSkillMessageKey(axis.evidenceKindKey))}
      {axis.limitationKey && (
        <span className="mt-0.5 block" data-testid={`skill-agent-axis-${axis.axis}-limitation`}>
          {t(resolveSkillMessageKey(axis.limitationKey), { agent: agentName })}
        </span>
      )}
    </li>
  );
}

export interface CompatibilityEvidenceProps {
  agent: SkillAgentCompatibilityView;
  /**
   * `reload` drops the measurement detail and keeps only the reload
   * instruction, for the pre-install summary where the question is "what do I
   * do after this finishes" rather than "how do you know".
   */
  variant?: 'full' | 'reload';
}

/** The evidence behind one Agent's support status, plus how to reload it. */
export function CompatibilityEvidence({ agent, variant = 'full' }: CompatibilityEvidenceProps) {
  const t = useTranslations('skills');
  const agentName = getCliToolDisplayNameSafe(agent.agent);
  const measured = agent.measured;

  if (variant === 'reload') {
    return (
      <li className="text-xs text-muted-foreground" data-testid={`skill-agent-reload-${agent.agent}`}>
        {t(resolveSkillMessageKey(agent.reloadKey), { agent: agentName })}
      </li>
    );
  }

  return (
    <div className="space-y-1" data-testid={`skill-agent-evidence-${agent.agent}`}>
      <p className="text-xs font-medium text-foreground">{agentName}</p>

      <p className="text-xs text-muted-foreground break-words">
        {t('compatibility.declaredLabel', {
          support: t(resolveSkillMessageKey(agent.declaredLabelKey)),
        })}
      </p>
      <p className="text-xs text-muted-foreground break-words">
        {t('compatibility.evidence')}: {agent.evidence}
      </p>

      <p
        className="text-xs text-muted-foreground break-words"
        data-testid={`skill-agent-verification-${agent.agent}`}
      >
        {t(resolveSkillMessageKey(agent.verificationKey))}
      </p>

      {measured ? (
        <div className="space-y-0.5 border-l-2 border-border pl-2">
          <p className="text-xs font-medium text-foreground">
            {t('compatibility.measuredHeading')}
          </p>
          <ul className="space-y-0.5">
            <Axis axis={measured.discovery} agentName={agentName} />
            <Axis axis={measured.invocation} agentName={agentName} />
          </ul>
          {measured.testedVersion && (
            <p className="text-xs text-muted-foreground">
              {t('compatibility.testedVersion', {
                agent: agentName,
                version: measured.testedVersion,
              })}
            </p>
          )}
          {measured.testedDate && (
            <p className="text-xs text-muted-foreground">
              {t('compatibility.testedDate', { date: measured.testedDate })}
            </p>
          )}
          {measured.discoveryRoots.length > 0 && (
            <p className="text-xs text-muted-foreground break-all">
              {t('compatibility.discoveryRoots', { roots: measured.discoveryRoots.join(', ') })}
            </p>
          )}
          {measured.evidenceSource && (
            <p className="text-xs text-muted-foreground break-all">
              {t('compatibility.evidenceSource')}: {measured.evidenceSource}
            </p>
          )}
          {measured.stale && (
            <SkillNotice tone="warning" data-testid={`skill-agent-evidence-stale-${agent.agent}`}>
              {t('compatibility.evidenceStale', { days: measured.ageDays ?? 0 })}
            </SkillNotice>
          )}
        </div>
      ) : (
        agent.skipReasonKey && (
          <p
            className="text-xs text-muted-foreground break-words"
            data-testid={`skill-agent-skip-reason-${agent.agent}`}
          >
            {t(resolveSkillMessageKey(agent.skipReasonKey))}
          </p>
        )
      )}

      <p className="text-xs text-muted-foreground break-words">
        <span className="font-medium text-foreground">
          {t('compatibility.reloadHeading', { agent: agentName })}
        </span>
        {': '}
        {t(resolveSkillMessageKey(agent.reloadKey), { agent: agentName })}
      </p>
    </div>
  );
}

export default CompatibilityEvidence;
