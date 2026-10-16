/**
 * TerminalSplitPane Component (Issue #728, instance-keyed in Issue #869)
 *
 * Single split within `TerminalSplitContainer`. Renders:
 *  - Header: agent-instance selector (with "other-split-uses" excluded) +
 *    output-surface toggle (Issue #2193, labelled "Terminal" / "Chat" since
 *    Issue #3514) + terminal-search button (Issue #47) + maximize / restore
 *    toggle (Issue #2261) + a "…" menu gathering maximize / search / end
 *    session (Issue #3514). The selected split carries an accent frame.
 *    Issue #3592: a fixed 30px row — and with ONE split there is none: the
 *    same controls are portalled into the action bar's slots
 *    (`SplitPaneHeaderControls`), where an empty session note also gets a
 *    small edit entry and the selector carries the model / cost as a tooltip
 *    (the split's maximize icon stays out: the bar has its own).
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

import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  StickyNote,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import {
  getInstanceLabel,
  type AgentInstance,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import { DEFAULT_SURFACE_MODE, type SurfaceMode } from '@/types/ui-state';
import { StatusDot, type StatusDotStatus } from '@/components/ui/StatusDot';
import {
  UNCLASSIFIED_STATUS_DOT_CLASS,
  UNCLASSIFIED_STATUS_LABEL_KEY,
  resolveUnclassifiedDot,
} from '@/components/sidebar/BranchStatusIndicator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { useOptionalWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import { formatSessionNoteTimestamp } from '@/lib/date-utils';
import { useSplitHeaderSlots } from './SplitPaneHeaderControls';
import { FIT_MIN_WIDTH_ATTR } from '@/hooks/useDesktopHeaderFit';
import { SplitActionControls } from './terminal-split-pane/SplitActionControls';
import { resolveSelectorTitle } from './terminal-split-pane/resolve-selector-title';
import { SplitSessionChips } from './terminal-split-pane/SplitSessionChips';
import { useSplitDragDrop } from './terminal-split-pane/useTerminalSplitDragDrop';
import { useBarNotePosition } from './terminal-split-pane/use-bar-note-position';

/**
 * Issue #786 / #869: dedicated MIME so the drag payload never collides with
 * file/text drags. The payload carries the agent `instanceId` (Issue #869,
 * previously a bare CLI tool id).
 */
export const AGENT_INSTANCE_DND_MIME = 'application/x-commandmate-agent-instance';

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

/** Issue #3592: the note editor's width when it floats under the action bar (w-72). */
const BAR_NOTE_EDITOR_WIDTH = 288;

/**
 * Issue #3615: the narrowest the agent's name may be clipped to in the action
 * bar before the controls fold behind "…" — about 7 characters of the
 * selector's 12px text ("Claude" measures 39px). Narrower, it read as "C".
 * Issue #3631: also the floor of the name in each split's 30px title bar.
 */
const BAR_SESSION_LABEL_MIN_WIDTH = 48;
/**
 * Issue #3651: the lone split's row of controls in the action bar. One line
 * on the bar; inside the "…" panel (the container marks the slot, a
 * `group/bar-session`, with `data-folded="true"`) it wraps, so in a panel
 * capped from the body (~272px at 768px with a 480px sidebar) Terminal / Chat,
 * the note and its time, End and the name do not overrun one another.
 */
const BAR_SESSION_ROW_CLASS =
  'relative flex min-w-0 items-center gap-1.5 group-data-[folded=true]/bar-session:flex-wrap';
/** Issue #3592: how close to the viewport's edges that editor may come. */
const BAR_NOTE_EDITOR_MARGIN = 8;

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
  value: controlledValue,
  onValueChange,
}: {
  initialText: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
  ariaLabel: string;
  placeholder: string;
  testId: string;
  /**
   * Issue #3592: the text being typed, held by the caller. The PC split's
   * editor moves between the split's title bar and the action bar when the
   * split count changes, which re-creates this input; a value kept here would
   * be lost with it. Omitted (the phone), the input holds its own.
   */
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  const [ownValue, setOwnValue] = useState(initialText);
  const value = controlledValue ?? ownValue;
  const setValue = onValueChange ?? setOwnValue;
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // Issue #3592: a half-typed draft that moved here is continued, not
    // selected — the next keystroke would replace it.
    if (inputRef.current?.value === initialText) inputRef.current?.select();
    // Mount only: what was there when the editor appeared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
   * Issue #2775: `status` is a `ready` no rule actually read (the server
   * flagged the frame unclassified). The dot is drawn as the "cannot tell" ring
   * and titled "Unknown" instead. Ignored for every status but `ready`, so a
   * working split can never lose its glow to it. Defaults to false.
   */
  statusUnclassified?: boolean;
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
   * Issue #2598: the body element (the `flex-1` box `terminal` is drawn in),
   * for the caller that bounds the composer's height by what the body can give
   * up. A callback ref works, so the caller can hold the element in state.
   */
  bodyRef?: React.Ref<HTMLDivElement>;
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
  /**
   * Issue #3612: a lone split cannot be maximized. Disables (keeps in place,
   * `aria-disabled`) the maximize entries; an already-maximized split can
   * still be restored.
   */
  maximizeDisabled?: boolean;
  /**
   * Issue #3514: draw the accent frame that marks the selected split. The
   * container sets it only for the focused split, and only while more than one
   * split is open. Defaults to false (no frame), the pre-#3514 look.
   */
  showFocusFrame?: boolean;
  /**
   * Issue #3514: end this split's session, offered as an item of the header's
   * "…" menu. Omitted (no running session, or no handler) leaves the item out.
   */
  onEndSession?: () => void;
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
  statusUnclassified = false,
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
  maximizeDisabled = false,
  showFocusFrame = false,
  onEndSession,
  terminal,
  footer,
  bodyRef,
  style,
  onDropInstance,
  draggedInstanceId,
}: TerminalSplitPaneProps) {
  const t = useTranslations('worktree');
  // Issue #2775: the "cannot tell" word for the title-bar dot. `common` because
  // that is where every StatusDot label lives (`common.status.*`).
  const tCommon = useTranslations('common');
  const showUnclassifiedDot = resolveUnclassifiedDot(status, statusUnclassified);
  // Issue #3592: with one split, the action bar's slots to draw the header
  // controls into instead of a title bar of our own (null: the title bar).
  const headerSlots = useSplitHeaderSlots();
  const inActionBar = headerSlots !== null;

  // Issue #2427: this split's session note, read from the list cache and written
  // through the narrow endpoint. See the section above the props for why it does
  // not arrive as a prop like everything else here.
  const { note: sessionNote, save: saveSessionNote } = useSessionNote(worktreeId, instanceId);
  const [noteEditing, setNoteEditing] = useState(false);
  // Issue #3592: the text being typed in the editor. Held here, in the pane,
  // because the editor itself is re-created whenever it moves between the
  // title bar and the action bar (1 <-> 2+ splits, the bar's "…" panel) —
  // the pane is the one thing that stays put.
  const [noteDraft, setNoteDraft] = useState('');
  const sessionNoteText = sessionNote?.text ?? '';
  // A different session is a different memo; never leave the editor open across
  // an instance swap holding the previous session's text.
  useEffect(() => {
    setNoteEditing(false);
  }, [worktreeId, instanceId]);
  // Seeded with the saved note only when a CLOSED editor opens: pressing the
  // edit entry (or the menu item) again while typing keeps what is typed, as
  // the phone's editor does (it stays mounted with its own value).
  const noteEditingRef = useRef(noteEditing);
  noteEditingRef.current = noteEditing;
  const openNoteEditor = useCallback(() => {
    if (!noteEditingRef.current) setNoteDraft(sessionNoteText);
    noteEditingRef.current = true;
    setNoteEditing(true);
  }, [sessionNoteText]);
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
    setTimeout(openNoteEditor, 0);
  }, [openNoteEditor]);

  // Issue #3592: in the action bar the editor is `fixed` under the session
  // controls rather than `absolute` off them. The bar's left group is what its
  // width fit measures, and a 288px absolute editor hanging out of it counts as
  // its overflow ("does not fit") — the fit would fold the controls, and the
  // editor with them, the moment it opened. A fixed box is not part of any
  // ancestor's overflow; it stays in the slot's DOM, and so in the split's.
  // Placed before paint whenever the controls change place (the slots: inline,
  // parked hidden, the "…" panel), then followed once per frame while open —
  // the anchor moves without anything resizing (the bar's fit, a label left of
  // it), as the Verification reason popover follows its chip. While the anchor
  // is hidden (parked) there is no position: none is carried into the next
  // place it is shown.
  const barSessionRef = useRef<HTMLDivElement | null>(null);
  // Issue #3631: the agent's name in the selector trigger.
  const sessionLabelRef = useRef<HTMLSpanElement | null>(null);
  const barNotePosition = useBarNotePosition(
    noteEditing,
    inActionBar,
    headerSlots,
    barSessionRef,
    BAR_NOTE_EDITOR_WIDTH,
    BAR_NOTE_EDITOR_MARGIN,
  );

  const {
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    dragRingClass,
    focusRingClass,
  } = useSplitDragDrop(onDropInstance, draggedInstanceId, availableInstances, AGENT_INSTANCE_DND_MIME);

  // Issue #3514: the selected split is framed in accent, so which pane the
  // header "+" / the Action bar's maximize will act on is visible at a glance.
  const borderClass = showFocusFrame ? 'border-accent-500' : 'border-border';
  // Issue #3592: with its controls in the action bar, the lone split sits
  // flush under the bar, whose bottom border is its top edge — the band above
  // the terminal is the header and the bar, and not a pixel more.
  const flushTopClass = inActionBar ? ' border-t-0 rounded-t-none' : '';

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
  // Issue #3592: in the action bar the model and the cost are drawn only as
  // far as the bar's width allows, so the selector carries them as its tooltip
  // — the same strings the two chips' own tooltips use.
  const selectorTitle = resolveSelectorTitle(t, inActionBar, agentModel, agentUsage, agentUsageDetail);

  // Issue #3631: in a split's 30px title bar (two or more splits) the name has
  // a floor — `min(BAR_SESSION_LABEL_MIN_WIDTH, the name's own width)` — so in a
  // narrow quarter of the 2x2 grid the model / usage / note chips give way and
  // the name is not clipped to "C". The name's own width caps it so a short
  // name is never padded (CSS cannot say `min(3rem, max-content)`), hence the
  // measurement. The action bar keeps #3615's rule (fold behind "…"), so the
  // floor is cleared there.
  useLayoutEffect(() => {
    const label = sessionLabelRef.current;
    if (!label) return;
    label.style.minWidth = '';
    if (inActionBar) return;
    label.style.minWidth = `${Math.min(label.scrollWidth, BAR_SESSION_LABEL_MIN_WIDTH)}px`;
  }, [attachLabel, inActionBar]);

  // Issue #3592: the controls of this split's title bar. Drawn in the title
  // bar with two or more splits, and — the same elements — portalled into the
  // action bar's slots with one split (see `SplitPaneHeaderControls`).
  const sessionControls = (
    <>
      {/* Issue #1079: native <select> → Radix DropdownMenu. The trigger reads as
          a session title (StatusDot + alias + chevron); the radio group keeps
          the same single-select value/onChange semantics as the old <select>. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid={`cli-selector-${splitIndex}`}
          aria-label={selectInstanceLabel}
          title={selectorTitle}
          // Issue #3631: in the title bar the trigger keeps its automatic
          // minimum (dot + the name's floor + chevron) instead of `min-w-0`.
          className={`flex items-center gap-1.5 ${inActionBar ? 'min-w-0' : ''} max-w-[12rem] rounded px-1.5 py-0.5 text-xs border border-border bg-surface text-surface-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:ring-2 data-[state=open]:ring-ring transition-colors`}
        >
          <StatusDot
            status={status}
            size="sm"
            aria-hidden
            data-testid={`split-status-indicator-${splitIndex}`}
            label={showUnclassifiedDot ? tCommon(UNCLASSIFIED_STATUS_LABEL_KEY) : undefined}
            className={showUnclassifiedDot ? UNCLASSIFIED_STATUS_DOT_CLASS : undefined}
            data-unclassified={showUnclassifiedDot ? 'true' : undefined}
          />
          <span
            ref={sessionLabelRef}
            className="truncate"
            // Issue #3615: in the action bar, a name clipped narrower than this
            // folds the controls behind "…" instead.
            {...(inActionBar ? { [FIT_MIN_WIDTH_ATTR]: BAR_SESSION_LABEL_MIN_WIDTH } : {})}
          >
            {attachLabel}
          </span>
          <ChevronDown size={14} aria-hidden="true" className="flex-shrink-0 opacity-70" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-[10rem]"
          // Issue #3592: in the action bar's "…" panel this menu is a layer of
          // the panel — a press in it must not close the panel under it.
          data-floating-layer={inActionBar ? 'true' : undefined}
        >
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

      <SplitSessionChips
        splitIndex={splitIndex}
        splitLabel={splitLabel}
        inActionBar={inActionBar}
        surfaceMode={surfaceMode}
        onSurfaceModeChange={onSurfaceModeChange}
        agentModel={agentModel}
        agentUsage={agentUsage}
        agentUsageDetail={agentUsageDetail}
        sessionNote={sessionNote}
        noteStamp={noteStamp}
        noteLabel={noteLabel}
        noteEditLabel={noteEditLabel}
        openNoteEditor={openNoteEditor}
      />

      {/* Issue #1171: session-scoped extras (the End × button) sit directly
          after the instance selector, before the search button, so the
          terminate action reads as tied to the selected session. The search
          button keeps `ml-auto` and stays pinned to the right edge. */}
      {headerExtras}
    </>
  );

  const actionControls = (
    <SplitActionControls
      splitIndex={splitIndex}
      splitLabel={splitLabel}
      searchLabel={searchLabel}
      inActionBar={inActionBar}
      isMaximized={isMaximized}
      maximizeDisabled={maximizeDisabled}
      onSearchClick={handleSearchClick}
      onToggleMaximize={onToggleMaximize}
      onEndSession={onEndSession}
    />
  );

  // Issue #2427: the note editor, absolutely positioned UNDER the header
  // so opening it never changes the header's height — this row sits above
  // a terminal whose visible height is a measured budget (#2106), and a
  // popover that pushed it down would resize the pane every time somebody
  // wrote a memo. `z-30` clears the terminal's own painted rows.
  const noteEditor = noteEditing ? (
    <div
      data-testid={`split-session-note-editor-${splitIndex}`}
      // Issue #3592: in the action bar it is fixed (see `barNotePosition`)
      // with a width of its own.
      style={
        inActionBar
          ? barNotePosition
            ? { top: barNotePosition.top, left: barNotePosition.left, width: BAR_NOTE_EDITOR_WIDTH }
            : // Placed before paint (the layout effect); never `visibility:
              // hidden` meanwhile, which would refuse the input's focus.
              { top: 0, left: 0, width: BAR_NOTE_EDITOR_WIDTH }
          : undefined
      }
      className={`rounded-md border border-border bg-surface p-2 shadow-lg ${
        inActionBar ? 'fixed z-50' : 'absolute top-full z-30 mt-1 inset-x-2'
      }`}
    >
      <SessionNoteInput
        initialText={sessionNoteText}
        value={noteDraft}
        onValueChange={setNoteDraft}
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
  ) : null;

  return (
    <div
      role="region"
      aria-label={splitLabel}
      data-testid={`terminal-split-pane-${splitIndex}`}
      data-split-index={splitIndex}
      data-focused={showFocusFrame ? 'true' : undefined}
      style={style}
      // Issue #1079: the pane is a card (rounded, clipped, hairline border).
      // Focus is expressed subtly via `focus-within` (a soft accent ring) instead
      // of the old flashy full-perimeter accent border.
      className={`flex flex-col min-w-0 h-full rounded-lg overflow-hidden border ${borderClass} bg-surface${flushTopClass}${focusRingClass}${dragRingClass}`}
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
          height (and therefore cannot resize the terminal underneath).
          Issue #3592: a fixed 30px, and absent while this is the only split —
          its controls are then in the action bar (the portals below). */}
      {headerSlots ? null : (
        <div
          data-testid={`split-header-${splitIndex}`}
          className="relative h-[30px] px-2 flex items-center gap-2 bg-surface-2 border-b border-border flex-shrink-0"
        >
          {sessionControls}
          {actionControls}
          {noteEditor}
        </div>
      )}
      {/* Issue #3592: the lone split's controls in the action bar. The pane stays
          put in the React tree, so only these move when the split count does. */}
      {headerSlots
        ? createPortal(
            // `data-split-index`: these controls are this split's even out
            // of its subtree, for the split's own shortcuts (Mod+Shift+M /
            // Mod+Shift+Enter resolve their owner through it).
            <div
              ref={barSessionRef}
              data-testid={`split-bar-session-${splitIndex}`}
              data-split-index={splitIndex}
              // Issue #3651: one line on the bar; folded into the narrow "…"
              // panel (the slot's `data-folded`), the controls wrap onto
              // further lines (`gap-1.5` spaces the lines too).
              className={BAR_SESSION_ROW_CLASS}
            >
              {sessionControls}
              {noteEditor}
            </div>,
            headerSlots.session,
          )
        : null}
      {headerSlots
        ? createPortal(
            <div
              data-testid={`split-bar-actions-${splitIndex}`}
              data-split-index={splitIndex}
              className="flex items-center gap-0.5"
            >
              {actionControls}
            </div>,
            headerSlots.actions,
          )
        : null}

      {/* Body: terminal display (or attach skeleton) */}
      <div ref={bodyRef} className="flex-1 min-h-0 relative" data-testid={`split-body-${splitIndex}`}>
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
