/**
 * TerminalSplitPane Component (Issue #728, instance-keyed in Issue #869)
 *
 * Single split within `TerminalSplitContainer`. Renders:
 *  - Header: agent-instance selector (with "other-split-uses" excluded) +
 *    output-surface toggle (Issue #2193) + terminal-search button (Issue #47) +
 *    maximize / restore toggle (Issue #2261).
 *  - Body: caller-supplied terminal content (TerminalDisplay).
 *  - Footer: caller-supplied navigation / prompt / message input.
 *
 * Issue #869: the split is identified by an agent `instanceId` (so two
 * instances of the same CLI tool can each occupy a split). The selector lists
 * the worktree's instances by their alias (`getInstanceLabel`); switching the
 * selector swaps the instance backing this split.
 *
 * `role="region"` + `aria-label="Terminal split N"` for a11y. The pane is
 * intentionally presentational: state ownership lives in the parent.
 */

'use client';

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Maximize2, MessageSquare, Minimize2, StickyNote, TerminalSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  getInstanceLabel,
  type AgentInstance,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import { DEFAULT_SURFACE_MODE, type SurfaceMode } from '@/types/ui-state';
import { StatusDot, type StatusDotStatus } from '@/components/ui/StatusDot';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Tooltip } from '@/components/common/Tooltip';
import { useOptionalWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { formatSessionNoteTimestamp } from '@/lib/date-utils';

/**
 * Issue #786 / #869: dedicated MIME so the drag payload never collides with
 * file/text drags. The payload carries the agent `instanceId` (Issue #869,
 * previously a bare CLI tool id).
 */
export const AGENT_INSTANCE_DND_MIME = 'application/x-commandmate-agent-instance';

/**
 * Issue #2193: the two segments of the output-surface control, in render order.
 *
 * Declared at module scope with i18n KEYS rather than resolved labels, for the
 * reason `ACTIVITIES` in `activity-bar-config.ts` gives: `t()` cannot be called
 * outside a component, so the label is resolved at render time. A third entry
 * (`xterm`) is expected here eventually — nothing in this file switches
 * exhaustively on {@link SurfaceMode}, so adding one is a one-line change.
 */
const SURFACE_MODE_SEGMENTS: readonly {
  mode: SurfaceMode;
  labelKey: string;
  icon: typeof TerminalSquare;
}[] = [
  { mode: 'terminal', labelKey: 'surfaceMode.showTerminal', icon: TerminalSquare },
  { mode: 'chat', labelKey: 'surfaceMode.showChat', icon: MessageSquare },
] as const;

// ---------------------------------------------------------------------------
// Session notes (Issue #2427)
// ---------------------------------------------------------------------------
//
// A one-line memo the operator keeps beside a session — "#2427 の DB 層",
// "レビュー待ち" — rewritten every time they hand that session a new
// instruction. It exists because a four-way split shows four headers that all
// read `claude`, and the pane three scrollbacks deep answers nothing.
//
// It is NOT an alias. Since Issue #2376 an alias is a RESOLUTION key
// (`--instance レビュー担当` finds the roster row through it), so an alias
// decides where the next `send` lands. A note is read by human eyes only:
// nothing in `/resolve-target` or `resolveInstanceCliTool` can see this value,
// which is what makes it safe to rewrite hourly.
//
// ## Why the note is read from the app-wide list cache rather than a prop
//
// This pane is presentational and everything else it renders arrives as a prop.
// The note cannot: `TerminalSplitContainer` composes this component's props, and
// the phone's equivalent (`MobileTerminalTab`) is handed ONE frozen object built
// by `MobileContent`. The list cache is the seam both surfaces already share —
// `MobileTerminalTab`'s `useCachedAgentModelLabel` reads the model out of the
// same place — and it is a poll every client already pays for, which is also how
// a note edited in another browser reaches this one (the Issue's last acceptance
// condition). No provider above (every pre-#2427 test of this pane) yields null,
// and null renders nothing.

/**
 * Longest note the editor accepts, in UTF-16 units (`maxLength`).
 *
 * A convenience mirror of `MAX_SESSION_NOTE_LENGTH` in
 * `@/lib/db/agent-instances-db`, which is the enforcement — the route is
 * reachable without this UI, and the server counts CODE POINTS while
 * `maxLength` counts UTF-16 units. The two agree on every note that is not
 * mostly emoji, and where they disagree this one is the stricter, so the input
 * can never compose a note the server would refuse. Pinned to the server's
 * constant by `TerminalSplitPane-session-note-2427.test.tsx`.
 */
export const SESSION_NOTE_MAX_LENGTH = 100;

/**
 * Window event that asks the mounted note editor to open (Issue #2427).
 *
 * The phone's edit entry point is a row in `MobileTerminalActionsSheet`, which
 * is rendered by `WorktreeDetailRefactored` beside the tab rather than inside
 * it — so the sheet knows neither the worktree nor the active instance. This is
 * the same escape hatch the terminal search already uses from this very header
 * (`terminal-search-open`): the sheet raises the intent, and the component that
 * holds the target listens. `MobileTerminalTab` is the listener.
 */
export const SESSION_NOTE_OPEN_EVENT = 'session-note-open';

/** One session's note, as `GET /api/worktrees` carries it (Issue #2427). */
export interface SessionNoteValue {
  /** The memo itself; never empty — a cleared note is absence, not `''`. */
  text: string;
  /** Epoch ms it was last written, rendered beside it. */
  updatedAt: number;
}

/**
 * The per-worktree map the list route attaches (Issue #2427).
 *
 * Read structurally rather than off `Worktree`: the field is transported by one
 * route and read by two panes, and every other surface that holds a `Worktree`
 * (the sidebar, Review, the command palette) has no use for it. The values are
 * typed as `unknown` because they crossed a network boundary — a stale client
 * against a newer server is the ordinary case for a page nobody reloaded.
 */
interface WorktreeWithSessionNotes {
  id: string;
  sessionNotes?: Record<string, { text?: unknown; updatedAt?: unknown } | undefined>;
}

/**
 * Pull one instance's note out of the cached list, or null when there is none.
 *
 * An empty `text` is treated as absent, so a server that ever stored `''`
 * renders the same nothing a missing row does.
 */
function readSessionNote(
  worktrees: readonly { id: string }[] | undefined,
  worktreeId: string,
  instanceId: string,
): SessionNoteValue | null {
  const worktree = worktrees?.find((entry) => entry.id === worktreeId) as
    | WorktreeWithSessionNotes
    | undefined;
  const raw = worktree?.sessionNotes?.[instanceId];
  if (!raw || typeof raw.text !== 'string' || raw.text.length === 0) return null;
  return {
    text: raw.text,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

/**
 * Fold what was typed into the single line the server will store.
 *
 * A weaker copy of the server's `normalizeSessionNoteText` on purpose: this one
 * only collapses whitespace, because an `<input type="text">` cannot contain a
 * newline in the first place and the control characters the server strips cannot
 * be typed into one. Its job is to make the OPTIMISTIC value equal to the value
 * the poll will bring back, so the override below settles instead of flickering.
 */
export function normalizeSessionNoteInput(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** What {@link useSessionNote} hands a surface. */
export interface SessionNoteHandle {
  /** The note to render, or null when this session has none. */
  note: SessionNoteValue | null;
  /** Write (or, with an empty string, clear) the note. Never rejects. */
  save: (text: string) => void;
}

/**
 * The note for one session, and the way to change it (Issue #2427).
 *
 * Reads the app-wide list cache and writes through the narrow endpoint, then
 * asks the cache to re-read so every other surface of this browser agrees at
 * once rather than at the next poll (20-60s with a live socket).
 *
 * ## The override
 *
 * A write is shown immediately and held until the list confirms it. Without that
 * the note would visibly revert for as long as the poll takes — the cache is the
 * only reader, and it has not heard yet.
 *
 * It is released on EITHER of two signals, and the second one is the one that is
 * easy to miss: the cached value agreeing with what was written, or the cached
 * value having moved off what it held when the write started. Without the
 * second, a note somebody else changed in the same second as this write would
 * never match, and this browser would keep showing its own memo — a private
 * truth nothing could dislodge — until the pane was switched or written again.
 */
export function useSessionNote(worktreeId: string, instanceId: string): SessionNoteHandle {
  const cache = useOptionalWorktreesCacheContext();
  const worktrees = cache?.worktrees;
  const refresh = cache?.refresh;

  const stored = useMemo(
    () => readSessionNote(worktrees, worktreeId, instanceId),
    [worktrees, worktreeId, instanceId],
  );

  // `value: null` means "this session has no note"; the outer null means "no
  // write of ours is in flight", which is why this is not just `SessionNoteValue
  // | null`. `base` is what the list held when the write started — see the
  // release rule in the doc comment.
  const [override, setOverride] = useState<{
    value: SessionNoteValue | null;
    base: SessionNoteValue | null;
  } | null>(null);

  // A different session is a different note: never show one instance's memo
  // while the cache still holds another's.
  useEffect(() => {
    setOverride(null);
  }, [worktreeId, instanceId]);

  useEffect(() => {
    if (override === null) return;
    // Our write landed. The server's `updatedAt` is not the optimistic one, so
    // the text is what is compared.
    const landed =
      override.value === null
        ? stored === null
        : stored !== null && stored.text === override.value.text;
    // Or the list moved off what it held when the write started, which means
    // somebody else's write is now the truth even though it is not ours.
    const moved =
      stored?.text !== override.base?.text || stored?.updatedAt !== override.base?.updatedAt;
    if (landed || moved) setOverride(null);
  }, [override, stored]);

  const save = useCallback(
    (raw: string) => {
      const text = normalizeSessionNoteInput(raw);
      if (Array.from(text).length > SESSION_NOTE_MAX_LENGTH) return;
      setOverride({
        value: text.length > 0 ? { text, updatedAt: Date.now() } : null,
        base: stored,
      });
      void (async () => {
        try {
          const response = await fetch(
            `/api/worktrees/${encodeURIComponent(worktreeId)}/instances/notes`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ instanceId, text }),
            },
          );
          if (!response.ok) {
            // Drop the optimistic value rather than reporting: the header has no
            // room for an error, and falling back to the stored note is the
            // honest thing to show.
            setOverride(null);
            return;
          }
          await refresh?.();
        } catch {
          setOverride(null);
        }
      })();
    },
    [instanceId, refresh, stored, worktreeId],
  );

  return { note: override ? override.value : stored, save };
}

/**
 * The note's one-line editor, shared by the split header and the phone (#2427).
 *
 * One component so the IME guard cannot exist on one surface and not the other.
 * That guard is the point: on a Japanese keyboard the Enter that CONFIRMS a
 * conversion candidate and the Enter that submits are the same key event, and
 * without `isComposing` the first one saves the unconverted kana. Same shape as
 * `TodoPane`'s add-input.
 *
 * Escape cancels. Blur does not commit — the editor is opened from a Radix menu
 * whose close restores focus to its trigger, so a blur-commit would fire on the
 * way in.
 */
export function SessionNoteInput({
  initialText,
  onCommit,
  onCancel,
  ariaLabel,
  placeholder,
  testId,
}: {
  initialText: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
  ariaLabel: string;
  placeholder: string;
  testId: string;
}) {
  const [value, setValue] = useState(initialText);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        // Guard against IME composition (Enter confirms the candidate, not the
        // note). Without this an operator converting 「レビュー」 saves 「れびゅー」.
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        onCommit(value);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // The pane's own Escape handling (and the terminal below it) has no
        // business seeing the keystroke that closed this editor.
        e.stopPropagation();
        onCancel();
      }
    },
    [onCancel, onCommit, value],
  );

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      maxLength={SESSION_NOTE_MAX_LENGTH}
      placeholder={placeholder}
      aria-label={ariaLabel}
      data-testid={testId}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      className="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-surface-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

export interface TerminalSplitPaneProps {
  worktreeId: string;
  splitIndex: number;
  /** CLI tool backing this split (derived from the instance; used for labels). */
  cliToolId: CLIToolType;
  /** Issue #869: the agent instance id backing this split (tab/split identity). */
  instanceId: string;
  /** Issue #869: the resolved instance for alias display (may be undefined if stale). */
  instance?: AgentInstance;
  /**
   * Issue #869: instances selectable for this split. Already excludes instances
   * used by other splits, and always includes this split's own instance.
   */
  availableInstances: AgentInstance[];
  /** Called when the instance selector picks a different instance. */
  onInstanceChange: (instanceId: string) => void;
  /**
   * Issue #1079: this split's derived agent status, shown as a `StatusDot` in
   * the instance-selector trigger (the session title bar). `BranchStatus` is a
   * subset of `StatusDotStatus`, so callers can pass their derived status
   * directly. Defaults to `idle`.
   */
  status?: StatusDotStatus;
  /**
   * Issue #1783: the model this split's agent last reported running, from the
   * structured hook events (`sessionStatusByInstance[instanceId].model`).
   *
   * Rendered as muted small text after the alias — the session title bar is the
   * one surface that is already per-instance, so it is the natural home for a
   * per-instance fact. `null`/`undefined` renders **nothing**: most sessions
   * never report a model (gemini, copilot, any tool without hooks configured),
   * and an "unknown" badge on all of them would be noise on the busiest row of
   * the screen.
   */
  agentModel?: string | null;
  /**
   * Issue #2042: what this split's session has cost and how full its context is,
   * pre-composed — `$0.03 · 8.5K (1%)`, the same three values in the same order
   * opencode's own footer prints.
   *
   * A formatted string rather than the numbers, for the reason `agentModel` is
   * one: this component renders a header row and the wording lives with the
   * other agent labels in `WorktreeDetailSubComponents`, so the pane header and
   * the desktop header's pill tooltip cannot drift apart. `null`/`undefined`
   * renders **nothing** — which is every claude, codex, gemini and copilot pane,
   * none of which publish a cost.
   */
  agentUsage?: string | null;
  /**
   * Issue #2042: the long form for `title` — session title, persona, cost at
   * four decimals, cumulative spend and context occupancy, one per line.
   *
   * Separate from {@link agentUsage} because the chip and its tooltip answer
   * different questions: the chip is what the agent's own footer shows, and this
   * is what distinguishes the session's *cumulative* spend from the context
   * *currently* in use — two numbers that look interchangeable and are not.
   */
  agentUsageDetail?: string | null;
  /** Called when the textarea (or any input) inside this pane gains focus. */
  onFocus: () => void;
  /** Whether tmux attach is in progress for this split. */
  attaching?: boolean;
  /**
   * Rendered directly after the instance selector (Dropdown) and before the
   * search button (Issue #1171). Usually the per-split session End (×) button;
   * empty (`null`) when the split's session is not running.
   */
  headerExtras?: React.ReactNode;
  /**
   * Issue #2193: which surface this split's body is showing. Presentational
   * only — the pane renders whatever `terminal` contains; this drives the
   * header control's pressed state. Defaults to `'terminal'`.
   */
  surfaceMode?: SurfaceMode;
  /**
   * Issue #2193: called when the header's segmented control picks a surface.
   * OMITTING IT HIDES THE CONTROL, which is what keeps every pre-#2193 caller
   * (and its tests) rendering the header it rendered before.
   */
  onSurfaceModeChange?: (mode: SurfaceMode) => void;
  /** Terminal output area (TerminalDisplay), or the chat surface (Issue #2193). */
  terminal: React.ReactNode;
  /** Navigation buttons + PromptPanel + MessageInput. */
  footer: React.ReactNode;
  /**
   * Issue #2261: whether this split is currently filling the whole terminal row.
   * Presentational — the container owns the state and the layout; this only
   * drives which icon and which label the toggle shows.
   */
  isMaximized?: boolean;
  /**
   * Issue #2261: maximize this split / restore the split layout.
   * OMITTING IT HIDES THE TOGGLE, the same contract `onSurfaceModeChange` uses,
   * which is what keeps every pre-#2261 caller rendering the header it rendered
   * before.
   */
  onToggleMaximize?: () => void;
  /** Optional inline width (flex-grow ratio). When omitted, parent controls layout. */
  style?: React.CSSProperties;
  /**
   * Issue #786 / #869: called when an agent instance is dropped on this split.
   * The container (drop validation owner) decides no-op / reject / apply.
   * Optional — when omitted, drag-drop is inert (backward compat, D-4).
   */
  onDropInstance?: (instanceId: string) => void;
  /**
   * Issue #786 / #869 (D-2): the instanceId currently being dragged, published
   * by the drag source via shared state. Used ONLY to drive the dragOver
   * allowed/forbidden ring, since `dataTransfer.getData()` is unreadable during
   * dragover in real browsers (readable only on drop). `undefined`/`null` when
   * nothing is being dragged.
   */
  draggedInstanceId?: string | null;
}

export const TerminalSplitPane = memo(function TerminalSplitPane({
  worktreeId,
  splitIndex,
  cliToolId,
  instanceId,
  instance,
  availableInstances,
  onInstanceChange,
  status = 'idle',
  agentModel,
  agentUsage,
  agentUsageDetail,
  onFocus,
  attaching = false,
  headerExtras,
  surfaceMode = DEFAULT_SURFACE_MODE,
  onSurfaceModeChange,
  isMaximized = false,
  onToggleMaximize,
  terminal,
  footer,
  style,
  onDropInstance,
  draggedInstanceId,
}: TerminalSplitPaneProps) {
  const t = useTranslations('worktree');
  // Issue #786: drag-over hover state lives LOCAL to this pane (D-3) so a hover
  // change never re-creates the parent's renderSplitPane / terminalSplitRegion
  // memo (which would re-render every split). null = no drag over this pane.
  const [dragOverState, setDragOverState] = useState<'allowed' | 'forbidden' | null>(null);

  // Issue #2427: this split's session note, read from the list cache and written
  // through the narrow endpoint. See the section above the props for why it does
  // not arrive as a prop like everything else here.
  const { note: sessionNote, save: saveSessionNote } = useSessionNote(worktreeId, instanceId);
  const [noteEditing, setNoteEditing] = useState(false);
  // A different session is a different memo; never leave the editor open across
  // an instance swap holding the previous session's text.
  useEffect(() => {
    setNoteEditing(false);
  }, [worktreeId, instanceId]);
  const openNoteEditor = useCallback(() => setNoteEditing(true), []);
  const closeNoteEditor = useCallback(() => setNoteEditing(false), []);
  const commitNote = useCallback(
    (text: string) => {
      saveSessionNote(text);
      setNoteEditing(false);
    },
    [saveSessionNote],
  );
  // Opened from the session-title menu on the NEXT macrotask: Radix restores
  // focus to the menu trigger as it closes, so an editor mounted synchronously
  // in `onSelect` would be focused and then immediately un-focused.
  const openNoteEditorFromMenu = useCallback(() => {
    setTimeout(() => setNoteEditing(true), 0);
  }, []);

  // Whether drag-drop is active for this pane (the parent wired a handler).
  const dropEnabled = onDropInstance != null;

  // Classify the in-flight drag against THIS split using the published
  // instanceId (D-2). Forbidden when the dragged instance is used by another
  // split (i.e. not in availableInstances, which is the complement of
  // other-split instances and always includes this split's own current one).
  // Dropping this split's own current instance is a harmless no-op handled by
  // the container, so it is treated as 'allowed' for the ring.
  const classifyDrag = useCallback((): 'allowed' | 'forbidden' => {
    if (draggedInstanceId == null) return 'allowed';
    return availableInstances.some(inst => inst.id === draggedInstanceId)
      ? 'allowed'
      : 'forbidden';
  }, [draggedInstanceId, availableInstances]);

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dropEnabled) return;
      // preventDefault marks this element as a valid drop target.
      e.preventDefault();
      const classification = classifyDrag();
      e.dataTransfer.dropEffect = classification === 'forbidden' ? 'none' : 'move';
      setDragOverState(prev => (prev === classification ? prev : classification));
    },
    [dropEnabled, classifyDrag],
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dropEnabled) return;
      e.preventDefault();
      const classification = classifyDrag();
      setDragOverState(prev => (prev === classification ? prev : classification));
    },
    [dropEnabled, classifyDrag],
  );

  const handleDragLeave = useCallback(() => {
    if (!dropEnabled) return;
    setDragOverState(null);
  }, [dropEnabled]);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dropEnabled) return;
      e.preventDefault();
      setDragOverState(null);
      // D-2: getData is readable here (on drop) in real browsers.
      const droppedId = e.dataTransfer.getData(AGENT_INSTANCE_DND_MIME);
      if (!droppedId) return;
      onDropInstance?.(droppedId);
    },
    [dropEnabled, onDropInstance],
  );

  const dragRingClass =
    dragOverState === 'allowed'
      ? ' ring-2 ring-accent-400'
      : dragOverState === 'forbidden'
        ? ' ring-2 ring-red-300 cursor-not-allowed'
        : '';

  // Issue #1079: the subtle focus ring and the drag-over ring share the same
  // `ring` box-shadow. `focus-within:` is a pseudo-class (higher specificity),
  // so it would override the more prominent 2px drag ring when a focused pane is
  // also the drop target. Suppress the focus ring while a drag is over this pane
  // so the drop affordance always wins.
  const focusRingClass =
    dragOverState === null ? ' focus-within:ring-1 focus-within:ring-accent-500/30' : '';

  const handleSearchClick = useCallback(() => {
    // Issue #47: dispatch terminal-wide search-open event; TerminalDisplay listens.
    window.dispatchEvent(new CustomEvent('terminal-search-open'));
  }, []);

  // Bubble-up focus from anywhere inside (textarea, terminal click).
  // We use onFocusCapture so we don't depend on individual children calling onFocus.
  const handleFocusCapture = useCallback(() => {
    onFocus();
  }, [onFocus]);

  const splitLabel = `Terminal split ${splitIndex + 1}`;
  // Alias-first label for the selector trigger + attach skeleton (falls back to
  // the CLI tool name when the instance is stale/undefined).
  const attachLabel = getInstanceLabel(instance ?? { cliTool: cliToolId });
  const selectInstanceLabel = t('terminal.selectInstance', { split: splitLabel });
  // [Issue #2307] i18n-ized (was a hardcoded English string) so it can drive
  // both the Tooltip and the aria-label without drifting apart.
  const searchLabel = t('terminal.searchOutput', { split: splitLabel });
  // Issue #2427: the note's own strings. `noteStamp` is the compact absolute
  // time (`14:32` today, `9/7 14:32` before today) and it is composed into the
  // tooltip rather than printed twice — the header row shows the memo and the
  // stamp side by side, and the tooltip is where the untruncated pair lives.
  const noteEditLabel = t('sessionNote.editLabel', { split: splitLabel });
  const noteStamp = sessionNote ? formatSessionNoteTimestamp(new Date(sessionNote.updatedAt)) : '';
  const noteLabel = sessionNote
    ? t('sessionNote.label', { note: sessionNote.text, time: noteStamp })
    : '';

  return (
    <div
      role="region"
      aria-label={splitLabel}
      data-testid={`terminal-split-pane-${splitIndex}`}
      data-split-index={splitIndex}
      style={style}
      // Issue #1079: the pane is a card (rounded, clipped, hairline border).
      // Focus is expressed subtly via `focus-within` (a soft accent ring) instead
      // of the old flashy full-perimeter accent border.
      className={`flex flex-col min-w-0 h-full rounded-lg overflow-hidden border border-border bg-surface${focusRingClass}${dragRingClass}`}
      onFocusCapture={handleFocusCapture}
      onMouseDown={onFocus}
      // Issue #786: drop target handlers. Separate event system from
      // onMouseDown(onFocus)/onFocusCapture, so they do not compete (S3-007).
      // No-ops when dropEnabled is false (drop props omitted).
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header: session title bar — instance selector (status + alias) + search.
          `relative` anchors the Issue #2427 note editor, which is absolutely
          positioned below this row so that opening it cannot change the header's
          height (and therefore cannot resize the terminal underneath). */}
      <div className="relative px-2 py-1 flex items-center gap-2 bg-surface-2 border-b border-border flex-shrink-0">
        {/* Issue #1079: native <select> → Radix DropdownMenu. The trigger reads as
            a session title (StatusDot + alias + chevron); the radio group keeps
            the same single-select value/onChange semantics as the old <select>. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid={`cli-selector-${splitIndex}`}
            aria-label={selectInstanceLabel}
            className="flex items-center gap-1.5 min-w-0 max-w-[12rem] rounded px-1.5 py-0.5 text-xs border border-border bg-surface text-surface-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:ring-2 data-[state=open]:ring-ring transition-colors"
          >
            <StatusDot
              status={status}
              size="sm"
              aria-hidden
              data-testid={`split-status-indicator-${splitIndex}`}
            />
            <span className="truncate">{attachLabel}</span>
            <ChevronDown size={14} aria-hidden="true" className="flex-shrink-0 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[10rem]">
            <DropdownMenuRadioGroup value={instanceId} onValueChange={onInstanceChange}>
              {availableInstances.map(inst => (
                <DropdownMenuRadioItem key={inst.id} value={inst.id}>
                  {getInstanceLabel(inst)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {/* Issue #2427: the note's entry point on PC, inside the menu that
                already exists rather than as a new header control. The Issue
                requires that an EMPTY note put nothing extra in the header, and
                a header row that already carries four controls has no room for
                a fifth that is blank most of the time. When the note is set it
                is also clickable in the row itself. */}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid={`split-session-note-menu-item-${splitIndex}`}
              onSelect={openNoteEditorFromMenu}
            >
              <StickyNote size={14} aria-hidden="true" className="opacity-70" />
              {t('sessionNote.menuItem')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Issue #2193: the output-surface control, directly beside the session
            title so it reads as "what this session is showing" rather than a
            global view switch -- each split owns its own mode. Rendered only
            when the parent wired `onSurfaceModeChange`.

            Always visible (never hover-revealed): a hover-only affordance is
            invisible on a touch screen, and this is the only way back from the
            chat surface. Both segments stay mounted so the control's width does
            not change when the mode does. */}
        {onSurfaceModeChange ? (
          <div
            role="group"
            aria-label={t('surfaceMode.groupLabel', { split: splitLabel })}
            data-testid={`surface-mode-toggle-${splitIndex}`}
            className="flex flex-shrink-0 items-center gap-0.5 rounded border border-border bg-surface p-0.5"
          >
            {SURFACE_MODE_SEGMENTS.map(({ mode, labelKey, icon: Icon }) => {
              const active = surfaceMode === mode;
              const label = t(labelKey);
              return (
                <Tooltip key={mode} content={label} placement="bottom">
                  <button
                    type="button"
                    onClick={() => onSurfaceModeChange(mode)}
                    aria-pressed={active}
                    aria-label={label}
                    data-testid={`surface-mode-${mode}-${splitIndex}`}
                    className={`flex items-center justify-center rounded px-1.5 py-0.5 touch-manipulation transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      active
                        ? 'bg-accent-500/15 text-accent-600 dark:text-accent-400'
                        : 'text-muted-foreground hover:bg-muted hover:text-surface-foreground'
                    }`}
                  >
                    <Icon size={14} aria-hidden="true" />
                  </button>
                </Tooltip>
              );
            })}
          </div>
        ) : null}

        {/* Issue #1783: the model the agent itself reported, as muted small
            text after the alias. A sibling of the selector rather than a child
            of its trigger: the trigger is already `max-w-[12rem]` with a
            truncated alias and a chevron, and folding a second string into it
            would eat the alias to make room for the model. Rendered only when a
            model is actually known — see `agentModel`. `truncate` + `title` keep
            a long id from pushing the search button off the row. */}
        {/* Issue #2427: the model is also the label that gives way. When a note
            is present its cap drops from 10rem to 5rem and it shrinks four times
            as fast as the note, so a narrow split spends its width on what the
            operator wrote — which changes with every instruction — rather than
            on a model id that is fixed for the session and readable in the
            tooltip either way. */}
        {agentModel && (
          <span
            data-testid={`split-agent-model-${splitIndex}`}
            title={t('agentModel.modelLabel', { model: agentModel })}
            className={`min-w-0 truncate text-[11px] leading-none text-muted-foreground ${
              sessionNote ? 'max-w-[5rem] shrink-[4]' : 'max-w-[10rem]'
            }`}
          >
            {agentModel}
          </span>
        )}

        {/* Issue #2042: cost / context, as a sibling chip of the model rather
            than an extension of it. Two strings, because they answer different
            questions and go stale at different rates — the model is fixed for
            the session while these move every turn — and because a reader
            comparing this row against the agent's own footer is comparing the
            second half only. `tabular-nums` so a changing count does not jitter
            the row; `truncate` + `title` keep a long detail off the layout. */}
        {agentUsage && (
          <span
            data-testid={`split-agent-usage-${splitIndex}`}
            title={agentUsageDetail ?? t('agentSession.chipLabel', { usage: agentUsage })}
            className="min-w-0 max-w-[10rem] truncate text-[11px] leading-none tabular-nums text-muted-foreground"
          >
            {agentUsage}
          </span>
        )}

        {/* Issue #2427: the memo, as a sibling of the model and usage chips and
            under the same rule — rendered ONLY when there is one, so an empty
            note leaves the header exactly as it was before this Issue. It is a
            button because clicking it is how the note is edited; `truncate` +
            `title` keep a 100-character memo from pushing the search button off
            the row, and `shrink` (1, against the model's 4) is what makes the
            model give way first. */}
        {sessionNote && (
          <button
            type="button"
            onClick={openNoteEditor}
            aria-label={noteEditLabel}
            title={noteLabel}
            data-testid={`split-session-note-${splitIndex}`}
            className="flex min-w-0 max-w-[16rem] shrink items-center gap-1 rounded px-1 py-0.5 text-[11px] leading-none text-muted-foreground hover:bg-muted-foreground/10 hover:text-surface-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <StickyNote size={11} aria-hidden="true" className="shrink-0 opacity-70" />
            <span className="min-w-0 truncate">{sessionNote.text}</span>
            <span
              data-testid={`split-session-note-time-${splitIndex}`}
              className="shrink-0 tabular-nums opacity-70"
            >
              {noteStamp}
            </span>
          </button>
        )}

        {/* Issue #1171: session-scoped extras (the End × button) sit directly
            after the instance selector, before the search button, so the
            terminate action reads as tied to the selected session. The search
            button keeps `ml-auto` and stays pinned to the right edge. */}
        {headerExtras}

        <Tooltip content={searchLabel} placement="bottom" className="ml-auto">
          <button
            type="button"
            onClick={handleSearchClick}
            aria-label={searchLabel}
            data-testid={`terminal-search-button-${splitIndex}`}
            className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-surface-foreground hover:bg-muted-foreground/10 rounded transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-3 w-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
          </button>
        </Tooltip>

        {/* Issue #2261: maximize / restore, at the far right of the title bar
            where a window control is looked for. `flex-shrink-0` (and the
            `truncate`d alias to its left) is what keeps the row from wrapping in
            a narrow split — this is the row's fourth control. Rendered only when
            the parent wired `onToggleMaximize`. */}
        {onToggleMaximize ? (
          <Tooltip
            content={`${
              isMaximized
                ? t('terminal.restoreSplits')
                : t('terminal.maximizeSplit', { split: splitLabel })
            } — ${t('terminal.maximizeShortcutHint')}`}
            placement="bottom"
            className="flex-shrink-0"
          >
            <button
              type="button"
              onClick={onToggleMaximize}
              aria-pressed={isMaximized}
              aria-label={
                isMaximized
                  ? t('terminal.restoreSplits')
                  : t('terminal.maximizeSplit', { split: splitLabel })
              }
              data-testid={`toggle-maximize-${splitIndex}`}
              className="flex flex-shrink-0 items-center justify-center px-1.5 py-0.5 text-muted-foreground hover:text-surface-foreground hover:bg-muted-foreground/10 rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {isMaximized ? (
                <Minimize2 size={14} aria-hidden="true" />
              ) : (
                <Maximize2 size={14} aria-hidden="true" />
              )}
            </button>
          </Tooltip>
        ) : null}

        {/* Issue #2427: the note editor, absolutely positioned UNDER the header
            so opening it never changes the header's height — this row sits above
            a terminal whose visible height is a measured budget (#2106), and a
            popover that pushed it down would resize the pane every time somebody
            wrote a memo. `z-30` clears the terminal's own painted rows. */}
        {noteEditing ? (
          <div
            data-testid={`split-session-note-editor-${splitIndex}`}
            className="absolute inset-x-2 top-full z-30 mt-1 rounded-md border border-border bg-surface p-2 shadow-lg"
          >
            <SessionNoteInput
              initialText={sessionNote?.text ?? ''}
              onCommit={commitNote}
              onCancel={closeNoteEditor}
              ariaLabel={noteEditLabel}
              placeholder={t('sessionNote.placeholder')}
              testId={`split-session-note-input-${splitIndex}`}
            />
            <p className="mt-1 text-[10px] leading-tight text-muted-foreground">
              {t('sessionNote.hint')}
            </p>
          </div>
        ) : null}
      </div>

      {/* Body: terminal display (or attach skeleton) */}
      <div className="flex-1 min-h-0 relative">
        {attaching ? (
          <div
            data-testid={`terminal-attach-skeleton-${splitIndex}`}
            className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground bg-surface-2/80"
            role="status"
            aria-live="polite"
          >
            Attaching {attachLabel} session...
          </div>
        ) : null}
        {terminal}
      </div>

      {/* Footer: navigation + prompt + message input */}
      <div className="flex-shrink-0 border-t border-border p-2 bg-surface-2">
        {footer}
      </div>
    </div>
  );
});

export default TerminalSplitPane;
