/**
 * `/repositories/[id]/mem/decisions?branch=<name>` (Issue #4225, design §4.1): the one
 * screen where a person approves a decision's record. PC and phone share it; opened
 * from the repository's mem settings.
 */

'use client';

import React, { Suspense, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { DecisionPromotePanel } from '@/components/mem/DecisionPromotePanel';

function DecisionsContent(): React.ReactElement {
  const t = useTranslations('common');
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const repositoryId = params?.id ?? '';
  const branch = search?.get('branch') ?? '';
  const [draft, setDraft] = useState(branch);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="text-lg font-semibold text-foreground">{t('mem.decisions.title', { branch: branch || '—' })}</h1>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const next = draft.trim();
          if (next.length > 0) router.push(`/repositories/${encodeURIComponent(repositoryId)}/mem/decisions?branch=${encodeURIComponent(next)}`);
        }}
      >
        <input
          type="text"
          aria-label={t('mem.decisions.branch')}
          placeholder={t('mem.decisions.branch')}
          className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-xs text-foreground"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="decision-branch-input"
        />
        <Button size="sm" type="submit">
          {t('mem.decisions.show')}
        </Button>
      </form>
      {branch && repositoryId && <DecisionPromotePanel key={`${repositoryId}:${branch}`} repositoryId={repositoryId} branch={branch} />}
    </div>
  );
}

export default function MemDecisionsPage(): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <DecisionsContent />
    </Suspense>
  );
}
