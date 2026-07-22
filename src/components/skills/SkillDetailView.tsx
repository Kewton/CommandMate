/**
 * SkillDetailView (Issue #1232)
 *
 * The /skills/[skillId] screen. Presents one Catalog entry as a capability the
 * user is deciding whether to adopt: what it is, who publishes it, whether it
 * runs here, and — stated plainly rather than implied — what the Catalog cannot
 * tell them.
 *
 * Three distinctions the wording must keep, because collapsing any of them
 * would let a user approve something they did not understand:
 * - Publisher-declared risk is a claim; the risk CommandMate computes comes
 *   from inspecting the downloaded package and is not in the Catalog.
 * - Declared permissions are declarations, not enforcement.
 * - `unknown` compatibility is a judgement CommandMate could not make, which is
 *   not the same as "compatible".
 *
 * The Catalog also carries no manifest: capabilities, expected outcomes,
 * permissions, required commands/hosts and the file/script list live inside the
 * package. Those sections say so rather than rendering blank, so an absent
 * section is never mistaken for "this Skill needs nothing".
 *
 * @module components/skills/SkillDetailView
 */

'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import { PERMISSION_DECLARATION_NOTICE_KEY } from '@/lib/skills/constants';
import type { SkillCommandMateCompatibility } from '@/lib/skills/compatibility';
import { AgentSupportBadge, SkillCompatibilityBadge, SkillRiskBadge } from './SkillBadges';
import { CatalogStatusBanner } from './CatalogStatusBanner';
import { SkillChangelog } from './SkillChangelog';
import { SkillInstallPanel } from './SkillInstallPanel';
import { SkillNotice } from './SkillNotice';
import { fetchSkillDetail, type SkillFetchFailure } from './skills-client';
import { RECOMMENDATION_LABEL_KEY, resolveSkillMessageKey } from './skill-vocabulary';
import type { SkillCatalogMetaDto, SkillDto, SkillVersionDto } from './types';

interface DetailState {
  status: 'loading' | 'loaded' | 'error';
  catalog: SkillCatalogMetaDto | null;
  skill: SkillDto | null;
  failure: SkillFetchFailure | null;
}

const INITIAL_STATE: DetailState = { status: 'loading', catalog: null, skill: null, failure: null };

/** A labelled value in one of the definition lists. */
function Field({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 text-sm text-foreground ${mono ? 'break-all font-mono text-xs' : 'break-words'}`}>
        {children}
      </dd>
    </div>
  );
}

function SectionCard({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card data-testid={testId} className="space-y-3">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {children}
    </Card>
  );
}

/** The human-readable verdict, interpolated from the contract's message key. */
function CompatibilityReason({ compatibility }: { compatibility: SkillCommandMateCompatibility }) {
  const t = useTranslations('skills');
  return (
    <p className="text-sm text-foreground" data-testid="skill-compatibility-reason">
      {t(resolveSkillMessageKey(compatibility.messageKey), {
        range: compatibility.requiredRange,
        currentVersion: compatibility.currentVersion ?? '',
      })}
    </p>
  );
}

function VersionCard({ version }: { version: SkillVersionDto }) {
  const t = useTranslations('skills');
  return (
    <Card
      data-testid={`skill-version-${version.version}`}
      className="space-y-3"
      padding="sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold text-foreground">{version.version}</span>
        {version.prerelease && <Badge variant="warning">{t('detail.prerelease')}</Badge>}
        <SkillCompatibilityBadge status={version.compatibility.commandmate.status} />
        <SkillRiskBadge risk={version.declaredRisk} />
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('detail.publishedAt')}>{version.publishedAt}</Field>
        <Field label={t('detail.requiredRangeLabel')}>
          {version.compatibility.commandmate.requiredRange}
        </Field>
        <Field label={t('detail.sourceRepository')}>{version.source.repository}</Field>
        <Field label={t('detail.sourceRef')}>{version.source.ref}</Field>
        <Field label={t('detail.sourceCommit')} mono>
          {version.source.commit}
        </Field>
        <Field label={t('detail.packageAsset')} mono>
          {version.artifact.assetName}
        </Field>
        <Field label={t('detail.packageDigest')} mono>
          {version.artifact.sha256}
        </Field>
        <Field label={t('detail.packageSize')}>
          {t('detail.packageBytes', { bytes: version.artifact.size })}
        </Field>
      </dl>

      <div className="flex flex-wrap gap-1.5">
        {version.compatibility.agents.length > 0 ? (
          version.compatibility.agents.map((agent) => (
            <AgentSupportBadge key={agent.agent} agent={agent} />
          ))
        ) : (
          <p className="text-xs text-muted-foreground">{t('compatibility.agentsUnknown')}</p>
        )}
      </div>

      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{t('detail.changelogHeading')}</h3>
        <div className="mt-1">
          <SkillChangelog changelog={version.changelog} />
        </div>
      </div>
    </Card>
  );
}

export interface SkillDetailViewProps {
  skillId: string;
}

export function SkillDetailView({ skillId }: SkillDetailViewProps) {
  const t = useTranslations('skills');
  const [state, setState] = useState<DetailState>(INITIAL_STATE);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState(INITIAL_STATE);

    fetchSkillDetail(skillId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setState(
          result.ok
            ? {
                status: 'loaded',
                catalog: result.data.catalog,
                skill: result.data.skill,
                failure: null,
              }
            : { status: 'error', catalog: null, skill: null, failure: result.failure }
        );
      })
      .catch(() => {
        // Only an abort reaches here; the request has no outcome to render.
      });

    return () => controller.abort();
  }, [skillId, reloadToken]);

  const retry = useCallback(() => setReloadToken((token) => token + 1), []);

  const backLink = (
    <Link
      href="/skills"
      className="inline-flex items-center gap-1 text-sm text-accent-600 hover:underline dark:text-accent-400"
      data-testid="skill-detail-back"
    >
      <ArrowLeft size={14} aria-hidden="true" />
      {t('page.backToCatalog')}
    </Link>
  );

  if (state.status === 'loading') {
    return (
      <div className="space-y-4" data-testid="skill-detail-loading">
        {backLink}
        <p className="text-sm text-muted-foreground">{t('state.loading')}</p>
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  if (state.status === 'error' || !state.skill) {
    const notFound = state.failure?.status === 404;
    return (
      <div className="space-y-4">
        {backLink}
        <Card data-testid={notFound ? 'skill-detail-not-found' : 'skill-detail-error'} className="space-y-3">
          <h2 className="text-base font-semibold text-foreground">
            {notFound ? t('state.notFoundHeading') : t('state.errorHeading')}
          </h2>
          <SkillNotice tone="danger">
            <p>{notFound ? t('state.notFoundNotice') : t('state.errorNotice')}</p>
            <p className="mt-1 break-words">
              {t('state.errorCode', { code: state.failure?.code ?? '' })}
            </p>
          </SkillNotice>
          {!notFound && (
            <Button variant="secondary" size="sm" onClick={retry} data-testid="skill-detail-retry">
              {t('state.retry')}
            </Button>
          )}
        </Card>
      </div>
    );
  }

  const skill = state.skill;
  const compatibility = skill.compatibility;
  const recommended =
    skill.versions.find((version) => version.version === skill.recommendedVersion) ?? null;
  const declaredRisk = (recommended ?? skill.versions[0])?.declaredRisk ?? null;

  // Install is offered only from a version that is present AND confirmed
  // compatible: an `unknown` verdict means CommandMate could not decide, and
  // offering it anyway would be exactly the "unknown shown as compatible" this
  // screen must avoid.
  const installBlockedReason = !skill.recommendedVersion
    ? t('detail.install.blockedNoVersion')
    : compatibility && compatibility.status !== 'compatible'
      ? t('detail.install.blockedIncompatible', {
          reason: t(resolveSkillMessageKey(compatibility.messageKey), {
            range: compatibility.requiredRange,
            currentVersion: compatibility.currentVersion ?? '',
          }),
        })
      : null;

  return (
    <div className="space-y-4">
      {backLink}
      {state.catalog && <CatalogStatusBanner catalog={state.catalog} />}

      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-foreground break-words">{skill.name}</h1>
        <p className="text-sm text-muted-foreground break-words">{skill.summary}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {compatibility && <SkillCompatibilityBadge status={compatibility.status} />}
          {declaredRisk && <SkillRiskBadge risk={declaredRisk} />}
        </div>
      </div>

      <SectionCard title={t('detail.install.action')} testId="skill-install-section">
        <SkillInstallPanel
          skillId={skill.id}
          version={skill.recommendedVersion}
          blockedReason={installBlockedReason}
        />
      </SectionCard>

      <SectionCard title={t('capabilities.heading')} testId="skill-capabilities-section">
        <p className="text-sm text-foreground break-words">{skill.summary}</p>
        <SkillNotice tone="neutral">{t('capabilities.unavailable')}</SkillNotice>
      </SectionCard>

      <SectionCard title={t('detail.overview')} testId="skill-overview-section">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('detail.skillId')} mono>
            {skill.id}
          </Field>
          <Field label={t('detail.provider')}>
            {skill.provider.url ? (
              <a
                href={skill.provider.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-600 hover:underline dark:text-accent-400"
              >
                {skill.provider.name}
              </a>
            ) : (
              skill.provider.name
            )}
          </Field>
          {skill.provider.contact && (
            <Field label={t('detail.providerContact')}>{skill.provider.contact}</Field>
          )}
          <Field label={t('detail.license')}>{skill.license}</Field>
          {skill.homepage && (
            <Field label={t('detail.homepage')}>
              <a
                href={skill.homepage}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-accent-600 hover:underline dark:text-accent-400"
              >
                {skill.homepage}
              </a>
            </Field>
          )}
          <Field label={t('detail.latestVersion')} mono>
            {skill.latest}
          </Field>
          <Field label={t('detail.recommendedVersion')} mono>
            {skill.recommendedVersion ?? t('detail.recommendedVersionNone')}
          </Field>
        </dl>
        <p className="text-xs text-muted-foreground" data-testid="skill-recommendation-reason">
          {t(RECOMMENDATION_LABEL_KEY[skill.recommendedReason])}
        </p>
        {skill.keywords.length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground">{t('detail.keywords')}</h3>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {skill.keywords.map((keyword) => (
                <Badge key={keyword} variant="gray">
                  {keyword}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard title={t('compatibility.label')} testId="skill-compatibility-section">
        {compatibility ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <SkillCompatibilityBadge status={compatibility.status} />
              <span className="text-sm text-muted-foreground">
                {t('compatibility.requiredRange', { range: compatibility.requiredRange })}
              </span>
            </div>
            <CompatibilityReason compatibility={compatibility} />
            <p className="text-xs text-muted-foreground">
              {compatibility.currentVersion
                ? t('compatibility.currentVersion', { version: compatibility.currentVersion })
                : t('compatibility.currentVersionUnknown')}
            </p>
            {compatibility.status === 'unknown' && (
              <SkillNotice tone="warning" data-testid="skill-compatibility-unknown-notice">
                {t('compatibility.unverifiedNotice')}
              </SkillNotice>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('compatibility.currentVersionUnknown')}</p>
        )}

        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">{t('compatibility.agentsHeading')}</h3>
          {recommended && recommended.compatibility.agents.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                {recommended.compatibility.agents.map((agent) => (
                  <AgentSupportBadge key={agent.agent} agent={agent} />
                ))}
              </div>
              <ul className="space-y-1">
                {recommended.compatibility.agents.map((agent) => (
                  <li key={agent.agent} className="text-xs text-muted-foreground break-words">
                    {t('compatibility.evidence')}: {agent.evidence}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t('compatibility.agentsUnknown')}</p>
          )}
          <SkillNotice tone="neutral">{t('compatibility.agentsNotice')}</SkillNotice>
        </div>
      </SectionCard>

      <SectionCard title={t('risk.declaredHeading')} testId="skill-risk-section">
        {declaredRisk ? <SkillRiskBadge risk={declaredRisk} /> : null}
        <SkillNotice tone="neutral">{t('risk.declaredNotice')}</SkillNotice>
        {declaredRisk === 'high' && (
          <SkillNotice tone="danger" data-testid="skill-high-risk-warning">
            {t('risk.highWarning')}
          </SkillNotice>
        )}
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('risk.computedHeading')}</h3>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="skill-computed-risk-unavailable">
            {t('risk.computedUnavailable')}
          </p>
        </div>
      </SectionCard>

      <SectionCard title={t('permissions.heading')} testId="skill-permissions-section">
        <SkillNotice tone="warning" data-testid="skill-permission-declaration-notice">
          {t(resolveSkillMessageKey(PERMISSION_DECLARATION_NOTICE_KEY))}
        </SkillNotice>
        <p className="text-sm text-muted-foreground">{t('permissions.unavailable')}</p>
      </SectionCard>

      <SectionCard title={t('requirements.heading')} testId="skill-requirements-section">
        <p className="text-sm text-muted-foreground">{t('requirements.unavailable')}</p>
      </SectionCard>

      <SectionCard title={t('contents.heading')} testId="skill-contents-section">
        <p className="text-sm text-muted-foreground">{t('contents.unavailable')}</p>
      </SectionCard>

      <section className="space-y-3" data-testid="skill-versions-section">
        <h2 className="text-base font-semibold text-foreground">{t('detail.versionsHeading')}</h2>
        {skill.versions.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">{t('detail.versionsEmpty')}</p>
          </Card>
        ) : (
          skill.versions.map((version) => <VersionCard key={version.version} version={version} />)
        )}
      </section>
    </div>
  );
}

export default SkillDetailView;
