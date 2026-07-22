/**
 * Skills Page (/skills)
 *
 * Issue #1232: browse the official Skill Catalog.
 */

'use client';

import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/layout';
// Imported concretely rather than through a barrel: a barrel would pull the
// detail view's markdown renderer (react-markdown / highlight.js) into the list
// route, which never renders markdown.
import { SkillCatalogView } from '@/components/skills/SkillCatalogView';

export default function SkillsPage() {
  const t = useTranslations('skills');

  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground mb-2">{t('page.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('page.description')}</p>
        </div>
        <SkillCatalogView />
      </div>
    </AppShell>
  );
}
