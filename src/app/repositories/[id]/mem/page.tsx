/**
 * `/repositories/[id]/mem?branch=<name>[&worktree=<id>]` (Issue #4227, design §2.1 G-1):
 * the items of a branch, read and written by a person. PC and phone share it; opened
 * from the repository's mem settings. `worktree=` is the worktree it was opened from
 * (its roster owns what is added); without it the screen offers the repository's
 * worktrees of the branch.
 */

'use client';

import React, { Suspense, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import { MemItemsPanel } from '@/components/mem/MemItemsPanel';

function ItemsContent(): React.ReactElement {
  const t = useTranslations('common');
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const repositoryId = params?.id ?? '';
  const branch = search?.get('branch') ?? '';
  const worktreeId = search?.get('worktree') ?? null;
  const [draft, setDraft] = useState(branch);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="break-words text-lg font-semibold text-foreground [overflow-wrap:anywhere]">{t('mem.items.title', { branch: branch || '—' })}</h1>
      <p className="text-xs text-muted-foreground">{t('mem.items.description')}</p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const next = draft.trim();
          if (next.length === 0) return;
          const query = `branch=${encodeURIComponent(next)}${worktreeId ? `&worktree=${encodeURIComponent(worktreeId)}` : ''}`;
          router.push(`/repositories/${encodeURIComponent(repositoryId)}/mem?${query}`);
        }}
      >
        <input
          type="text"
          aria-label={t('mem.decisions.branch')}
          placeholder={t('mem.decisions.branch')}
          className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-xs text-foreground"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="mem-items-branch-input"
        />
        <Button size="sm" type="submit">
          {t('mem.decisions.show')}
        </Button>
      </form>
      {branch && repositoryId && (
        <MemItemsPanel key={`${repositoryId}:${branch}`} repositoryId={repositoryId} branch={branch} worktreeId={worktreeId} />
      )}
      <p className="text-xs text-muted-foreground">{t('mem.items.limits')}</p>
    </div>
  );
}

export default function MemItemsPage(): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <ItemsContent />
    </Suspense>
  );
}
