/**
 * useBranches (Issue #781, extracted in #922)
 *
 * Owns the Branches state: the branch list for the current include filter, the
 * busy / error flags, and the list / checkout / create / delete handlers. NO new
 * 5s poll (S3-005): fetched on mount + on include change + after a mutation.
 * Checkout moves HEAD, so its success runs the cross-section cascade
 * (`onCheckoutCascade`: status + staged + commit history) alongside this hook's
 * own branch refetch. Create / delete leave HEAD unchanged → refetch branches
 * only. `fetchBranches` is exposed so the reset/revert and network cascades can
 * refresh ahead/behind freshness.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { BranchInfo, BranchInclude } from '@/types/git';

export interface UseBranchesOptions {
  /**
   * Cross-section refresh run after a checkout (HEAD moved): current status +
   * changes + commit history. This hook adds its own branch refetch in parallel.
   */
  onCheckoutCascade: () => Promise<void>;
}

export interface UseBranchesResult {
  branches: BranchInfo[];
  branchInclude: BranchInclude;
  branchesLoading: boolean;
  branchesError: string | null;
  branchBusy: boolean;
  branchActionError: string | null;
  fetchBranches: (include: BranchInclude) => Promise<void>;
  handleBranchIncludeChange: (include: BranchInclude) => void;
  handleBranchesRefresh: () => void;
  handleCheckout: (branch: BranchInfo, force: boolean) => Promise<void>;
  handleBranchCreate: (name: string, from: string | undefined) => Promise<void>;
  handleBranchDelete: (name: string, force: boolean) => Promise<void>;
}

export function useBranches(worktreeId: string, options: UseBranchesOptions): UseBranchesResult {
  const { onCheckoutCascade } = options;

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchInclude, setBranchInclude] = useState<BranchInclude>('local');
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchActionError, setBranchActionError] = useState<string | null>(null);

  /**
   * Fetch the branch list for the current include filter. Read-only; failures
   * surface inline and never affect the other sections. NO new 5s poll (S3-005):
   * fetched on mount + on include change + after a mutation.
   */
  const fetchBranches = useCallback(async (include: BranchInclude) => {
    setBranchesError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/branches?include=${include}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setBranchesError(data.error || 'Failed to fetch branches');
        return;
      }
      const data = await response.json();
      setBranches(Array.isArray(data.branches) ? data.branches : []);
    } catch {
      setBranchesError('Failed to fetch branches');
    } finally {
      setBranchesLoading(false);
    }
  }, [worktreeId]);

  // Mount fetch + refetch when the include tab changes.
  useEffect(() => {
    fetchBranches(branchInclude);
  }, [fetchBranches, branchInclude]);

  const handleBranchIncludeChange = useCallback((include: BranchInclude) => {
    setBranchInclude(include);
  }, []);

  const handleBranchesRefresh = useCallback(() => {
    fetchBranches(branchInclude);
  }, [fetchBranches, branchInclude]);

  /**
   * Checkout a branch. On success run the S3-005 cascade (status + staged +
   * branches + commit history) so every dependent section reflects the new HEAD.
   */
  const handleCheckout = useCallback(async (branch: BranchInfo, force: boolean) => {
    setBranchBusy(true);
    setBranchActionError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: branch.name, force }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setBranchActionError(data.error || 'Failed to checkout branch');
        return;
      }
      // S3-005 cascade: HEAD changed -> refetch everything affected.
      await Promise.all([onCheckoutCascade(), fetchBranches(branchInclude)]);
    } catch {
      setBranchActionError('Failed to checkout branch');
    } finally {
      setBranchBusy(false);
    }
  }, [worktreeId, branchInclude, onCheckoutCascade, fetchBranches]);

  /**
   * Create a branch (no checkout). On success only the branch list changes
   * (HEAD unchanged), so refetch branches only (S3-005).
   */
  const handleBranchCreate = useCallback(async (name: string, from: string | undefined) => {
    setBranchBusy(true);
    setBranchActionError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/branch/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, from }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setBranchActionError(data.error || 'Failed to create branch');
        return;
      }
      await fetchBranches(branchInclude);
    } catch {
      setBranchActionError('Failed to create branch');
    } finally {
      setBranchBusy(false);
    }
  }, [worktreeId, branchInclude, fetchBranches]);

  /**
   * Delete a branch. On success only the branch list changes (HEAD unchanged),
   * so refetch branches only (S3-005).
   */
  const handleBranchDelete = useCallback(async (name: string, force: boolean) => {
    setBranchBusy(true);
    setBranchActionError(null);
    try {
      const response = await fetch(`/api/worktrees/${worktreeId}/git/branch/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, force }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setBranchActionError(data.error || 'Failed to delete branch');
        return;
      }
      await fetchBranches(branchInclude);
    } catch {
      setBranchActionError('Failed to delete branch');
    } finally {
      setBranchBusy(false);
    }
  }, [worktreeId, branchInclude, fetchBranches]);

  return {
    branches,
    branchInclude,
    branchesLoading,
    branchesError,
    branchBusy,
    branchActionError,
    fetchBranches,
    handleBranchIncludeChange,
    handleBranchesRefresh,
    handleCheckout,
    handleBranchCreate,
    handleBranchDelete,
  };
}
