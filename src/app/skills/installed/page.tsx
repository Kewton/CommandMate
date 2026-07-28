/**
 * Installed Skills Page (/skills/installed)
 *
 * Issue #1248: applied state across every worktree, plus the operation history.
 */

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/layout';
// Imported concretely rather than through a barrel, for the same reason /skills
// does: a barrel would pull the detail view's markdown renderer into a route
// that never renders markdown.
import { SkillInstallationsDashboard } from '@/components/skills/SkillInstallationsDashboard';

export default function InstalledSkillsPage() {
  const t = useTranslations('skills');

  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground mb-2">{t('dashboard.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('dashboard.description')}</p>
          <Link
            href="/skills"
            className="mt-2 inline-flex text-sm text-accent-600 hover:underline dark:text-accent-400"
          >
            {t('page.backToCatalog')}
          </Link>
        </div>
        <SkillInstallationsDashboard />
      </div>
    </AppShell>
  );
}
