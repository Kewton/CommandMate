/**
 * FeedbackSection Component
 * Issue #264: User feedback links
 *
 * [SRP] Independent component following VersionSection pattern (Issue #257 SF-001).
 * Used in both InfoModal and MobileInfoContent for DRY compliance.
 *
 * [SF-CONS-004] Props: className only (no data dependency, unlike VersionSection).
 *
 * [SEC-SF-003] URL Immutability: All link URLs are fully defined as constants
 * from github-links.ts. No dynamic URL construction or user input mixing.
 *
 * @module components/worktree/FeedbackSection
 */

'use client';

import { useTranslations } from 'next-intl';
import {
  GITHUB_BUG_REPORT_URL,
  GITHUB_FEATURE_REQUEST_URL,
  GITHUB_QUESTION_URL,
  GITHUB_ISSUES_URL,
} from '@/config/github-links';

/**
 * Props for FeedbackSection.
 * [CONS-005] className allows parent to specify container styling
 * (InfoModal: bg-gray-50, MobileInfoContent: bg-white border).
 */
export interface FeedbackSectionProps {
  className?: string;
}

/**
 * Feedback and support links section.
 * Displays links to GitHub issue templates and issue list.
 */
export function FeedbackSection({ className }: FeedbackSectionProps) {
  const t = useTranslations('worktree');

  const links = [
    { href: GITHUB_BUG_REPORT_URL, label: t('feedback.bugReport') },
    { href: GITHUB_FEATURE_REQUEST_URL, label: t('feedback.featureRequest') },
    { href: GITHUB_QUESTION_URL, label: t('feedback.question') },
    { href: GITHUB_ISSUES_URL, label: t('feedback.viewIssues') },
  ];

  return (
    <div className={className} data-testid="feedback-section">
      <h2 className="text-sm font-medium text-gray-500 mb-2">
        {t('feedback.title')}
      </h2>
      <div className="flex flex-col gap-1">
        {links.map(({ href, label }) => (
          <a
            key={href}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center text-sm text-blue-600 hover:text-blue-800 underline"
          >
            {label}
            <span className="ml-1" aria-hidden="true">&rarr;</span>
          </a>
        ))}
      </div>
    </div>
  );
}
