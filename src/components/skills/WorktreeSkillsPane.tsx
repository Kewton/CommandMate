/**
 * WorktreeSkillsPane (Issue #1441)
 *
 * The worktree-scoped Skills surface: browse the official Catalog, see what is
 * installed in *this* worktree, and install or uninstall a Skill without ever
 * choosing a target — the worktree is already fixed by the screen it lives on.
 *
 * It is deliberately placed under `components/skills/` rather than
 * `components/worktree/` so the PC Activity Bar pane (#1441) and the mobile
 * surface (#1442) mount the same component; the only input either supplies is a
 * `worktreeId`.
 *
 * The installed list is read through `fetchWorktreeInstalledSkills` (#1440), the
 * one client the API exposes for "what is installed here" — nothing here walks
 * the filesystem or invents its own request. Selecting a Skill hands off to
 * {@link SkillInstallPanel} with the worktree fixed, so plan → preview → apply
 * runs against exactly this checkout.
 *
 * @module components/skills/WorktreeSkillsPane
 */

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { Badge, Button, Card, Skeleton } from '@/components/ui';
import { SkillCompatibilityBadge, SkillRiskBadge } from './SkillBadges';
import { SkillInstallPanel } from './SkillInstallPanel';
import { SkillNotice } from './SkillNotice';
import {
  fetchSkillList,
  fetchWorktreeInstalledSkills,
  type SkillFetchFailure,
} from './skills-client';
import { headlineDeclaredRisk, resolveSkillMessageKey } from './skill-vocabulary';
import type { InstalledSkillDto, SkillDto } from './types';

interface CatalogState {
  status: 'loading' | 'loaded' | 'error';
  skills: SkillDto[];
  failure: SkillFetchFailure | null;
}

interface InstalledState {
  status: 'loading' | 'loaded' | 'error';
  skills: InstalledSkillDto[];
  failure: SkillFetchFailure | null;
}

const CATALOG_INITIAL: CatalogState = { status: 'loading', skills: [], failure: null };
const INSTALLED_INITIAL: InstalledState = { status: 'loading', skills: [], failure: null };

export interface WorktreeSkillsPaneProps {
  /** The worktree every install/uninstall in this pane acts on. */
  worktreeId: string;
  className?: string;
}

export function WorktreeSkillsPane({ worktreeId, className = '' }: WorktreeSkillsPaneProps) {
  const t = useTranslations('skills');
  const [catalog, setCatalog] = useState<CatalogState>(CATALOG_INITIAL);
  const [installed, setInstalled] = useState<InstalledState>(INSTALLED_INITIAL);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [catalogReloadToken, setCatalogReloadToken] = useState(0);
  const [installedReloadToken, setInstalledReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setCatalog(CATALOG_INITIAL);

    fetchSkillList(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setCatalog(
          result.ok
            ? { status: 'loaded', skills: result.data.skills, failure: null }
            : { status: 'error', skills: [], failure: result.failure }
        );
      })
      .catch(() => {
        // Only an abort reaches here; the request has no outcome to render.
      });

    return () => controller.abort();
  }, [catalogReloadToken]);

  useEffect(() => {
    const controller = new AbortController();
    setInstalled(INSTALLED_INITIAL);

    fetchWorktreeInstalledSkills(worktreeId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setInstalled(
          result.ok
            ? { status: 'loaded', skills: result.data.skills, failure: null }
            : { status: 'error', skills: [], failure: result.failure }
        );
      })
      .catch(() => {
        // Only an abort reaches here; the request has no outcome to render.
      });

    return () => controller.abort();
  }, [worktreeId, installedReloadToken]);

  const installedIds = useMemo(
    () => new Set(installed.skills.map((skill) => skill.skillId)),
    [installed.skills]
  );
  const selectedCatalogSkill = useMemo(
    () => catalog.skills.find((skill) => skill.id === selectedSkillId) ?? null,
    [catalog.skills, selectedSkillId]
  );
  const selectedInstalledSkill = useMemo(
    () => installed.skills.find((skill) => skill.skillId === selectedSkillId) ?? null,
    [installed.skills, selectedSkillId]
  );

  // Detail view: hand the selected Skill off to the shared install/uninstall
  // panel with this worktree fixed. Returning to the list re-reads the installed
  // index so an apply that just happened is reflected.
  if (selectedSkillId) {
    const skill = selectedCatalogSkill;
    const compatibility = skill?.compatibility ?? null;
    const version = skill ? skill.recommendedVersion : (selectedInstalledSkill?.version ?? null);
    // Mirror SkillDetailView: install is offered only from a present, confirmed
    // compatible version; uninstall stays available regardless.
    const blockedReason = skill
      ? !skill.recommendedVersion
        ? t('detail.install.blockedNoVersion')
        : compatibility && compatibility.status !== 'compatible'
          ? t('detail.install.blockedIncompatible', {
              reason: t(resolveSkillMessageKey(compatibility.messageKey), {
                range: compatibility.requiredRange,
                currentVersion: compatibility.currentVersion ?? '',
              }),
            })
          : null
      : null;

    return (
      <div
        className={`flex flex-col min-h-0 ${className}`.trim()}
        data-testid="worktree-skills-pane"
      >
        <div className="flex items-center gap-2 border-b border-border p-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedSkillId(null);
              setInstalledReloadToken((token) => token + 1);
            }}
            data-testid="worktree-skills-back"
          >
            <ArrowLeft size={14} aria-hidden="true" className="mr-1" />
            {t('worktreePane.back')}
          </Button>
          <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
            {skill?.name ?? selectedSkillId}
          </h2>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <SkillInstallPanel
            skillId={selectedSkillId}
            version={version}
            blockedReason={blockedReason}
            worktreeId={worktreeId}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col min-h-0 ${className}`.trim()} data-testid="worktree-skills-pane">
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
        <section className="space-y-2" data-testid="worktree-skills-installed">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('worktreePane.installedHeading')}
          </h2>
          {installed.status === 'loading' ? (
            <Skeleton
              className="h-16 w-full rounded-lg"
              data-testid="worktree-skills-installed-loading"
            />
          ) : installed.status === 'error' ? (
            <Card className="space-y-2" data-testid="worktree-skills-installed-error">
              <SkillNotice tone="danger">
                <p>{t('worktreePane.installedError')}</p>
                <p className="mt-1 break-words">
                  {t('state.errorCode', { code: installed.failure?.code ?? '' })}
                </p>
              </SkillNotice>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setInstalledReloadToken((token) => token + 1)}
                data-testid="worktree-skills-installed-retry"
              >
                {t('state.retry')}
              </Button>
            </Card>
          ) : installed.skills.length === 0 ? (
            <Card data-testid="worktree-skills-installed-empty">
              <p className="text-sm text-muted-foreground">{t('worktreePane.installedEmpty')}</p>
            </Card>
          ) : (
            <ul className="space-y-2">
              {installed.skills.map((skill) => (
                <li key={skill.skillId}>
                  <button
                    type="button"
                    onClick={() => setSelectedSkillId(skill.skillId)}
                    data-testid={`worktree-skills-installed-${skill.skillId}`}
                    className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all text-sm font-semibold text-foreground">
                        {skill.skillId}
                      </span>
                      <SkillRiskBadge risk={skill.effectiveRisk} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('worktreePane.version', { version: skill.version })}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2" data-testid="worktree-skills-catalog">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('worktreePane.catalogHeading')}
          </h2>
          {catalog.status === 'loading' ? (
            <Skeleton
              className="h-24 w-full rounded-lg"
              data-testid="worktree-skills-catalog-loading"
            />
          ) : catalog.status === 'error' ? (
            <Card className="space-y-2" data-testid="worktree-skills-catalog-error">
              <SkillNotice tone="danger">
                <p>{t('state.errorNotice')}</p>
                <p className="mt-1 break-words">
                  {t('state.errorCode', { code: catalog.failure?.code ?? '' })}
                </p>
              </SkillNotice>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCatalogReloadToken((token) => token + 1)}
                data-testid="worktree-skills-catalog-retry"
              >
                {t('state.retry')}
              </Button>
            </Card>
          ) : catalog.skills.length === 0 ? (
            <Card data-testid="worktree-skills-catalog-empty">
              <p className="text-sm text-muted-foreground">{t('state.empty')}</p>
            </Card>
          ) : (
            <ul className="space-y-2">
              {catalog.skills.map((skill) => {
                const declaredRisk = headlineDeclaredRisk(skill);
                return (
                  <li key={skill.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedSkillId(skill.id)}
                      data-testid={`worktree-skills-catalog-${skill.id}`}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 break-all text-sm font-semibold text-foreground">
                          {skill.name}
                        </span>
                        {installedIds.has(skill.id) && (
                          <Badge variant="info" data-testid={`worktree-skills-installed-badge-${skill.id}`}>
                            {t('worktreePane.installedBadge')}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {t('card.provider', { provider: skill.provider.name })}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {skill.compatibility && (
                          <SkillCompatibilityBadge status={skill.compatibility.status} />
                        )}
                        {declaredRisk && <SkillRiskBadge risk={declaredRisk} />}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export default WorktreeSkillsPane;
