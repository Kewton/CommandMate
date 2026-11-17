/**
 * ToolPolicyRefusalNotice — the reason of a tool-policy refusal and its links.
 *
 * Issue #4436: shared by the Report tab and the Auto-Yes toggle. The sentence
 * and the two hrefs come from the API response as they are.
 */

'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import type { ToolPolicyRefusalView } from '@/lib/tool-policy/refusal-view';

export interface ToolPolicyRefusalNoticeProps {
  refusal: ToolPolicyRefusalView;
  className?: string;
  'data-testid'?: string;
}

export function ToolPolicyRefusalNotice({
  refusal,
  className,
  'data-testid': testId = 'tool-policy-refusal',
}: ToolPolicyRefusalNoticeProps) {
  const t = useTranslations('common');
  return (
    <div className={className} role="alert" data-testid={testId}>
      <p data-testid={`${testId}-message`}>{refusal.message}</p>
      <p className="mt-1 flex flex-wrap gap-x-3">
        <a
          href={refusal.links.terms}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
          data-testid={`${testId}-terms`}
        >
          {t('toolPolicyRefusal.terms')}
        </a>
        <a
          href={refusal.links.faq}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
          data-testid={`${testId}-faq`}
        >
          {t('toolPolicyRefusal.faq')}
        </a>
      </p>
    </div>
  );
}

export default ToolPolicyRefusalNotice;
