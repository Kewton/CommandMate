/**
 * SettingsDialog (Issue #2708)
 *
 * The PC settings modal: the same sections `/more` shows, grouped into
 * categories down the left the way a desktop app does, instead of one long
 * scroll. Mounted exactly once (AppProviders) and driven by
 * SettingsDialogContext.
 *
 * `ui/Modal` renders nothing while closed and Radix unmounts the inactive
 * TabsContent, so the notification / external-app / default-agent fetches only
 * run once the user opens the dialog and lands on that category.
 *
 * Phones keep the `/more` page: the triggers that call `open()` are desktop
 * only (#2709), and a two-column dialog has nowhere to go at 390px.
 */

'use client';

import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { useSettingsDialog } from '@/contexts/SettingsDialogContext';
import {
  SettingsAboutSection,
  SettingsExternalAppsSection,
  SettingsGeneralSection,
  SettingsNotificationsSection,
  SettingsQuickLinksSection,
} from './SettingsPanel';

/** Left-hand categories, in order. `labelKey` resolves against `common`. */
const CATEGORIES: ReadonlyArray<{ id: string; labelKey: string }> = [
  { id: 'general', labelKey: 'settings.sections.general' },
  { id: 'notifications', labelKey: 'settings.sections.notifications' },
  { id: 'externalApps', labelKey: 'settings.sections.externalApps' },
  { id: 'about', labelKey: 'settings.sections.about' },
];

export function SettingsDialog() {
  const t = useTranslations('common');
  const { isOpen, close } = useSettingsDialog();

  return (
    <Modal isOpen={isOpen} onClose={close} title={t('settings.title')} size="lg">
      <Tabs
        defaultValue="general"
        orientation="vertical"
        variant="pill"
        className="flex gap-6 min-h-[60vh]"
        data-testid="settings-dialog"
      >
        <TabsList
          aria-label={t('settings.categoriesLabel')}
          className="sticky top-0 w-40 shrink-0 flex-col items-stretch self-start"
        >
          {CATEGORIES.map((category) => (
            <TabsTrigger
              key={category.id}
              value={category.id}
              data-testid={`settings-dialog-tab-${category.id}`}
              className="justify-start"
            >
              {t(category.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="min-w-0 flex-1">
          <TabsContent value="general" className="mt-0">
            <SettingsGeneralSection />
          </TabsContent>
          <TabsContent value="notifications" className="mt-0">
            <SettingsNotificationsSection />
          </TabsContent>
          <TabsContent value="externalApps" className="mt-0">
            <SettingsExternalAppsSection />
          </TabsContent>
          <TabsContent value="about" className="mt-0">
            {/* The links leave the app shell, so the dialog has to get out of
                the way first. */}
            <SettingsQuickLinksSection onNavigate={close} />
            <SettingsAboutSection />
          </TabsContent>
        </div>
      </Tabs>
    </Modal>
  );
}
