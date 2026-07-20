/**
 * More Page (/more)
 *
 * Issue #600: UX refresh - Settings, External Apps, Help, Auth.
 * Contains ExternalAppsManager moved from Home page.
 * On mobile, Repositories is accessible from here.
 */

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/layout';
import { Card } from '@/components/ui';
import { ExternalAppsManager } from '@/components/external-apps';
import { NotificationsSettings } from '@/components/notifications';

export default function MorePage() {
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');
  const tSkills = useTranslations('skills');
  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground mb-2">More</h1>
          <p className="text-sm text-muted-foreground">
            Settings, external apps, and more.
          </p>
        </div>

        {/* Quick Links */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4 text-foreground">Quick Links</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Link
              href="/repositories"
              className="block"
              data-testid="more-link-repositories"
            >
              <Card hover className="transition-colors hover:border-accent-300 dark:hover:border-accent-700">
                <div className="text-sm font-medium text-foreground">Repositories</div>
                <div className="text-xs text-muted-foreground">Manage repositories and worktrees</div>
              </Card>
            </Link>
            <Link href="/skills" className="block" data-testid="more-link-skills">
              <Card hover className="transition-colors hover:border-accent-300 dark:hover:border-accent-700">
                <div className="text-sm font-medium text-foreground">{tCommon('nav.skills')}</div>
                <div className="text-xs text-muted-foreground">{tSkills('page.description')}</div>
              </Card>
            </Link>
          </div>
        </div>

        {/* Notifications */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4 text-foreground">{tNotifications('title')}</h2>
          <NotificationsSettings />
        </div>

        {/* External Apps */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4 text-foreground">External Apps</h2>
          <ExternalAppsManager />
        </div>

        {/* About */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4 text-foreground">About</h2>
          <Card>
            <div className="text-sm text-muted-foreground">
              CommandMate - A local control plane for agent CLIs.
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
