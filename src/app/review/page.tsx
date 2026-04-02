/**
 * Review Page (/review)
 *
 * Issue #600: UX refresh - Shows worktrees needing attention.
 * Issue #607: Added Report tab for daily summary feature.
 *
 * Page-level tab shell: Review | Report
 * Each tab delegates to its own component.
 */

'use client';

import { useState } from 'react';
import { AppShell } from '@/components/layout';
import ReviewTab from '@/components/review/ReviewTab';
import ReportTab from '@/components/review/ReportTab';

type PageTab = 'review' | 'report';

const PAGE_TABS: Array<{ value: PageTab; label: string }> = [
  { value: 'review', label: 'Review' },
  { value: 'report', label: 'Report' },
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
        <div className="flex gap-1 mb-6 border-b dark:border-gray-700" data-testid="page-tabs">
          {PAGE_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setPageTab(tab.value)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                pageTab === tab.value
                  ? 'border-cyan-600 text-cyan-600 dark:text-cyan-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
              data-testid={`page-tab-${tab.value}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {pageTab === 'review' && <ReviewTab />}
        {pageTab === 'report' && <ReportTab />}
      </div>
    </AppShell>
  );
}
