/**
 * FileMetadataToggle Component (Issue #969)
 *
 * A small gear button in the file-tree toolbar that opens a popover with three
 * checkboxes controlling which metadata columns (size / created / modified) are
 * shown inline in each file row. State is owned by `useFileMetadataDisplay`
 * (localStorage-persisted) and passed in by the parent so the same settings can
 * also drive `TreeNode` rendering without prop drilling through it.
 *
 * [Issue #1365] The popover stays absolutely positioned relative to the gear
 * button (a portal would break the click-outside check, which asks whether the
 * click landed inside `containerRef`). Instead it is measured once opened and
 * nudged with a transform when it would fall outside the viewport.
 */

'use client';

import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Checkbox } from '@/components/ui';
import { isUnhandledEscape } from '@/lib/escape-key';
import type {
  FileMetadataDisplaySettings,
} from '@/hooks/useFileMetadataDisplay';

export interface FileMetadataToggleProps {
  /** Current visibility settings. */
  settings: FileMetadataDisplaySettings;
  /** Toggle a single key. */
  onToggle: (key: keyof FileMetadataDisplaySettings) => void;
}

interface Row {
  key: keyof FileMetadataDisplaySettings;
  labelKey: string;
}

const ROWS: Row[] = [
  { key: 'showSize', labelKey: 'fileTree.metadata.showSize' },
  { key: 'showCreated', labelKey: 'fileTree.metadata.showCreated' },
  { key: 'showModified', labelKey: 'fileTree.metadata.showModified' },
];

/** Space (px) kept between the popover and the viewport edge. [Issue #1365] */
const VIEWPORT_MARGIN = 8;

/**
 * Offset needed to pull a `[start, start + size]` span back inside a viewport
 * of `viewport` px on one axis, keeping `VIEWPORT_MARGIN` clear at both ends.
 * Returns 0 when the span already fits. A span longer than the viewport is
 * never pushed past the leading margin, so its head stays visible.
 * `size <= 0` means the element has not been laid out — nothing to correct.
 */
function clampShift(start: number, size: number, viewport: number): number {
  if (size <= 0 || viewport <= 0) return 0;
  const overflow = start + size + VIEWPORT_MARGIN - viewport;
  if (overflow > 0) return -Math.min(overflow, Math.max(0, start - VIEWPORT_MARGIN));
  if (start < VIEWPORT_MARGIN) return VIEWPORT_MARGIN - start;
  return 0;
}

/**
 * Whether an Escape aimed at `target` belongs to the menu: pressed from the
 * gear / the menu itself, or with nothing focused (the page body — focus was
 * dropped). Anything else is a screen in front of the menu. [Issue #3650]
 */
function isOwnEscapeTarget(target: EventTarget | null, container: HTMLElement | null): boolean {
  if (
    typeof document !== 'undefined' &&
    (target === document || target === document.body || target === document.documentElement)
  ) {
    return true;
  }
  return target instanceof Node && container !== null && container.contains(target);
}

export const FileMetadataToggle = memo(function FileMetadataToggle({
  settings,
  onToggle,
}: FileMetadataToggleProps) {
  const t = useTranslations('worktree');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const shiftRef = useRef({ x: 0, y: 0 });
  const [shift, setShift] = useState({ x: 0, y: 0 });

  // Close the popover when clicking outside, moving focus outside or pressing
  // Escape.
  useEffect(() => {
    if (!open) return undefined;
    // Issue #3650: while open, focus is on the gear, in the menu or nowhere
    // (the page body) — never on another element. A click does not move focus
    // everywhere (Safari leaves it where it was), so take it to the gear, and
    // close as soon as it lands outside (Tab to a file row, a screen opening
    // in front). That keeps every Escape pressed while the menu is up aimed at
    // the menu, unless a screen in front has the focus — and then the menu
    // is already closed.
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) {
      buttonRef.current?.focus();
    }
    const onFocusIn = (e: FocusEvent): void => {
      if (
        e.target instanceof Node &&
        containerRef.current &&
        !containerRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    const onPointerDown = (e: MouseEvent): void => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      // Issue #3611: an Escape a layer above already handled is not ours.
      if (!isUnhandledEscape(e)) return;
      // Issue #3650: nor one pressed in a screen that came up in front of the
      // menu (the mobile FileViewer, a maximized file panel) — that screen's
      // window listener runs after this one and must get the press first.
      if (!isOwnEscapeTarget(e.target, containerRef.current)) return;
      // Issue #3650: ours — claim it so window-level layers below (a tooltip,
      // a maximized file panel) leave it alone. The overlaid activity pane's
      // document listener runs before this one, so it is held off by the
      // menu's `data-floating-layer` mark instead.
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Keep the popover inside the viewport once it is open and measurable.
  // [Issue #1365]
  useLayoutEffect(() => {
    const applyShift = (next: { x: number; y: number }): void => {
      shiftRef.current = next;
      setShift((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
    };
    if (!open) {
      applyShift({ x: 0, y: 0 });
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Subtract the shift already applied so the measurement describes the
    // popover's uncorrected position and re-running stays idempotent.
    applyShift({
      x: clampShift(rect.left - shiftRef.current.x, rect.width, window.innerWidth),
      y: clampShift(rect.top - shiftRef.current.y, rect.height, window.innerHeight),
    });
  }, [open]);

  const handleToggle = useCallback(
    (key: keyof FileMetadataDisplaySettings) => {
      onToggle(key);
    },
    [onToggle]
  );

  return (
    <div
      className="relative"
      ref={containerRef}
      data-testid="file-metadata-toggle"
    >
      <button
        ref={buttonRef}
        type="button"
        data-testid="file-metadata-toggle-button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('fileTree.metadata.settingsLabel')}
        title={t('fileTree.metadata.settingsLabel')}
        className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:bg-muted rounded transition-colors"
      >
        <Settings2 className="w-4 h-4" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          data-testid="file-metadata-toggle-menu"
          // Issue #3650: an open floating layer like the file tree's
          // `ContextMenu` (#3589) — while it is up, an Esc or an outside press
          // closes it and not the overlaid activity pane around it
          // (`OPEN_FLOATING_LAYER_SELECTOR` in hooks/useActivityPaneOverlay).
          data-floating-layer="open"
          className="absolute right-0 top-full z-20 mt-1 min-w-[12rem] rounded border border-border bg-surface shadow-lg p-1"
          style={
            shift.x !== 0 || shift.y !== 0
              ? { transform: `translate(${shift.x}px, ${shift.y}px)` }
              : undefined
          }
        >
          <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
            {t('fileTree.metadata.settingsTitle')}
          </div>
          {ROWS.map((row) => (
            <label
              key={row.key}
              className="flex items-center gap-2 px-2 py-1.5 text-xs text-foreground hover:bg-muted rounded cursor-pointer"
            >
              <Checkbox
                data-testid={`file-metadata-toggle-${row.key}`}
                checked={settings[row.key]}
                onCheckedChange={() => handleToggle(row.key)}
                className="h-3.5 w-3.5"
              />
              <span>{t(row.labelKey)}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
});

export default FileMetadataToggle;
