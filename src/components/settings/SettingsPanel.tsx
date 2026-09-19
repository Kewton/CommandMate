/**
 * SettingsPanel (Issue #2707)
 *
 * The settings content itself, lifted out of `/more` so the same sections can
 * be shown as a page (mobile, and any direct visit) and inside the PC settings
 * modal (#2708). The page owns the `<h1>` and the page padding; this file
 * owns everything below it.
 *
 * Each section is exported on its own because the modal groups them into
 * categories rather than stacking them, and because Radix Tabs mounts only the
 * active category — which is what keeps the notification and external-app
 * fetches off the modal's first paint.
 */

'use client';

import { type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui';
import { ExternalAppsManager } from '@/components/external-apps';
import { NotificationsSettings } from '@/components/notifications';
// Relative, not `@/components/settings`: that barrel re-exports this file, and
// importing it here would be a cycle.
import { AgentUpdatesCard } from './AgentUpdatesCard';
import { DefaultAgentsSettings } from './DefaultAgentsSettings';
import { DefaultSurfaceModeSettings } from './DefaultSurfaceModeSettings';

/** Shared section frame: heading + body, same markup the page had inline. */
function SettingsSection({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-8">
      <h2 className="text-lg font-semibold mb-4 text-foreground">{heading}</h2>
      {children}
    </div>
  );
}

/**
 * Links out of the settings surface. `onNavigate` lets the modal close itself
 * before the route changes; the page passes nothing and keeps today's behavior.
 */
export function SettingsQuickLinksSection({ onNavigate }: { onNavigate?: () => void }) {
  const tCommon = useTranslations('common');
  const tSkills = useTranslations('skills');

  return (
    <SettingsSection heading={tCommon('settings.sections.quickLinks')}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Link
          href="/repositories"
          className="block"
          data-testid="more-link-repositories"
          onClick={onNavigate}
        >
          <Card hover className="transition-colors hover:border-accent-300 dark:hover:border-accent-700">
            <div className="text-sm font-medium text-foreground">Repositories</div>
            <div className="text-xs text-muted-foreground">Manage repositories and worktrees</div>
          </Card>
        </Link>
        <Link href="/skills" className="block" data-testid="more-link-skills" onClick={onNavigate}>
          <Card hover className="transition-colors hover:border-accent-300 dark:hover:border-accent-700">
            <div className="text-sm font-medium text-foreground">{tCommon('nav.skills')}</div>
            <div className="text-xs text-muted-foreground">{tSkills('page.description')}</div>
          </Card>
        </Link>
        <Link
          href="/skills/installed"
          className="block"
          data-testid="more-link-skills-installed"
          onClick={onNavigate}
        >
          <Card hover className="transition-colors hover:border-accent-300 dark:hover:border-accent-700">
            <div className="text-sm font-medium text-foreground">{tSkills('dashboard.title')}</div>
            <div className="text-xs text-muted-foreground">{tSkills('dashboard.description')}</div>
          </Card>
        </Link>
      </div>
    </SettingsSection>
  );
}

/** Issue #2065 / #2201 / #2069: what a newly discovered branch inherits. */
export function SettingsGeneralSection() {
  const tCommon = useTranslations('common');

  return (
    <SettingsSection heading={tCommon('settings.sections.general')}>
      <div className="space-y-4">
        <DefaultAgentsSettings />
        {/* Issue #2201: below the agent roster, because it answers the next
            question a new branch raises — "and what do I look at while it
            works" — and it is also the only mount that seeds the browser's
            copy of the setting (see surface-mode-config). */}
        <DefaultSurfaceModeSettings />
        {/* Issue #2069: beside the default-agent list rather than in its own
            section — both answer "which agent CLIs does this machine run",
            and the roster above is where a user notices a tool at all. */}
        <AgentUpdatesCard />
      </div>
    </SettingsSection>
  );
}

export function SettingsNotificationsSection() {
  const tCommon = useTranslations('common');

  return (
    <SettingsSection heading={tCommon('settings.sections.notifications')}>
      <NotificationsSettings />
    </SettingsSection>
  );
}

export function SettingsExternalAppsSection() {
  const tCommon = useTranslations('common');

  return (
    <SettingsSection heading={tCommon('settings.sections.externalApps')}>
      <ExternalAppsManager />
    </SettingsSection>
  );
}

export function SettingsAboutSection() {
  const tCommon = useTranslations('common');

  return (
    <SettingsSection heading={tCommon('settings.sections.about')}>
      <Card>
        <div className="text-sm text-muted-foreground">
          CommandMate - A local control plane for agent CLIs.
        </div>
      </Card>
    </SettingsSection>
  );
}

/**
 * Every section, stacked in the order `/more` has always shown them.
 * The page is the only caller; the modal composes the sections itself.
 */
export function SettingsPanel() {
  return (
    <>
      <SettingsQuickLinksSection />
      <SettingsGeneralSection />
      <SettingsNotificationsSection />
      <SettingsExternalAppsSection />
      <SettingsAboutSection />
    </>
  );
}
