/**
 * BranchCheckoutDropdown (Issue #815)
 *
 * Promotes branch *checkout* out of the (now Advanced-collapsed) Branches section
 * into a core, always-visible dropdown placed beside the Quick actions row. This
 * is a pure information-design extraction: the checkout confirm dialog — S3-001
 * history-loss warning, S3-002 running-session warning, and the force checkbox —
 * is preserved verbatim (same data-testids, same onCheckout contract) from the
 * original BranchesSection. No handler/API behavior changes.
 *
 * [Issue #1363] The menu was `absolute top-full z-20` inside the Git pane's
 * `overflow-y-auto` scroll container, so it was clipped by that ancestor, ran
 * off the bottom of the viewport when the trigger sat low (up to 256px of menu
 * with no flip), and sat below other overlays. It is now rendered through a
 * portal to `document.body` as a `fixed` element that flips above the trigger
 * when it does not fit below and is clamped into the viewport on both axes.
 */

'use client';

import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { BranchInfo } from '@/types/git';
import { Button, Checkbox } from '@/components/ui';

/**
 * `useLayoutEffect` is a no-op on the server and React warns when it is called
 * during server rendering; fall back to `useEffect` there. Mirrors the same
 * guard in `useIsMobile`.
 */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** Gap (px) between the trigger and the portaled menu. */
const MENU_GAP = 4;

/** Viewport inset (px) kept clear on every side when clamping the menu. */
const VIEWPORT_MARGIN = 8;

interface MenuCoords {
  top: number;
  left: number;
}

/**
 * Clamps one axis of the menu's start edge so the whole bubble stays inside the
 * viewport. When the menu is larger than the viewport the lower bound wins, so
 * its start (top / left) stays reachable rather than being pushed off-screen.
 */
function clampAxis(value: number, menuSize: number, viewportSize: number): number {
  const max = viewportSize - menuSize - VIEWPORT_MARGIN;
  return Math.max(VIEWPORT_MARGIN, Math.min(value, max));
}

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
  const t = useTranslations('worktree');
  const tCommon = useTranslations('common');
  const [menuOpen, setMenuOpen] = useState(false);
  const [checkoutTarget, setCheckoutTarget] = useState<BranchInfo | null>(null);
  const [checkoutForce, setCheckoutForce] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // `null` until measured; the menu is parked off-screen meanwhile so it is
  // never painted at (0,0) first. [Issue #1363]
  const [coords, setCoords] = useState<MenuCoords | null>(null);

  // Checkout-able branches = everything except the one currently checked out here.
  const options = branches.filter((b) => !b.isCurrent);

  /**
   * Measures the trigger and the (already mounted, off-screen) menu, flips the
   * menu above the trigger when it does not fit below, and clamps both axes
   * into the viewport. [Issue #1363]
   */
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu || typeof window === 'undefined') return;

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;

    // Flip up only when the menu genuinely does not fit below AND there is more
    // room above — otherwise keep the familiar downward placement.
    const flipUp =
      spaceBelow < menuRect.height + MENU_GAP + VIEWPORT_MARGIN && spaceAbove > spaceBelow;
    const top = flipUp
      ? triggerRect.top - menuRect.height - MENU_GAP
      : triggerRect.bottom + MENU_GAP;

    setCoords({
      top: clampAxis(top, menuRect.height, window.innerHeight),
      left: clampAxis(triggerRect.left, menuRect.width, window.innerWidth),
    });
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (!menuOpen) {
      setCoords(null);
      return;
    }
    updatePosition();
    // The menu is `fixed` and no longer travels with the Git pane's scroll
    // container, so follow ancestor scrolls (capture: true) and viewport
    // resizes to keep it anchored to the trigger.
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
    // `options.length` re-measures when the branch list loads while the menu is open.
  }, [menuOpen, options.length, updatePosition]);

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
    <div className="relative" ref={triggerRef} data-testid="branch-checkout-dropdown">
      <Button
        variant="ghost"
        type="button"
        onClick={() => setMenuOpen((prev) => !prev)}
        disabled={busy || options.length === 0}
        className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-input text-accent-700 dark:text-accent-300 hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid="branch-checkout-dropdown-toggle"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t('git.checkout.ariaLabel')}
      >
        {t('git.checkout.action')}
        <span aria-hidden="true" className="text-[10px]">▾</span>
      </Button>

      {menuOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-50 min-w-[12rem] max-w-[calc(100vw-1rem)] max-h-64 overflow-y-auto rounded border border-border bg-surface shadow-lg"
            style={{ top: coords?.top ?? -9999, left: coords?.left ?? -9999 }}
            role="menu"
            data-testid="branch-checkout-menu"
          >
            {options.length === 0 ? (
              <div className="px-3 py-1.5 text-xs text-muted-foreground">
                {t('git.checkout.noBranches')}
              </div>
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
                        aria-label={t('git.checkout.checkoutBranch', { name: branch.name })}
                        title={
                          checkedOutElsewhere
                            ? t('git.checkout.checkedOutElsewhere', {
                                path: branch.checkedOutWorktreePath ?? '',
                              })
                            : undefined
                        }
                      >
                        {branch.name}
                        {branch.isDefault && (
                          <span className="ml-1.5 text-[10px] text-muted-foreground">
                            {t('git.checkout.defaultBadge')}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>,
          document.body
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
              {t('git.checkout.confirmTitlePrefix')}
              <span className="font-mono">{checkoutTarget.name}</span>
              {t('git.checkout.confirmTitleSuffix')}
            </h3>

            {/* S3-001: history-loss warning (verified verbatim by acceptance test). */}
            <div
              className="rounded border border-warning-border bg-warning-subtle px-3 py-2 text-xs text-warning-foreground"
              role="alert"
              data-testid="branch-history-loss-warning"
            >
              {t('git.checkout.historyLossWarning')}
            </div>

            {/* S3-002: running-session warning. */}
            {hasRunningSession && (
              <div
                className="rounded border border-danger-border bg-danger-subtle px-3 py-2 text-xs text-danger-foreground"
                role="alert"
                data-testid="branch-session-warning"
              >
                {t('git.checkout.runningSessionWarning')}
              </div>
            )}

            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={checkoutForce}
                onCheckedChange={(checked) => setCheckoutForce(checked === true)}
                data-testid="branch-checkout-force"
              />
              {t('git.checkout.forceLabel')}
            </label>

            <div className={`flex items-center justify-end gap-2 ${isMobile ? 'flex-wrap' : ''}`}>
              <Button
                variant="ghost"
                type="button"
                onClick={() => setCheckoutTarget(null)}
                className="px-3 py-1 text-xs rounded border border-input text-foreground hover:bg-muted"
              >
                {tCommon('cancel')}
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={confirmCheckout}
                disabled={busy}
                className="px-3 py-1 text-xs font-medium rounded bg-accent-600 text-white hover:bg-accent-700 disabled:opacity-50"
                data-testid="branch-checkout-confirm-button"
              >
                {t('git.checkout.action')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default BranchCheckoutDropdown;
