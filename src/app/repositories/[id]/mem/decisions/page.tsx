/**
 * `/repositories/[id]/mem/decisions?branch=<name>[&item=<id>]` (Issue #4225, design §4.1): the
 * one screen where a person approves a decision's record. PC and phone share it; opened
 * from the repository's mem settings and a worktree's mem panel.
 *
 * Issue #4355 PR2 (design `docs/design/mem-decisions-ux-4355.md` §3.1): the repository and
 * then the branch are chosen with two selects (no name typed by hand). The URL keeps its
 * shape (I4): the path names the repository, `?branch=` the branch, so an old link opens
 * with both chosen — a branch the list does not hold is still shown, marked. A branch list
 * answered for a repository no longer chosen is never shown (two repositories may share a
 * branch's name).
 */

'use client';

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DecisionPromotePanel } from '@/components/mem/DecisionPromotePanel';
import { promoteApi, type DecisionBranchView, type DecisionItemWhere } from '@/lib/promote/screen-client';
import type { DecisionCounts } from '@/lib/promote/decision-counts';

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
  item: string;
  branches: DecisionBranchView[];
  where?: DecisionItemWhere;
}

/** The newest counts the panel read for one branch, with the order its read was sent in. */
interface CountsRead {
  order: number;
  counts: DecisionCounts;
}

const countsKey = (repositoryId: string, branch: string) => JSON.stringify([repositoryId, branch]);

/** The branch's row with the counts a read answered (the branch's name and the rest kept). */
function withCounts(entry: DecisionBranchView, counts: DecisionCounts): DecisionBranchView {
  return { ...entry, ...counts };
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
  const item = search?.get('item') ?? '';
  const repositories = useRepositories();
  const [read, setRead] = useState<BranchesRead | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const requestRef = useRef(0);
  /**
   * 5-2b P2: one order for every read that carries counts — the branch select's and the
   * panel's list (approvals re-read it). A count is adopted only from a read sent later
   * than the one that set it, so a late answer of an earlier read never overwrites it.
   */
  const orderRef = useRef(0);
  const nextReadOrder = useCallback(() => {
    orderRef.current += 1;
    return orderRef.current;
  }, []);
  /** The newest counts the panel read, per repository + branch. */
  const countsReadRef = useRef(new Map<string, CountsRead>());
  // Where `?item=` is depends on the branch shown; otherwise the branch does not change the list.
  const itemBranch = item ? branch : '';

  useEffect(() => {
    if (!repositoryId) return;
    requestRef.current += 1;
    const request = requestRef.current;
    const order = nextReadOrder();
    setFailedFor(null);
    void promoteApi.branches(repositoryId, item ? { item, branch: itemBranch } : {}).then((result) => {
      // An answer for an earlier choice (another repository, or another `?item=`) is not shown.
      if (request !== requestRef.current) return;
      if (!result.ok) {
        setFailedFor(repositoryId);
        return;
      }
      // A branch whose list was read after this request keeps that newer count.
      const branches = result.body.branches.map((entry) => {
        const newer = countsReadRef.current.get(countsKey(repositoryId, entry.branch));
        return newer && newer.order > order ? withCounts(entry, newer.counts) : entry;
      });
      setRead({ repositoryId, item, branches, where: result.body.item?.where });
    });
    return () => {
      requestRef.current += 1;
    };
  }, [repositoryId, item, itemBranch, nextReadOrder]);

  // The branch select follows the counts the panel reads (after each approval too), newest read first.
  const onCounts = useCallback(
    (counts: DecisionCounts, order?: number) => {
      const key = countsKey(repositoryId, branch);
      const readOrder = order ?? nextReadOrder();
      const before = countsReadRef.current.get(key);
      if (before && before.order > readOrder) return;
      countsReadRef.current.set(key, { order: readOrder, counts });
      setRead((current) => {
        if (!current || current.repositoryId !== repositoryId) return current;
        const index = current.branches.findIndex((entry) => entry.branch === branch);
        if (index < 0) return current;
        const entry = current.branches[index];
        if (entry.open === counts.open && entry.recorded === counts.recorded && entry.mode === counts.mode && entry.approvable === counts.approvable) {
          return current;
        }
        const branches = current.branches.slice();
        branches[index] = withCounts(entry, counts);
        return { ...current, branches };
      });
    },
    [branch, nextReadOrder, repositoryId]
  );

  const current = read && read.repositoryId === repositoryId ? read : null;
  const branches = current?.branches ?? null;
  const listed = branches?.some((entry) => entry.branch === branch) ?? false;
  const repositoryOptions: RepositoryOption[] = [
    ...(repositories && repositories.some((repository) => repository.id === repositoryId) ? [] : [{ id: repositoryId, name: repositoryId }]),
    ...(repositories ?? []),
  ];

  const branchLabel = (entry: DecisionBranchView): string => {
    if (entry.open === null) return t('mem.decisions.branchOption.unknown', { branch: entry.branch });
    if (!entry.approvable) return t('mem.decisions.branchOption.notApprovable', { branch: entry.branch, open: entry.open, mode: entry.mode });
    return t('mem.decisions.branchOption.pending', { branch: entry.branch, open: entry.open });
  };

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
                {branchLabel(entry)}
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
          focusItem={item ? { id: item, where: current && current.item === item ? current.where : undefined } : undefined}
          onCounts={onCounts}
          nextReadOrder={nextReadOrder}
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
