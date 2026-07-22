/**
 * SkillChangelog (Issue #1232)
 *
 * Renders Catalog-supplied changelog text through the shared, rehype-sanitize'd
 * MarkdownPreview, with every image and embed removed first.
 *
 * Sanitization alone is not enough here: the shared schema permits `img[src]`
 * over http(s), so publisher-controlled text could make merely browsing the
 * Catalog fetch a tracking pixel from an external host. `stripRemoteMedia`
 * removes those nodes before rendering, so no outbound request is possible.
 *
 * @module components/skills/SkillChangelog
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { MarkdownPreview } from '@/components/worktree/MarkdownPreview';
import { stripRemoteMedia } from './skill-vocabulary';

export interface SkillChangelogProps {
  changelog: string;
}

export function SkillChangelog({ changelog }: SkillChangelogProps) {
  const t = useTranslations('skills');
  const safe = stripRemoteMedia(changelog).trim();

  if (safe.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="skill-changelog-empty">
        {t('detail.changelogEmpty')}
      </p>
    );
  }

  return (
    <div data-testid="skill-changelog">
      <div className="prose prose-sm max-w-none dark:prose-invert break-words">
        <MarkdownPreview content={safe} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('detail.mediaStripped')}</p>
    </div>
  );
}

export default SkillChangelog;
