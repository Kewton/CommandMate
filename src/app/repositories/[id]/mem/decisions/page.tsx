/**
 * `/repositories/[id]/mem/decisions?branch=<name>` (Issue #4225, design §4.1): the
 * one screen where a person approves a decision's record. PC and phone share it; opened
 * from the repository's mem settings and a worktree's mem panel.
 *
 * Issue #4355 PR2 (design `docs/design/mem-decisions-ux-4355.md` §3.1): the repository and
 * then the branch are chosen with two selects (no name typed by hand). The URL keeps its
 * shape (I4): the path names the repository, `?branch=` the branch, so an old link opens
 * with both chosen — a branch the list does not hold is still shown, marked. A branch list
 * answered for a repository no longer chosen is never shown (two repositories may share a
 * branch's name).
 *
 * The branch select only chooses (5-2b, PM's disposal): its rows carry no count. The count of
 * decisions awaiting approval is the panel's, from its one list read (the line above the
 * list), so the screen never shows two reads' counts. `?item=` is not read in PR2 (design
 * §3.1.4: moved to PR3 or another PR).
 */

'use client';

import React, { Suspense, useEffect, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DecisionPromotePanel } from '@/components/mem/DecisionPromotePanel';
import { promoteApi, type DecisionBranchView } from '@/lib/promote/screen-client';

const SELECT_CLASS =
  'min-w-0 max-w-full rounded border border-border bg-surface px-2 py-1 text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring';

interface RepositoryOption {
  id: string;
  name: string;
  displayName?: string | null;
}

/** What the branch select read, and for which repository (a late answer for another is dropped). */
interface BranchesRead {
  repositoryId: string;
  branches: DecisionBranchView[];
}

const decisionsPath = (repositoryId: string, branch?: string) =>
  `/repositories/${encodeURIComponent(repositoryId)}/mem/decisions${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`;

function useRepositories(): RepositoryOption[] | null {
  const [repositories, setRepositories] = useState<RepositoryOption[] | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch('/api/repositories');
        const body = (await response.json()) as { repositories?: RepositoryOption[] };
        if (alive) setRepositories(Array.isArray(body.repositories) ? body.repositories : []);
      } catch {
        if (alive) setRepositories([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return repositories;
}

function DecisionsContent(): React.ReactElement {
  const t = useTranslations('common');
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const repositoryId = params?.id ?? '';
  const branch = search?.get('branch') ?? '';
  const repositories = useRepositories();
  const [read, setRead] = useState<BranchesRead | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!repositoryId) return;
    requestRef.current += 1;
    const request = requestRef.current;
    setFailedFor(null);
    void promoteApi.branches(repositoryId).then((result) => {
      // An answer for an earlier choice (another repository) is not shown.
      if (request !== requestRef.current) return;
      if (result.ok) setRead({ repositoryId, branches: result.body.branches });
      else setFailedFor(repositoryId);
    });
    return () => {
      requestRef.current += 1;
    };
  }, [repositoryId]);

  const current = read && read.repositoryId === repositoryId ? read : null;
  const branches = current?.branches ?? null;
  const listed = branches?.some((entry) => entry.branch === branch) ?? false;
  const repositoryOptions: RepositoryOption[] = [
    ...(repositories && repositories.some((repository) => repository.id === repositoryId) ? [] : [{ id: repositoryId, name: repositoryId }]),
    ...(repositories ?? []),
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="break-all text-lg font-semibold text-foreground">{t('mem.decisions.title', { branch: branch || '—' })}</h1>
      <div className="flex flex-wrap items-center gap-2 text-xs text-foreground">
        <label className="flex min-w-0 max-w-full items-center gap-2">
          {t('mem.decisions.repository')}
          <select
            className={SELECT_CLASS}
            value={repositoryId}
            onChange={(e) => {
              // Another repository: the branch is not carried over (a same-named branch is another's decisions).
              if (e.target.value !== repositoryId) router.push(decisionsPath(e.target.value));
            }}
            data-testid="decision-repository-select"
          >
            {repositoryOptions.map((repository) => (
              <option key={repository.id} value={repository.id}>
                {repository.displayName || repository.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 max-w-full items-center gap-2">
          {t('mem.decisions.branch')}
          <select
            className={SELECT_CLASS}
            value={branch}
            disabled={branches === null}
            onChange={(e) => {
              if (e.target.value && e.target.value !== branch) router.push(decisionsPath(repositoryId, e.target.value));
            }}
            data-testid="decision-branch-select"
          >
            {!branch && <option value="">{t('mem.decisions.chooseBranch')}</option>}
            {branch && !listed && (
              <option value={branch} data-testid="decision-branch-not-listed">
                {t('mem.decisions.branchOption.notListed', { branch })}
              </option>
            )}
            {(branches ?? []).map((entry) => (
              <option key={entry.branch} value={entry.branch}>
                {entry.branch}
              </option>
            ))}
          </select>
        </label>
      </div>
      {failedFor === repositoryId ? (
        <p role="alert" className="text-xs text-danger-foreground" data-testid="decision-branches-error">
          {t('mem.decisions.branchesError')}
        </p>
      ) : branches === null ? (
        <p className="text-xs text-muted-foreground">{t('mem.decisions.branchesLoading')}</p>
      ) : (
        branches.length === 0 &&
        !branch && (
          <p className="text-xs text-muted-foreground" data-testid="decision-no-branches">
            {t('mem.decisions.noBranches')}
          </p>
        )
      )}
      {branch && repositoryId && (
        <DecisionPromotePanel
          key={`${repositoryId}:${branch}`}
          repositoryId={repositoryId}
          branch={branch}
        />
      )}
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
