/**
 * CatalogStatusBanner (Issue #1232)
 *
 * Freshness of the served Catalog. A stale or offline snapshot is announced
 * with its reason and both timestamps instead of being presented as the current
 * state of the world (UX-07).
 *
 * Timestamps render as the RFC 3339 strings the API returns rather than a
 * locale-formatted date, so what is shown is exactly what was served.
 *
 * @module components/skills/CatalogStatusBanner
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { SkillNotice } from './SkillNotice';
import { catalogReasonLabelKey } from './skill-vocabulary';
import type { SkillCatalogMetaDto } from './types';

export interface CatalogStatusBannerProps {
  catalog: SkillCatalogMetaDto;
}

export function CatalogStatusBanner({ catalog }: CatalogStatusBannerProps) {
  const t = useTranslations('skills');
  const degraded = catalog.stale || catalog.offline;

  if (!degraded) {
    return (
      <p data-testid="skill-catalog-fresh" className="text-xs text-muted-foreground break-words">
        {t('catalog.freshLabel')} ·{' '}
        {t('catalog.revalidatedAt', { timestamp: catalog.revalidatedAt })} ·{' '}
        {t('catalog.sourceLabel', {
          repository: catalog.source.repository,
          ref: catalog.source.ref,
        })}
      </p>
    );
  }

  return (
    <SkillNotice tone="warning" data-testid="skill-catalog-stale" className="flex-col sm:flex-row">
      <div className="space-y-1">
        <p className="font-medium">{t('catalog.staleHeading')}</p>
        <p>{t('catalog.staleNotice')}</p>
        {catalog.offline && <p>{t('catalog.offlineNotice')}</p>}
        <p>{t(catalogReasonLabelKey(catalog.staleReason))}</p>
        <p className="break-words">
          {t('catalog.fetchedAt', { timestamp: catalog.fetchedAt })} ·{' '}
          {t('catalog.revalidatedAt', { timestamp: catalog.revalidatedAt })}
        </p>
        <p className="break-words">
          {t('catalog.sourceLabel', {
            repository: catalog.source.repository,
            ref: catalog.source.ref,
          })}
        </p>
      </div>
    </SkillNotice>
  );
}

export default CatalogStatusBanner;
