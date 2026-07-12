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
import { AppShell } from '@/components/layout';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui';
import ReviewTab from '@/components/review/ReviewTab';
import ReportTab from '@/components/review/ReportTab';
import TemplateTab from '@/components/review/TemplateTab';

type PageTab = 'review' | 'report' | 'template';

const PAGE_TABS: Array<{ value: PageTab; label: string }> = [
  { value: 'review', label: 'Review' },
  { value: 'report', label: 'Report' },
  { value: 'template', label: 'Template' },
];

export default function ReviewPage() {
  const [pageTab, setPageTab] = useState<PageTab>('review');

  return (
    <AppShell>
      <div className="container-custom py-8 overflow-auto h-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Review</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Worktrees that need your attention.
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
                {tab.label}
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
