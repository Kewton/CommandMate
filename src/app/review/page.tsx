/**
 * Review Page (/review)
 *
 * Issue #600: UX refresh - Shows worktrees needing attention.
 * Issue #607: Added Report tab for daily summary feature.
 * Issue #618: Added Template tab for report template management.
 *
 * Page-level tab shell: Review | Report | Template
 * Each tab delegates to its own component.
 */

'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell } from '@/components/layout';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui';
import ReviewTab from '@/components/review/ReviewTab';
import ReportTab from '@/components/review/ReportTab';
import TemplateTab from '@/components/review/TemplateTab';

type PageTab = 'review' | 'report' | 'template';

// Holds `review.tabs.*` keys rather than labels: t() cannot be called at module
// scope, so a literal would pin the tabs to English (Issue #1271/#1305).
const PAGE_TABS: Array<{ value: PageTab; labelKey: string }> = [
  { value: 'review', labelKey: 'tabs.review' },
  { value: 'report', labelKey: 'tabs.report' },
  { value: 'template', labelKey: 'tabs.template' },
];

export default function ReviewPage() {
  const t = useTranslations('review');
  const [pageTab, setPageTab] = useState<PageTab>('review');

  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground mb-2">{t('page.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('page.description')}
          </p>
        </div>

        {/* Page-level tabs */}
        <Tabs
          value={pageTab}
          onValueChange={(value) => setPageTab(value as PageTab)}
        >
          <TabsList className="mb-6 w-full justify-start" data-testid="page-tabs">
            {PAGE_TABS.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                data-testid={`page-tab-${tab.value}`}
              >
                {t(tab.labelKey)}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="review">
            <ReviewTab />
          </TabsContent>
          <TabsContent value="report">
            <ReportTab />
          </TabsContent>
          <TabsContent value="template">
            <TemplateTab />
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}
