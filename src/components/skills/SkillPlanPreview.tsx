/**
 * Install and uninstall plan previews (Issue #1431)
 *
 * What the user approves is this preview, so it renders the plan and nothing
 * else. Every fact shown — the branch, the risk CommandMate computed, which
 * paths would be written, which ones stop the operation — comes from the plan
 * response. The browser holds no filesystem path and makes no security
 * judgement of its own, so there is nothing here for it to get wrong or for a
 * tampered client to talk itself past.
 *
 * A plan that refuses is still rendered in full: "why can I not install this"
 * is the question a bare error code leaves unanswered.
 *
 * @module components/skills/SkillPlanPreview
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Card } from '@/components/ui';
import { getCliToolDisplayNameSafe } from '@/lib/cli-tools/types';
import type { SkillRiskLevel } from '@/types/skills';
import { SkillNotice } from './SkillNotice';
import {
  DIFF_CHANGE_BADGE_VARIANT,
  DIFF_CHANGE_LABEL_KEY,
  DIFF_REASON_LABEL_KEY,
  HEAD_STATE_LABEL_KEY,
  PERMISSION_LABEL_KEY,
  PREVIEW_WARNING_LABEL_KEY,
  RISK_BADGE_VARIANT,
  RISK_LABEL_KEY,
  UNINSTALL_DISPOSITION_LABEL_KEY,
  UNINSTALL_REASON_LABEL_KEY,
  resolveSkillMessageKey,
} from './skill-vocabulary';
import type {
  SkillDiffEntry,
  SkillInstallPlanDto,
  SkillUninstallFileEntry,
  SkillUninstallPlanDto,
} from './types';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}

/**
 * A risk level with the assessment it came from named in the label.
 *
 * The publisher's claim and CommandMate's own computation are different
 * statements about the same package; a bare "high" badge would let one be read
 * as the other.
 */
function PlanRiskBadge({
  level,
  kind,
  label,
}: {
  level: SkillRiskLevel;
  kind: string;
  label: string;
}) {
  const t = useTranslations('skills');
  return (
    <Badge variant={RISK_BADGE_VARIANT[level]} data-testid={`skill-plan-risk-${kind}-${level}`}>
      {label}: {t(RISK_LABEL_KEY[level])}
    </Badge>
  );
}

function PlanFile({ entry }: { entry: SkillDiffEntry }) {
  const t = useTranslations('skills');
  const reasonKey = DIFF_REASON_LABEL_KEY[entry.reason];

  return (
    <li className="space-y-1.5 rounded-md border border-border px-3 py-2" data-testid={`skill-plan-file-${entry.path}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={DIFF_CHANGE_BADGE_VARIANT[entry.change]}>
          {t(DIFF_CHANGE_LABEL_KEY[entry.change])}
        </Badge>
        <span className="break-all font-mono text-xs text-foreground">{entry.path}</span>
        {entry.generated && <Badge variant="gray">{t('plan.fileGenerated')}</Badge>}
      </div>
      {reasonKey && <p className="text-xs text-muted-foreground">{t(reasonKey)}</p>}
      {entry.gitIgnored && <p className="text-xs text-warning-foreground">{t('plan.gitIgnored')}</p>}
      {entry.binary ? (
        <p className="text-xs text-muted-foreground">{t('plan.diffBinary')}</p>
      ) : entry.diff ? (
        <details>
          <summary className="cursor-pointer text-xs text-accent-600 dark:text-accent-400">
            {t('plan.diffToggle', { additions: entry.additions, deletions: entry.deletions })}
          </summary>
          <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 font-mono text-[11px] leading-snug text-foreground">
            {entry.diff}
          </pre>
          {entry.diffTruncated && (
            <p className="mt-1 text-xs text-muted-foreground">{t('plan.diffTruncated')}</p>
          )}
        </details>
      ) : null}
    </li>
  );
}

export interface SkillInstallPlanPreviewProps {
  plan: SkillInstallPlanDto;
}

export function SkillInstallPlanPreview({ plan }: SkillInstallPlanPreviewProps) {
  const t = useTranslations('skills');
  const { target, skill } = plan;
  const compatibility = skill.compatibility.commandmate;

  return (
    <Card className="space-y-4" data-testid="skill-install-plan">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{t('plan.heading')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('plan.expiresAt', { timestamp: plan.expiresAt })}
        </p>
      </div>

      <section className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('plan.targetHeading')}
        </h4>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('target.repository')}>{target.repositoryName}</Field>
          <Field label={t('target.heading')}>{target.worktreeName}</Field>
          <Field label={t('target.branch')}>{target.branch ?? t('target.branchUnknown')}</Field>
          <Field label={t('plan.headStateLabel')}>
            {t(HEAD_STATE_LABEL_KEY[target.headState] ?? 'plan.headState.unknown')}
          </Field>
          <Field label={t('target.workingTree')}>
            {target.workingTreeDirty ? t('target.workingTreeDirty') : t('target.workingTreeClean')}
          </Field>
          <Field label={t('plan.installRoot')}>
            <span className="break-all font-mono text-xs">{target.installRoot}</span>
          </Field>
          <Field label={t('plan.existingInstall')}>
            {target.existingInstall
              ? t('plan.existingInstallVersion', { version: target.existingInstall.version })
              : t('plan.existingInstallNone')}
          </Field>
          <Field label={t('detail.recommendedVersion')}>
            <span className="font-mono text-xs">{skill.version}</span>
          </Field>
        </dl>
      </section>

      <section className="space-y-2" data-testid="skill-plan-risk-section">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('plan.riskHeading')}
        </h4>
        <div className="flex flex-wrap gap-1.5">
          <PlanRiskBadge level={skill.declaredRisk} kind="declared" label={t('plan.riskDeclared')} />
          <PlanRiskBadge level={skill.computedRisk} kind="computed" label={t('plan.riskComputed')} />
          <PlanRiskBadge
            level={skill.effectiveRisk}
            kind="effective"
            label={t('plan.riskEffective')}
          />
        </div>
        <p className="break-words text-sm text-foreground">{skill.riskRationale}</p>
        <SkillNotice tone="neutral">{t('plan.riskNotice')}</SkillNotice>
      </section>

      <section className="space-y-2" data-testid="skill-plan-permissions">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('permissions.heading')}
        </h4>
        {skill.declaredPermissions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {skill.declaredPermissions.map((permission) => (
              <Badge key={permission} variant="warning">
                {PERMISSION_LABEL_KEY[permission] ? t(PERMISSION_LABEL_KEY[permission]) : permission}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('plan.permissionsNone')}</p>
        )}
        <SkillNotice tone="warning">{t('permissions.declarationOnlyNotice')}</SkillNotice>
      </section>

      <section className="space-y-2" data-testid="skill-plan-requirements">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('requirements.heading')}
        </h4>
        {skill.requirements.commands.length === 0 && skill.requirements.networkHosts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('plan.requirementsNone')}</p>
        ) : (
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {skill.requirements.commands.length > 0 && (
              <Field label={t('plan.requirementsCommands')}>
                {skill.requirements.commands
                  .map((command) => `${command.name} ${command.versionRange ?? t('plan.commandAnyVersion')}`)
                  .join(', ')}
              </Field>
            )}
            {skill.requirements.networkHosts.length > 0 && (
              <Field label={t('plan.requirementsHosts')}>
                {skill.requirements.networkHosts.join(', ')}
              </Field>
            )}
          </dl>
        )}
      </section>

      <section className="space-y-2" data-testid="skill-plan-scripts">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('plan.scriptsHeading')}
        </h4>
        {skill.executablePaths.length === 0 && skill.scriptPaths.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('plan.scriptsNone')}</p>
        ) : (
          <ul className="space-y-1">
            {[...new Set([...skill.scriptPaths, ...skill.executablePaths])].map((path) => (
              <li key={path} className="break-all font-mono text-xs text-foreground">
                {path}
              </li>
            ))}
          </ul>
        )}
      </section>

      {compatibility.status !== 'compatible' && (
        <SkillNotice tone="warning" data-testid="skill-plan-compatibility-notice">
          {t(resolveSkillMessageKey(compatibility.messageKey), {
            range: compatibility.requiredRange,
            currentVersion: compatibility.currentVersion ?? '',
          })}
        </SkillNotice>
      )}

      {plan.warnings.length > 0 && (
        <section className="space-y-2" data-testid="skill-plan-warnings">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('plan.warningsHeading')}
          </h4>
          <ul className="space-y-1">
            {plan.warnings.map((warning) => (
              <li key={warning} className="text-xs text-warning-foreground">
                {PREVIEW_WARNING_LABEL_KEY[warning] ? t(PREVIEW_WARNING_LABEL_KEY[warning]) : warning}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2" data-testid="skill-plan-files">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('plan.filesHeading')}
        </h4>
        <p className="text-xs text-muted-foreground" data-testid="skill-plan-stats">
          {t('plan.stats', {
            added: plan.stats.added,
            modified: plan.stats.modified,
            unchanged: plan.stats.unchanged,
            conflicted: plan.stats.conflicted,
            unmanaged: plan.stats.unmanaged,
          })}
        </p>
        {plan.files.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('plan.filesEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {plan.files.map((entry) => (
              <PlanFile key={entry.path} entry={entry} />
            ))}
          </ul>
        )}
      </section>

      {plan.blockers.length > 0 && (
        <section className="space-y-2" data-testid="skill-install-blockers">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-danger-foreground">
            {t('plan.blockersHeading')}
          </h4>
          <ul className="space-y-1">
            {plan.blockers.map((blocker) => (
              <li
                key={`${blocker.code}:${blocker.path ?? ''}`}
                className="text-xs text-danger-foreground"
              >
                {blocker.path && (
                  <span className="mr-1 break-all font-mono">{blocker.path}</span>
                )}
                {blocker.code.startsWith('skills.')
                  ? t(resolveSkillMessageKey(blocker.code), {
                      range: compatibility.requiredRange,
                      currentVersion: compatibility.currentVersion ?? '',
                    })
                  : DIFF_REASON_LABEL_KEY[blocker.code]
                    ? t(DIFF_REASON_LABEL_KEY[blocker.code])
                    : blocker.code}
              </li>
            ))}
          </ul>
          <SkillNotice tone="danger">{t('plan.blockedNotice')}</SkillNotice>
        </section>
      )}
    </Card>
  );
}

function UninstallFile({ entry }: { entry: SkillUninstallFileEntry }) {
  const t = useTranslations('skills');
  const dispositionKey = UNINSTALL_DISPOSITION_LABEL_KEY[entry.disposition];
  const reasonKey = UNINSTALL_REASON_LABEL_KEY[entry.reason];

  return (
    <li
      className="flex flex-wrap items-center gap-2"
      data-testid={`skill-uninstall-file-${entry.path}`}
    >
      <Badge variant={entry.disposition === 'remove' ? 'info' : 'warning'}>
        {dispositionKey ? t(dispositionKey) : entry.disposition}
      </Badge>
      <span className="break-all font-mono text-xs text-foreground">{entry.path}</span>
      {reasonKey && <span className="text-xs text-muted-foreground">{t(reasonKey)}</span>}
    </li>
  );
}

export interface SkillUninstallPlanPreviewProps {
  plan: SkillUninstallPlanDto;
}

export function SkillUninstallPlanPreview({ plan }: SkillUninstallPlanPreviewProps) {
  const t = useTranslations('skills');
  const { target, skill } = plan;

  return (
    <Card className="space-y-4" data-testid="skill-uninstall-plan">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{t('uninstall.heading')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('uninstall.expiresAt', { timestamp: plan.expiresAt })}
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('target.repository')}>{target.repositoryName}</Field>
        <Field label={t('target.heading')}>{target.worktreeName}</Field>
        <Field label={t('target.branch')}>{target.branch ?? t('target.branchUnknown')}</Field>
        <Field label={t('uninstall.installedVersion')}>
          <span className="font-mono text-xs">{skill.version || t('uninstall.versionUnknown')}</span>
        </Field>
        <Field label={t('plan.installRoot')}>
          <span className="break-all font-mono text-xs">{target.installRoot}</span>
        </Field>
        <Field label={t('target.workingTree')}>
          {target.workingTreeDirty ? t('target.workingTreeDirty') : t('target.workingTreeClean')}
        </Field>
      </dl>

      <p className="text-xs text-muted-foreground" data-testid="skill-uninstall-stats">
        {t('uninstall.stats', {
          removable: plan.stats.removable,
          modified: plan.stats.modified,
          missing: plan.stats.missing,
          unknown: plan.stats.unknown,
          irregular: plan.stats.irregular,
        })}
      </p>

      <section className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('uninstall.removalsHeading')}
        </h4>
        {plan.removals.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('uninstall.removalsEmpty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {plan.removals.map((entry) => (
              <UninstallFile key={entry.path} entry={entry} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('uninstall.retainedHeading')}
        </h4>
        {plan.retained.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('uninstall.retainedEmpty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {plan.retained.map((entry) => (
              <UninstallFile key={entry.path} entry={entry} />
            ))}
          </ul>
        )}
      </section>

      <div className="space-y-2">
        {plan.skill.agents.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="skill-uninstall-agents">
            {plan.skill.agents.map((agent) => (
              <Badge key={agent.agent} variant="gray">
                {getCliToolDisplayNameSafe(agent.agent)}
              </Badge>
            ))}
          </div>
        )}
        <SkillNotice tone="neutral">
          {t(resolveSkillMessageKey(plan.nextActionKey))}
        </SkillNotice>
      </div>

      {plan.blockers.length > 0 && (
        <section className="space-y-2" data-testid="skill-uninstall-blockers">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-danger-foreground">
            {t('uninstall.blockersHeading')}
          </h4>
          <ul className="space-y-1">
            {plan.blockers.map((blocker) => (
              <li
                key={`${blocker.code}:${blocker.path ?? ''}`}
                className="text-xs text-danger-foreground"
              >
                {blocker.path && <span className="mr-1 break-all font-mono">{blocker.path}</span>}
                {t(resolveSkillMessageKey(blocker.messageKey))}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
}
