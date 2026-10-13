
/**
 * VerificationStatusChip (Issue #1816, Issue #2064)
 *
 * The worktree detail header's answer to "what was this branch told to do, and
 * did it pass?" — the two facts that until now existed only in `commandmate
 * task show` / `verify` stdout.
 *
 * Shown by both surfaces: on PC the second row under the header (the split
 * action bar's `actionBarItems`, next to the layout icons — Issue #3590; it sat
 * in `DesktopHeader` before) and the mobile shell.
 *
 * Issue #2064 — the chip is an ENTRY POINT, so it no longer hides itself on a
 * branch that was never delegated with a contract. The people who most need to
 * find Verification are exactly the ones who have never sent a contract, and
 * the old `if (!task) return null` meant the feature was invisible to them.
 * With no task row the chip names the pane and reports the branch as *not
 * verified*, which is a fact worth stating rather than noise.
 *
 * Discoverability (`docs/design/discoverability-principle.md`, 実装規約 1): the
 * chip carries the *reason* for its verdict, not just the verdict. Until #2064
 * the reason lived in `aria-label` and `title` only — reachable by screen
 * reader and by mouse hover, and by nothing at all on a touch device. It now
 * also has its own toggle (the ⓘ button) that opens the reason as a popover, so
 * a finger reaches the same text a pointer does. Nothing here is hover-revealed:
 * the chip, both badges and the toggle are always painted.
 *
 * Issue #2062 replaces the raw status tokens the badges printed (`passed`,
 * `not_started` — identical in both locales) with translated labels, and adds
 * the verdict's one-line gloss to the reason list so the popover explains the
 * badge instead of repeating it.
 *
 * @module components/worktree/VerificationStatusChip
 */

'use client';

import React, {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Info, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import {
  FAILING_GATE_STATUSES,
  RUN_STATUS_VARIANT,
  TASK_STATUS_VARIANT,
} from '@/config/verification-display';
import type {
  TaskView,
  VerificationGateResultView,
  VerificationRunListItem,
} from '@/lib/api/verification-api';
import { isUnhandledEscape } from '@/lib/escape-key';

/** Characters of the task title kept inline before ellipsis. */
const TITLE_MAX_LENGTH = 36;

export interface VerificationStatusChipProps {
  /**
   * Latest task for this worktree, or `null` when the branch was never
   * delegated with an execution contract. Issue #2064: `null` no longer hides
   * the chip — it selects the "no contract" wording.
   */
  task: TaskView | null;
  /** Latest verification run, or `null` when the branch has never been verified. */
  latestRun: VerificationRunListItem | null;
  /**
   * Gate rows belonging to {@link latestRun}, when the caller happens to have
   * them loaded.
   *
   * Both shells derive this from the Verification pane's *selected* run, so
   * they stop supplying it the moment the operator selects an older run in the
   * pane. The failing gate ids are the actionable half of the reason, so the
   * chip keeps the last rows it was given for this same run id instead of
   * letting the header go quiet — see {@link useGatesOfLatestRun} (Issue #2064).
   */
  latestRunGates?: VerificationGateResultView[] | null;
  /** Open the Verification pane. */
  onOpen: () => void;
  /**
   * Issue #3591: whether the Verification pane is open. On PC the chip toggles
   * the pane, so while it is open the hint in the title / accessible name /
   * reason says "close". Omitted (the mobile shell, where the chip only
   * opens), the hint always says "open".
   */
  paneOpen?: boolean;
  className?: string;
  /**
   * Where the reason popover is drawn (Issue #3590).
   *
   * - `inline` (default, the mobile shell): absolutely positioned under the
   *   chip, inside its own box.
   * - `floating` (PC): portalled to `<body>` and placed with `position: fixed`
   *   under the chip, kept inside the viewport. The PC chip sits in the split
   *   action bar, whose left group clips on a narrow bar and whose terminal
   *   pane is `overflow-hidden` beside an open file panel — an inline popover
   *   was cut there. It follows the chip while open (re-read every frame).
   *   The content and the open / close rules are the same.
   */
  popover?: 'inline' | 'floating';
}

/** Width of the reason popover (`w-72`), and its gap to the viewport edge. */
const POPOVER_WIDTH_PX = 288;
const POPOVER_EDGE_PX = 8;

/**
 * Where the floating popover goes: under `anchor`, left-aligned with it,
 * shifted left as far as needed to stay inside the viewport.
 */
function floatingPosition(anchor: DOMRect): { top: number; left: number; width: number } {
  const viewport = typeof window === 'undefined' ? POPOVER_WIDTH_PX : window.innerWidth;
  const width = Math.min(POPOVER_WIDTH_PX, Math.max(0, viewport - POPOVER_EDGE_PX * 2));
  const left = Math.max(
    POPOVER_EDGE_PX,
    Math.min(anchor.left, viewport - width - POPOVER_EDGE_PX)
  );
  return { top: anchor.bottom + 4, left, width };
}

/**
 * Whether the chip is on screen: in the page and not inside a hidden box
 * (Issue #3592 — it leaves the page while it waits behind a closed "…").
 */
function isShown(el: HTMLElement | null): boolean {
  if (!el || !el.isConnected) return false;
  return typeof el.checkVisibility !== 'function' || el.checkVisibility();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Gate rows for `latestRun`, held across changes of the pane's selection.
 *
 * Issue #2064: `latestRunGates` arrives only while the pane's selected run *is*
 * the latest one, which is the default but stops being true as soon as the
 * operator browses history. The rows are keyed by run id, so a genuinely new
 * run clears them rather than showing the previous run's failures under the new
 * verdict.
 *
 * Issue #3590: exported so a parent that outlives the chip can hold them too.
 * On PC the chip sits in the split action bar, which `FilePanelSplit` remounts
 * when the first file opens or the last one closes; a ref held only here would
 * go with it (`useDesktopVerificationChip` calls this one level up).
 */
export function useGatesOfLatestRun(
  latestRun: VerificationRunListItem | null,
  supplied: VerificationGateResultView[] | null | undefined
): VerificationGateResultView[] | null {
  const heldRef = useRef<{ runId: number; gates: VerificationGateResultView[] } | null>(null);

  if (latestRun !== null && supplied && supplied.length > 0) {
    heldRef.current = { runId: latestRun.id, gates: supplied };
  }
  if (supplied && supplied.length > 0) return supplied;
  if (latestRun !== null && heldRef.current?.runId === latestRun.id) return heldRef.current.gates;
  return null;
}

export const VerificationStatusChip = memo(function VerificationStatusChip({
  task,
  latestRun,
  latestRunGates,
  onOpen,
  paneOpen = false,
  className = '',
  popover = 'inline',
}: VerificationStatusChipProps) {
  const t = useTranslations('worktree');
  const [reasonOpen, setReasonOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [floatingAt, setFloatingAt] = useState<{ top: number; left: number; width: number } | null>(
    null
  );
  const popoverId = useId();

  const gates = useGatesOfLatestRun(latestRun, latestRunGates);

  /**
   * The reason, one clause per fact. Rendered as a list inside the popover and
   * joined into the accessible name of the chip itself, so the two channels can
   * never say different things.
   */
  const reasonParts = useMemo(() => {
    const parts: string[] = [
      task
        ? t('verification.chip.taskReason', {
            title: task.title,
            status: t(`task.status.${task.status}`),
          })
        : t('verification.chip.noTask'),
    ];

    if (!latestRun) {
      parts.push(t('verification.chip.noRun'));
    } else {
      parts.push(
        t('verification.chip.runReason', {
          verdict: t(`verification.runStatus.${latestRun.status}`),
          runId: latestRun.id,
        })
      );
      // Issue #2062: the verdict word alone is not the reason. `Not started` in
      // particular reads as "nothing happened yet" when it actually means the
      // branch holds no work at all — the verdict `commandmate verify` exits 21
      // for. The gloss is one clause of the reason, so it goes in the same list
      // the popover and the accessible name are both built from.
      parts.push(t(`verification.runStatusGloss.${latestRun.status}`));
      if (gates && gates.length > 0) {
        const failing = gates.filter((gate) => FAILING_GATE_STATUSES.includes(gate.status));
        parts.push(
          failing.length > 0
            ? t('verification.chip.failingGates', {
                gates: failing.map((gate) => gate.gateId).join(', '),
              })
            : t('verification.chip.gatesPassed', { count: gates.length })
        );
      }
    }

    parts.push(t(paneOpen ? 'verification.chip.closeHint' : 'verification.chip.openHint'));
    return parts;
  }, [task, latestRun, gates, paneOpen, t]);

  const reason = reasonParts.join(' · ');

  const handleOpen = useCallback(() => {
    setReasonOpen(false);
    onOpen();
  }, [onOpen]);

  const reasonToggleRef = useRef<HTMLButtonElement | null>(null);
  const toggleReason = useCallback(() => {
    // Issue #3660: opening puts the keyboard on ⓘ (Safari does not focus a
    // clicked button), so the next Escape lands in the chip and the chip's
    // own `onKeyDown` below can claim it.
    if (!reasonOpen) reasonToggleRef.current?.focus();
    setReasonOpen(!reasonOpen);
  }, [reasonOpen]);

  // Issue #3660: an Escape pressed in the chip while the reason is up is the
  // reason's alone. The overlaid activity pane treats the chip as one of its
  // Esc regions (`[data-activity-entry]`) and the "…" panel the chip can fold
  // into closes on any Escape; both listen on the document and opened before
  // the reason did, so claiming the press in the document listener below would
  // come too late. React's handler runs at the root, before the document, and
  // `preventDefault` makes both stand down (the header tools' "…" claims its
  // Escape the same way). The reason keeps `data-floating-layer="true"` — a
  // press in it is only "not outside" for the "…" panel.
  const handleRootKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!reasonOpen || !isUnhandledEscape(event.nativeEvent)) return;
      event.preventDefault();
      setReasonOpen(false);
    },
    [reasonOpen]
  );

  // Dismiss on Escape or a press outside. `pointerdown` rather than `click` so
  // the popover is gone before the press lands on whatever is underneath it.
  useEffect(() => {
    if (!reasonOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      // Issue #3590: a floating popover lives outside the root.
      if (popoverRef.current?.contains(event.target as Node)) return;
      // Issue #3592: while the chip waits out of sight (behind a closed "…"),
      // its reason is hidden too, so there is no "outside" to press — the
      // press on "…" that brings the chip back must not close it.
      if (!isShown(rootRef.current)) return;
      setReasonOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Issue #3592: an Escape a layer above already handled (a menu closing
      // itself — Radix calls `preventDefault`) is not ours to act on.
      // Issue #3591: the header tools' "…" list closing itself is one too.
      if (!isUnhandledEscape(event)) return;
      setReasonOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [reasonOpen]);

  // Issue #3590: place the floating popover before paint, and keep it under
  // the chip for as long as it is open. The chip can move without anything
  // resizing (the window or a scroll aside, the split action bar gains a
  // "Split n maximized" label left of it when Mod+Shift+Enter maximizes a
  // split), so the position is re-read once per frame while open — one
  // `getBoundingClientRect` per frame, for one popover, only while it is
  // shown. An unchanged position keeps the same state object (no re-render).
  useLayoutEffect(() => {
    if (!reasonOpen || popover !== 'floating') {
      setFloatingAt(null);
      return;
    }
    let frame = 0;
    const place = () => {
      // Issue #3592: the chip leaves the page while it waits behind a closed
      // "…": a detached (or hidden) root measures as a zero box at the
      // viewport's corner, so the reason would sit at the top left. Hide it
      // instead — still open — and place it again once the chip is back.
      const root = rootRef.current;
      if (!root || !isShown(root)) {
        setFloatingAt((prev) => (prev === null ? prev : null));
        return;
      }
      const anchor = root.getBoundingClientRect();
      const next = floatingPosition(anchor);
      setFloatingAt((prev) =>
        prev && prev.top === next.top && prev.left === next.left && prev.width === next.width
          ? prev
          : next
      );
    };
    const follow = () => {
      place();
      frame = window.requestAnimationFrame(follow);
    };
    place();
    frame = window.requestAnimationFrame(follow);
    return () => window.cancelAnimationFrame(frame);
  }, [reasonOpen, popover]);

  const reasonBody = (
    <>
      <p className="mb-1 font-semibold">{t('verification.chip.reasonHeading')}</p>
      <ul className="space-y-1">
        {reasonParts.map((part) => (
          <li key={part} className="break-words">
            {part}
          </li>
        ))}
      </ul>
    </>
  );

  return (
    <div
      ref={rootRef}
      // Issue #3591: the Verification pane's entry point on PC (the header's
      // tools leave it out). The worktree screen hands focus back to this
      // chip's first button when the pane closes, and a press on it — the
      // chip or its ⓘ — is not "outside" the open pane.
      data-activity-entry="verification"
      onKeyDown={handleRootKeyDown}
      className={`relative inline-flex max-w-full ${className}`.trim()}
    >
      {/* `grow`: the mobile shell passes `w-full justify-start` to the root, and
          the pill used to be the root — without it the strip would go from a
          full-width chip to one that hugs its text. */}
      <div className="inline-flex min-w-0 max-w-full grow items-center gap-1 rounded-full border border-border bg-surface-2 pr-1 text-xs text-foreground">
        <button
          type="button"
          onClick={handleOpen}
          data-testid="verification-status-chip"
          aria-label={reason}
          // Kept for pointer users; #2064 makes it the redundant channel rather
          // than the only one.
          title={reason}
          className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-full px-2 py-1 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
        >
          <ShieldCheck size={14} aria-hidden="true" className="flex-shrink-0 text-muted-foreground" />
          <span className="truncate font-medium" data-testid="verification-chip-title">
            {task ? truncate(task.title, TITLE_MAX_LENGTH) : t('verification.title')}
          </span>
          {/* No task row means there is no task status to report; the run badge
              below still says where the branch stands. */}
          {task && (
            <Badge
              variant={TASK_STATUS_VARIANT[task.status]}
              className="flex-shrink-0 px-1.5 py-0"
              data-testid="verification-chip-task-status"
            >
              {t(`task.status.${task.status}`)}
            </Badge>
          )}
          {/* Prefixed with the CLI's own `RESULT` keyword: without it the two
              badges read as one status repeated twice whenever a task and its run
              share a word (`failed`, `not_started`). */}
          <Badge
            variant={latestRun ? RUN_STATUS_VARIANT[latestRun.status] : 'gray'}
            className="flex-shrink-0 px-1.5 py-0 font-mono"
            data-testid="verification-chip-run-status"
          >
            {latestRun
              ? t('verification.chip.resultBadge', {
                  verdict: t(`verification.runStatus.${latestRun.status}`),
                })
              : t('verification.chip.unverified')}
          </Badge>
        </button>
        {/* Issue #2064: the reason on a touch device. A second control rather
            than a gesture on the chip itself, because the chip's tap has to keep
            meaning "open the pane". */}
        <button
          type="button"
          ref={reasonToggleRef}
          onClick={toggleReason}
          data-testid="verification-chip-reason-toggle"
          aria-expanded={reasonOpen}
          aria-controls={popoverId}
          aria-label={t(reasonOpen ? 'verification.chip.hideReason' : 'verification.chip.showReason')}
          className="inline-flex min-h-[32px] min-w-[32px] flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
        >
          <Info size={14} aria-hidden="true" />
        </button>
      </div>
      {reasonOpen && popover === 'inline' && (
        <div
          id={popoverId}
          role="tooltip"
          data-testid="verification-chip-reason-popover"
          className="absolute left-0 top-full z-50 mt-1 w-72 max-w-[80vw] rounded-lg border border-border bg-surface p-3 text-xs leading-relaxed text-foreground shadow-lg"
        >
          {reasonBody}
        </div>
      )}
      {/* Issue #3590: same popover, out of every clipping ancestor. The
          `data-floating-layer` mark tells an enclosing floating panel (the
          action bar's overflow) that a press here is not "outside". */}
      {reasonOpen &&
        popover === 'floating' &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            role="tooltip"
            data-testid="verification-chip-reason-popover"
            data-floating-layer="true"
            style={
              floatingAt
                ? { top: floatingAt.top, left: floatingAt.left, width: floatingAt.width }
                : { visibility: 'hidden' }
            }
            className="fixed z-50 rounded-lg border border-border bg-surface p-3 text-xs leading-relaxed text-foreground shadow-lg"
          >
            {reasonBody}
          </div>,
          document.body
        )}
    </div>
  );
});

export default VerificationStatusChip;
