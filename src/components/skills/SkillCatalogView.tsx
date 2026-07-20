/**
 * SkillCatalogView (Issue #1232)
 *
 * The /skills list: search, filter and browse the official Catalog through the
 * #1231 API. Loading, empty, no-match, stale and error are four distinct
 * renderings — in particular a retrieval failure never degrades into an empty
 * list, because "no Skills exist" and "the Catalog is unreachable" would lead a
 * user to opposite conclusions.
 *
 * @module components/skills/SkillCatalogView
 */

'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card, Input, Skeleton } from '@/components/ui';
import { getCliToolDisplayNameSafe } from '@/lib/cli-tools/types';
import { CatalogStatusBanner } from './CatalogStatusBanner';
import { SkillCard } from './SkillCard';
import { SkillNotice } from './SkillNotice';
import { fetchSkillList, type SkillFetchFailure } from './skills-client';
import {
  COMPATIBILITY_LABEL_KEY,
  EMPTY_SKILL_FILTERS,
  RISK_LABEL_KEY,
  collectAgentOptions,
  filterSkills,
  type SkillFilterState,
} from './skill-vocabulary';
import type { SkillCatalogMetaDto, SkillDto } from './types';

const SELECT_CLASS =
  'w-full rounded-md border border-input bg-surface px-3 py-2 text-sm text-foreground ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const COMPATIBILITY_OPTIONS = ['compatible', 'incompatible', 'unknown'] as const;
const RISK_OPTIONS = ['low', 'moderate', 'high'] as const;

interface LoadState {
  status: 'loading' | 'loaded' | 'error';
  catalog: SkillCatalogMetaDto | null;
  skills: SkillDto[];
  failure: SkillFetchFailure | null;
}

const INITIAL_STATE: LoadState = {
  status: 'loading',
  catalog: null,
  skills: [],
  failure: null,
};

export function SkillCatalogView() {
  const t = useTranslations('skills');
  const [state, setState] = useState<LoadState>(INITIAL_STATE);
  const [filters, setFilters] = useState<SkillFilterState>(EMPTY_SKILL_FILTERS);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState(INITIAL_STATE);

    fetchSkillList(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setState(
          result.ok
            ? {
                status: 'loaded',
                catalog: result.data.catalog,
                skills: result.data.skills,
                failure: null,
              }
            : { status: 'error', catalog: null, skills: [], failure: result.failure }
        );
      })
      .catch(() => {
        // Only an abort reaches here; the request has no outcome to render.
      });

    return () => controller.abort();
  }, [reloadToken]);

  const retry = useCallback(() => setReloadToken((token) => token + 1), []);
  const updateFilter = useCallback(
    <K extends keyof SkillFilterState>(key: K, value: SkillFilterState[K]) =>
      setFilters((prev) => ({ ...prev, [key]: value })),
    []
  );

  const agentOptions = useMemo(() => collectAgentOptions(state.skills), [state.skills]);
  const visible = useMemo(() => filterSkills(state.skills, filters), [state.skills, filters]);

  if (state.status === 'loading') {
    return (
      <div data-testid="skill-catalog-loading" className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('state.loading')}</p>
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-28 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <Card data-testid="skill-catalog-error" className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">{t('state.errorHeading')}</h2>
        <SkillNotice tone="danger">
          <p>{t('state.errorNotice')}</p>
          <p className="mt-1 break-words">
            {t('state.errorCode', { code: state.failure?.code ?? '' })}
          </p>
        </SkillNotice>
        <Button variant="secondary" size="sm" onClick={retry} data-testid="skill-catalog-retry">
          {t('state.retry')}
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {state.catalog && <CatalogStatusBanner catalog={state.catalog} />}

      <div className="space-y-3">
        <Input
          type="search"
          value={filters.query}
          onChange={(event) => updateFilter('query', event.target.value)}
          aria-label={t('search.label')}
          placeholder={t('search.placeholder')}
          data-testid="skill-search-input"
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block text-xs font-medium text-muted-foreground">
            {t('filters.compatibility')}
            <select
              className={`${SELECT_CLASS} mt-1`}
              value={filters.compatibility}
              onChange={(event) =>
                updateFilter('compatibility', event.target.value as SkillFilterState['compatibility'])
              }
              data-testid="skill-filter-compatibility"
            >
              <option value="all">{t('filters.all')}</option>
              {COMPATIBILITY_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {t(COMPATIBILITY_LABEL_KEY[status])}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs font-medium text-muted-foreground">
            {t('filters.risk')}
            <select
              className={`${SELECT_CLASS} mt-1`}
              value={filters.risk}
              onChange={(event) =>
                updateFilter('risk', event.target.value as SkillFilterState['risk'])
              }
              data-testid="skill-filter-risk"
            >
              <option value="all">{t('filters.all')}</option>
              {RISK_OPTIONS.map((risk) => (
                <option key={risk} value={risk}>
                  {t(RISK_LABEL_KEY[risk])}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs font-medium text-muted-foreground">
            {t('filters.agent')}
            <select
              className={`${SELECT_CLASS} mt-1`}
              value={filters.agent}
              onChange={(event) => updateFilter('agent', event.target.value)}
              data-testid="skill-filter-agent"
            >
              <option value="all">{t('filters.all')}</option>
              {agentOptions.map((agent) => (
                <option key={agent} value={agent}>
                  {getCliToolDisplayNameSafe(agent)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground" data-testid="skill-result-count">
            {t('search.resultCount', { shown: visible.length, total: state.skills.length })}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilters(EMPTY_SKILL_FILTERS)}
            data-testid="skill-filter-reset"
          >
            {t('filters.reset')}
          </Button>
        </div>
      </div>

      {state.skills.length === 0 ? (
        <Card data-testid="skill-catalog-empty">
          <p className="text-sm text-muted-foreground">{t('state.empty')}</p>
        </Card>
      ) : visible.length === 0 ? (
        <Card data-testid="skill-catalog-no-results">
          <p className="text-sm text-foreground">{t('state.noResults')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('state.noResultsHint')}</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((skill) => (
            <SkillCard key={skill.id} skill={skill} />
          ))}
        </div>
      )}
    </div>
  );
}

export default SkillCatalogView;
