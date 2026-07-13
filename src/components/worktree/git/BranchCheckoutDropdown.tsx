/**
 * BranchCheckoutDropdown (Issue #815)
 *
 * Promotes branch *checkout* out of the (now Advanced-collapsed) Branches section
 * into a core, always-visible dropdown placed beside the Quick actions row. This
 * is a pure information-design extraction: the checkout confirm dialog — S3-001
 * history-loss warning, S3-002 running-session warning, and the force checkbox —
 * is preserved verbatim (same data-testids, same onCheckout contract) from the
 * original BranchesSection. No handler/API behavior changes.
 */

'use client';

import React, { memo, useCallback, useState } from 'react';
import type { BranchInfo } from '@/types/git';
import {
  CHECKOUT_HISTORY_LOSS_WARNING,
  CHECKOUT_RUNNING_SESSION_WARNING,
} from '@/config/git-status-config';
import { Button, Checkbox } from '@/components/ui';

interface BranchCheckoutDropdownProps {
  branches: BranchInfo[];
  /** Disables the trigger + confirm while a branch mutation / network write is in-flight. */
  busy: boolean;
  /** Inline checkout error (shared branch action error state). */
  actionError: string | null;
  /** True when any CLI session is running for this worktree (S3-002). */
  hasRunningSession: boolean;
  isMobile: boolean;
  onCheckout: (branch: BranchInfo, force: boolean) => void;
}

/**
 * Core checkout dropdown. The branch list (excluding the current branch) is
 * surfaced as a disclosure menu; selecting a branch opens the same checkout
 * confirm dialog the Branches section used to host.
 */
export const BranchCheckoutDropdown = memo(function BranchCheckoutDropdown({
  branches,
  busy,
  actionError,
  hasRunningSession,
  isMobile,
  onCheckout,
}: BranchCheckoutDropdownProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [checkoutTarget, setCheckoutTarget] = useState<BranchInfo | null>(null);
  const [checkoutForce, setCheckoutForce] = useState(false);

  // Checkout-able branches = everything except the one currently checked out here.
  const options = branches.filter((b) => !b.isCurrent);

  const openCheckout = useCallback((branch: BranchInfo) => {
    setCheckoutForce(false);
    setCheckoutTarget({ ...branch });
    setMenuOpen(false);
  }, []);

  const confirmCheckout = useCallback(() => {
    if (!checkoutTarget) return;
    onCheckout(checkoutTarget, checkoutForce);
    setCheckoutTarget(null);
  }, [checkoutTarget, checkoutForce, onCheckout]);

  return (
    <div className="relative" data-testid="branch-checkout-dropdown">
      <Button
        variant="ghost"
        type="button"
        onClick={() => setMenuOpen((prev) => !prev)}
        disabled={busy || options.length === 0}
        className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-input text-accent-700 dark:text-accent-300 hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid="branch-checkout-dropdown-toggle"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Checkout branch"
      >
        Checkout
        <span aria-hidden="true" className="text-[10px]">▾</span>
      </Button>

      {menuOpen && (
        <div
          className="absolute left-0 top-full z-20 mt-1 min-w-[12rem] max-h-64 overflow-y-auto rounded border border-border bg-surface shadow-lg"
          role="menu"
          data-testid="branch-checkout-menu"
        >
          {options.length === 0 ? (
            <div className="px-3 py-1.5 text-xs text-muted-foreground">No branches</div>
          ) : (
            <ul className="divide-y divide-border">
              {options.map((branch) => {
                const checkedOutElsewhere = branch.checkedOutWorktreePath !== null;
                return (
                  <li key={`${branch.isRemote ? 'r' : 'l'}:${branch.name}`}>
                    {/* Issue #1061: full-width left-aligned menu row — 残置 */}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => openCheckout(branch)}
                      disabled={busy || checkedOutElsewhere}
                      className="w-full text-left px-3 py-1.5 font-mono text-xs text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label={`Checkout ${branch.name}`}
                      title={
                        checkedOutElsewhere
                          ? `Checked out in another worktree: ${branch.checkedOutWorktreePath}`
                          : undefined
                      }
                    >
                      {branch.name}
                      {branch.isDefault && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground">default</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {actionError && (
        <div
          className="mt-1 text-xs text-danger-foreground"
          role="alert"
          data-testid="branch-checkout-error"
        >
          {actionError}
        </div>
      )}

      {/* Checkout confirm dialog (moved verbatim from BranchesSection, Issue #781) */}
      {checkoutTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          data-testid="branch-checkout-confirm"
        >
          <div className="w-full max-w-md rounded-lg bg-surface p-4 shadow-xl flex flex-col gap-3">
            <h3 className="text-sm font-medium text-foreground">
              Checkout <span className="font-mono">{checkoutTarget.name}</span>?
            </h3>

            {/* S3-001: history-loss warning (verified verbatim by acceptance test). */}
            <div
              className="rounded border border-warning-border bg-warning-subtle px-3 py-2 text-xs text-warning-foreground"
              role="alert"
              data-testid="branch-history-loss-warning"
            >
              {CHECKOUT_HISTORY_LOSS_WARNING}
            </div>

            {/* S3-002: running-session warning. */}
            {hasRunningSession && (
              <div
                className="rounded border border-danger-border bg-danger-subtle px-3 py-2 text-xs text-danger-foreground"
                role="alert"
                data-testid="branch-session-warning"
              >
                {CHECKOUT_RUNNING_SESSION_WARNING}
              </div>
            )}

            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={checkoutForce}
                onCheckedChange={(checked) => setCheckoutForce(checked === true)}
                data-testid="branch-checkout-force"
              />
              Discard uncommitted changes (force) — 未コミットの変更は失われます
            </label>

            <div className={`flex items-center justify-end gap-2 ${isMobile ? 'flex-wrap' : ''}`}>
              <Button
                variant="ghost"
                type="button"
                onClick={() => setCheckoutTarget(null)}
                className="px-3 py-1 text-xs rounded border border-input text-foreground hover:bg-muted"
              >
                Cancel
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={confirmCheckout}
                disabled={busy}
                className="px-3 py-1 text-xs font-medium rounded bg-accent-600 text-white hover:bg-accent-700 disabled:opacity-50"
                data-testid="branch-checkout-confirm-button"
              >
                Checkout
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default BranchCheckoutDropdown;
