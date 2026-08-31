'use client';

/**
 * OpencodeQuickKeys — the opencode chords CommandMate's read-only terminal
 * cannot otherwise reach (Issue #2046).
 *
 * The terminal pane is read-only, so the ONLY way a key reaches opencode is a
 * button that POSTs to `/api/worktrees/[id]/special-keys`. opencode 1.18.22
 * prints two of its own bindings in its footer (`tab agents`, `ctrl+p
 * commands`) and hides the rest behind a `ctrl+x` leader; none of them were
 * reachable before this component existed.
 *
 * ## What is on the strip, and what is deliberately not
 *
 * Every key here was read out of opencode 1.18.22's own default keybind table
 * and then driven against a live TUI on an isolated `HOME` and a private tmux
 * socket. The run is `docs/design/opencode-server-live-verification.md` §22.
 *
 * Three of opencode's real bindings are **not** here:
 *
 *   - **`ctrl+x b` (`sidebar_toggle`).** Measured, and refused. #2047 established
 *     that opencode paints its sidebar at ≥121 columns and that the sidebar
 *     shares capture ROWS with the transcript, which breaks three readers. What
 *     #2046 measured is that the explicit toggle **overrides that width gate**:
 *     at the 80 columns `resolveOpencodePaneWidth()` defaults to, `ctrl+x b`
 *     turns the sidebar on anyway, and the same frame then reads `running` /
 *     `unknown_frame` instead of `ready` / `opencode_response_complete`, with
 *     the sidebar's own text saved as the assistant's reply. Escape does not
 *     undo it. Before the first turn the binding is inert instead, and the `b`
 *     lands in the composer as literal text. There is no width at which the
 *     button is both useful and safe, so it is not offered.
 *   - **`f2` (`model_cycle_recent`).** Switches the active model with no dialog
 *     and no confirmation. It could not be measured without first putting a
 *     second model in the recent list, which means opening the model picker —
 *     the one thing §4 of the design doc forbids, because the picker rewrites
 *     opencode's default model. Unmeasured, so not published.
 *   - **`ctrl+x q` (`app_exit`).** Killing the agent already has its own
 *     affordance; a one-click quit next to nine navigation keys is a misfire
 *     waiting to happen.
 *
 * ## Why some buttons disable themselves
 *
 * `sidebar_toggle`, `messages_undo`, `messages_redo`, `session_compact` and
 * `session_timeline` are SESSION-SCOPED in opencode: on the home screen — the
 * pane's state until its first turn completes — the leader does not consume the
 * following letter, and that letter is typed into the composer instead
 * (measured for `b` / `u` / `r` / `c` / `g`). A stray character there is visible
 * in {@link UnsentComposerBar}, but it also flips detection from `ready` /
 * `input_prompt` to `running` / `unknown_frame` until it is cleared. So the
 * session-scoped group is disabled until this pane reports an agent session.
 * `agentSession.session` is the signal, which means a pane whose event stream is
 * not wired keeps them disabled — a visible, reversible degradation, chosen over
 * a button that quietly types junk.
 *
 * ## The chord itself
 *
 * A leader chord is ONE request carrying TWO array entries, `['C-x', 'b']`.
 * `sendSpecialKeys()` sends them one at a time with `SPECIAL_KEY_DELAY_MS`
 * (100 ms) between, and opencode's `leader_timeout` default is 2000 ms; the
 * 100 ms gap was confirmed to land the chord 3/3 on a live TUI. The leader key
 * itself is read from `OPENCODE_LEADER_KEY` rather than written next to each
 * row, so a tool whose leader differs changes one declaration.
 *
 * ## Both screens fold it away (Issue #2106 for the phone, #2131 for PC)
 *
 * Seventeen 44px targets do not fit beside a terminal on a phone. Measured in a
 * real browser at the two viewports #2106 names — see
 * `tests/e2e/mobile-opencode-quick-keys-2106.spec.ts` — this strip wraps to
 * SEVEN rows and stands **378px** tall at both 390x730 and 360x640, which left
 * `TerminalDisplay` 40px at 390x730 and **0px** at 360x640. (#2106's own
 * estimate, taken from label widths rather than a browser, said ~265px for the
 * strip and ~140px left for the terminal. The measurement is worse on both
 * counts and is what this component now records.)
 *
 * #2106 then wrote here that PC did not need the same treatment "because a split
 * pane has the width and nothing there is being squeezed". **That was wrong, and
 * it was wrong because nobody had measured PC.** #2131 did:
 *
 *   | PC configuration      | quick keys        | TerminalDisplay |
 *   |-----------------------|-------------------|-----------------|
 *   | claude, 1 split       | none              | 670px           |
 *   | opencode, 1 split     | 206px             | 456px  (-32%)   |
 *   | opencode, 3 splits    | 578px / 11 rows   | **64px** (-90%) |
 *
 * The 3-split row carries its own control: splits 1 and 2 showed no strip and
 * kept 650px of terminal in the SAME frame, so the only variable is the strip.
 * A split pane does not have the width — it has a THIRD of it — and the terminal
 * pays the entire bill, because the footer block is `flex-shrink-0` while
 * `TerminalDisplay` is the sole `flex-1 min-h-0` sibling.
 *
 * So both callers pass `collapsible` now. What they do NOT share is the
 * preference behind it: `layout` selects a per-screen localStorage key and a
 * per-screen default (phone CLOSED, PC OPEN) — see
 * {@link useOpencodeQuickKeysDisclosure}. PC's own measurements live in
 * `tests/e2e/desktop-opencode-quick-keys-2131.spec.ts`, which is the regression
 * guard #2106 did not have.
 *
 * ## Why the key notation disappears on a narrow pane (Issue #2131)
 *
 * The phone passes `compact`, which drops the `ctrl+x g` suffix beside each
 * label; PC did not, so the same seventeen buttons are wider on PC than on a
 * phone and wrap into MORE rows at the same width (378px / 7 rows on a phone
 * against 578px / 11 rows in a 3-split PC pane). PC now drops the suffix too —
 * but only while the strip is actually narrow, via a CSS container query
 * ({@link OPENCODE_QUICK_KEYS_NOTATION_MIN_CONTAINER_PX}) rather than a measured
 * breakpoint in JS. It is worth 150px in a 3-split pane (open strip 494px →
 * 344px), all of which the terminal gets.
 *
 * A container query, not `ResizeObserver`: #2131 explicitly refused deciding
 * anything from an observed width, the pane width is not knowable from the props
 * this component is given (`TerminalSplitContainer` owns the split count and
 * `PaneResizer` owns the widths, neither of which reaches here), and the browser
 * already re-evaluates the query on every resize with no render of ours. The
 * suffix stays in `title` and `aria-label` at every width, so nothing is lost
 * from the accessible name — only the printed glyphs go.
 *
 * ## The press-feedback timer is owned, not fired and forgotten (Issue #2174)
 *
 * The highlight that follows a press is a `setTimeout` that clears `activeId`
 * after {@link KEY_PRESS_FEEDBACK_RESET_MS}. It arrived with the strip itself in
 * #2046 (`ceb1059d`) — not in #2131, which #2174's text names because
 * `git log -1 -- <this file>` reports the file's LAST commit rather than the
 * line's — and it arrived without a handle, so nothing could cancel it: a pane
 * unmounted inside those 150 ms left a callback that still ran and still called
 * `setActiveId(null)`. In a browser that is inert — React drops the update on a
 * torn-down root. Under jsdom it is not: when the timer outlives the test that
 * armed it, it fires against an environment whose `window` is already gone, and
 * surfaces as an unhandled error attributed to whichever test happens to be
 * running at the time.
 *
 * So the id lives in a ref and is cleared in both places that can invalidate it
 * — the next press (which re-arms from zero rather than inheriting the previous
 * press's remaining time) and unmount. That is the shape every other transient
 * feedback timer in this tree already uses ({@link CopyButton},
 * `TruncationTooltip`, `MemoCard`). Nothing observable moves: the highlight
 * still appears synchronously on press and still clears exactly
 * `KEY_PRESS_FEEDBACK_RESET_MS` later.
 *
 * The same uncollected pattern is still open in `TerminalEscapeHatch` and
 * `NavigationButtons`, which share this component's `useSpecialKeys` transport
 * but not its file; #2174's scope stops at this file.
 */

import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { OPENCODE_LEADER_KEY } from '@/types/terminal-keys';
import { useSpecialKeys } from '@/hooks/useSpecialKeys';
import { KEY_PRESS_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';
import {
  useOpencodeQuickKeysDisclosure,
  type OpencodeQuickKeysLayout,
} from '@/hooks/useOpencodeQuickKeysDisclosure';

export interface OpencodeQuickKeysProps {
  worktreeId: string;
  /** Rendered only for `'opencode'`; anything else renders nothing at all. */
  cliToolId: CLIToolType;
  /** Agent instance id. Defaults to the primary instance (`=== cliToolId`). */
  instanceId?: string;
  /**
   * Whether opencode has reported a session for this pane.
   *
   * Gates the session-scoped chords — see the module docblock. Callers pass
   * `agentSession.session !== null`.
   */
  hasAgentSession: boolean;
  /** Trigger an immediate terminal refresh after the keys are sent. */
  onKeysSent?: () => void;
  /** Phone rendering: drop the key-notation suffix, keep the touch targets. */
  compact?: boolean;
  /**
   * Issue #2106: wrap the strip in a persisted disclosure.
   *
   * When on, the component renders a single 44px toggle row and reveals the
   * toolbar underneath only while open; the open/closed state is device-wide and
   * survives reloads ({@link useOpencodeQuickKeysDisclosure}).
   *
   * Both real callers pass it since Issue #2131 (the phone since #2106). It
   * still defaults to OFF, which is what an embedder that has already solved its
   * own vertical budget gets, and what the always-open toolbar tests assert.
   */
  collapsible?: boolean;
  /**
   * Issue #2131: which screen's disclosure preference to read, and how wide the
   * strip must be before it prints the key notation.
   *
   * Only meaningful together with `collapsible`. Defaults to `'mobile'` — the
   * only caller that existed before #2131 — so nothing about the phone changes.
   */
  layout?: OpencodeQuickKeysLayout;
}

/** One button: a label, the keys it sends, and whether it needs a session. */
interface QuickKeyDef {
  /** Stable id, also the translation key under `worktree.opencodeQuickKeys`. */
  id: string;
  /** Key names sent in one special-keys request, in order. */
  keys: readonly string[];
  /** Key notation shown beside the label and spoken in the accessible name. */
  notation: string;
  /** True when opencode only honours this binding once a session exists. */
  sessionScoped?: boolean;
}

/** Build a leader chord from the tool's declared leader key. */
function chord(letter: string): readonly string[] {
  return [OPENCODE_LEADER_KEY, letter];
}

/* eslint-disable no-restricted-syntax -- i18n(#1271): the `notation` strings are
   opencode's own key notation (`tab`, `ctrl+p`, `ctrl+x a`), printed that way in
   its footer and its command palette. They are identical in every locale. Every
   prose label is a translation key resolved through t() at render time. */

/** Keys opencode honours with no leader and in every state. */
const DIRECT_KEYS: ReadonlyArray<QuickKeyDef> = [
  { id: 'agentNext', keys: ['Tab'], notation: 'tab' },
  { id: 'agentPrev', keys: ['BTab'], notation: 'shift+tab' },
  { id: 'commands', keys: ['C-p'], notation: 'ctrl+p' },
  { id: 'variant', keys: ['C-t'], notation: 'ctrl+t' },
];

/** Leader chords that open a dialog whether or not a session exists. */
const GLOBAL_CHORDS: ReadonlyArray<QuickKeyDef> = [
  { id: 'agents', keys: chord('a'), notation: 'ctrl+x a' },
  { id: 'sessions', keys: chord('l'), notation: 'ctrl+x l' },
  { id: 'newSession', keys: chord('n'), notation: 'ctrl+x n' },
  { id: 'models', keys: chord('m'), notation: 'ctrl+x m' },
  { id: 'themes', keys: chord('t'), notation: 'ctrl+x t' },
];

/** Leader chords opencode ignores until the pane has a session. */
const SESSION_CHORDS: ReadonlyArray<QuickKeyDef> = [
  { id: 'timeline', keys: chord('g'), notation: 'ctrl+x g', sessionScoped: true },
  { id: 'undo', keys: chord('u'), notation: 'ctrl+x u', sessionScoped: true },
  { id: 'redo', keys: chord('r'), notation: 'ctrl+x r', sessionScoped: true },
  { id: 'compact', keys: chord('c'), notation: 'ctrl+x c', sessionScoped: true },
];

/**
 * Transcript scrolling. Already in every tool's base vocabulary since #1017, so
 * nothing about the transport changes here — opencode simply binds them too
 * (`messages_page_up: pageup`, `messages_first: ctrl+g,home`,
 * `messages_last: ctrl+alt+g,end`).
 */
const SCROLL_KEYS: ReadonlyArray<QuickKeyDef> = [
  { id: 'pageUp', keys: ['PageUp'], notation: 'pgup' },
  { id: 'pageDown', keys: ['PageDown'], notation: 'pgdn' },
  { id: 'first', keys: ['Home'], notation: 'home' },
  { id: 'last', keys: ['End'], notation: 'end' },
];

/* eslint-enable no-restricted-syntax */

const GROUPS: ReadonlyArray<ReadonlyArray<QuickKeyDef>> = [
  DIRECT_KEYS,
  GLOBAL_CHORDS,
  SESSION_CHORDS,
  SCROLL_KEYS,
];

/**
 * How many keys the disclosure toggle says are hidden underneath (Issue #2106).
 * Derived, so it cannot drift from the groups the way a written-out 17 would.
 */
const QUICK_KEY_COUNT = GROUPS.reduce((total, group) => total + group.length, 0);

/**
 * Container width at or above which the key notation is printed (Issue #2131).
 *
 * Declared as a constant so the number is reviewable, but the Tailwind class
 * below MUST spell the same value as a literal: Tailwind 4 scans source text for
 * class names (`src/app/globals.css` limits `@source` to components / app /
 * hooks), so an interpolated `@min-[${N}px]:inline` would generate no CSS at all
 * and the suffix would be hidden at every width. `tests/unit/components/worktree/
 * OpencodeQuickKeys-2131.test.tsx` asserts the literal and the constant agree.
 *
 * The value is where the suffix stops being free rather than a design token.
 * Measured by `tests/e2e/desktop-opencode-quick-keys-2131.spec.ts` on a 1920px
 * desktop: three splits give the strip **428px** of width and one split gives it
 * **1329px**, so 640 is the only decision the two configurations disagree about.
 * What the suffix costs at 428px was measured by putting `inline` back in place
 * of this query and re-running the same spec: the open strip goes 344px → 494px
 * (three extra wrapped rows) and the terminal 497px → 347px.
 */
export const OPENCODE_QUICK_KEYS_NOTATION_MIN_CONTAINER_PX = 640;

export const OpencodeQuickKeys = memo(function OpencodeQuickKeys({
  worktreeId,
  cliToolId,
  instanceId,
  hasAgentSession,
  onKeysSent,
  compact = false,
  collapsible = false,
  layout = 'mobile',
}: OpencodeQuickKeysProps) {
  const t = useTranslations('worktree');
  const [activeId, setActiveId] = useState<string | null>(null);
  const send = useSpecialKeys(worktreeId, cliToolId, instanceId, onKeysSent);
  // Issue #2106. Called unconditionally (hooks rule) and for every tool, which
  // is one localStorage read on a PC pane that then ignores the value — the
  // alternative was moving the `cliToolId !== 'opencode'` gate into the mobile
  // caller, i.e. a second copy of the one gate #2046 deliberately kept here.
  const { open: disclosureOpen, toggle: toggleDisclosure } =
    useOpencodeQuickKeysDisclosure(layout);
  const panelId = useId();
  // Issue #2174: see the module docblock. The press highlight is the only thing
  // this timer does, so dropping it on unmount costs nothing and keeps the
  // callback from outliving the tree that owns the state it writes.
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) {
        clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = null;
      }
    };
  }, []);

  const handleClick = useCallback(
    (def: QuickKeyDef) => {
      setActiveId(def.id);
      // Re-arm from zero: without this the previous press's timer would still be
      // pending and would clear the CURRENT press's highlight early.
      if (feedbackTimerRef.current !== null) {
        clearTimeout(feedbackTimerRef.current);
      }
      feedbackTimerRef.current = setTimeout(() => {
        feedbackTimerRef.current = null;
        setActiveId(null);
      }, KEY_PRESS_FEEDBACK_RESET_MS);
      send([...def.keys]);
    },
    [send],
  );

  // Not a feature flag: every binding on this strip belongs to opencode's TUI,
  // so for any other tool there is nothing to render. Issue #2106 keeps the gate
  // here (rather than in the mobile caller) so there is still exactly one of it,
  // which is also what keeps the disclosure toggle from appearing for claude.
  if (cliToolId !== 'opencode') return null;

  const toolbar = (
    <div
      // Issue #2106: inside the disclosure the rounded muted panel belongs to the
      // wrapper, so the toolbar drops its own background and top padding and
      // becomes the panel's body.
      // Issue #2131: `@container` makes THIS element the query container for the
      // notation suffix below, so the suffix answers to the width the buttons
      // actually wrap in (the split pane's) and not to the viewport's — a
      // 3-split pane and a 1-split pane on the same 1920px desktop must not get
      // the same answer.
      className={`@container flex flex-wrap items-center gap-1.5 ${
        collapsible ? 'px-1.5 pb-1.5' : 'py-1.5 bg-muted rounded-lg'
      }`}
      id={collapsible ? panelId : undefined}
      role="toolbar"
      aria-label={t('opencodeQuickKeys.toolbarLabel')}
      data-testid="opencode-quick-keys"
    >
      {/* Issue #2106: the disclosure's own toggle already names the strip, so
          repeating the caption two lines below it is duplicate label text that
          also costs a wrap slot on a phone. */}
      {collapsible ? null : (
        <span className="text-xs text-muted-foreground mx-2">
          {t('opencodeQuickKeys.caption')}
        </span>
      )}
      {GROUPS.map((group, groupIndex) => (
        <div key={group[0].id} className="flex flex-wrap items-center gap-1.5">
          {groupIndex > 0 ? (
            <span className="w-px h-6 bg-border mx-0.5" aria-hidden="true" />
          ) : null}
          {group.map((def) => {
            const label = t(`opencodeQuickKeys.keys.${def.id}`);
            const disabled = def.sessionScoped === true && !hasAgentSession;
            return (
              <button
                key={def.id}
                type="button"
                disabled={disabled}
                className={`min-h-[44px] px-3 py-2 text-sm font-medium rounded-md
                  border border-border
                  focus:outline-none focus:ring-2 focus:ring-ring
                  transition-colors duration-75
                  disabled:opacity-50 disabled:cursor-not-allowed
                  ${activeId === def.id
                    ? 'bg-accent-500 text-white border-accent-500 scale-95'
                    : 'bg-surface dark:bg-surface-2 hover:bg-muted active:bg-muted disabled:hover:bg-surface'
                  }`}
                aria-label={`${label} (${def.notation})`}
                title={
                  disabled
                    ? t('opencodeQuickKeys.needsSession', { notation: def.notation })
                    : `${label} — ${def.notation}`
                }
                data-testid={`opencode-quick-key-${def.id}`}
                onClick={() => handleClick(def)}
              >
                {label}
                {/* Issue #2131: `compact` (the phone) drops the suffix outright;
                    everyone else keeps it in the DOM and lets the container
                    query decide, so one resize of a split shows or hides it with
                    no re-render. Keep the literal in sync with
                    OPENCODE_QUICK_KEYS_NOTATION_MIN_CONTAINER_PX — Tailwind
                    cannot read the constant. */}
                {compact ? null : (
                  <span className="ml-1.5 text-xs text-muted-foreground hidden @min-[640px]:inline">
                    {def.notation}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );

  // The bare always-open toolbar. No caller takes this branch since Issue #2131
  // put PC behind a disclosure too; it stays because `collapsible` is opt-in and
  // an embedder with its own vertical budget should not be forced into a toggle.
  if (!collapsible) return toolbar;

  return (
    <div className="bg-muted rounded-lg" data-testid="opencode-quick-keys-disclosure">
      <button
        type="button"
        // Issue #1127's tap-target rule: min-h-[44px] + touch-manipulation. This
        // one row is the ENTIRE footprint of the strip while it is closed.
        className="w-full min-h-[44px] flex items-center gap-2 px-3 py-2 text-sm font-medium
          rounded-lg touch-manipulation transition-colors
          hover:bg-surface-2 active:bg-surface-2
          focus:outline-none focus:ring-2 focus:ring-ring"
        aria-expanded={disclosureOpen}
        aria-controls={panelId}
        aria-label={
          disclosureOpen
            ? t('opencodeQuickKeys.hideKeys')
            : t('opencodeQuickKeys.showKeys')
        }
        data-testid="opencode-quick-keys-toggle"
        onClick={toggleDisclosure}
      >
        <ChevronDown
          className={`w-4 h-4 shrink-0 transition-transform duration-150 ${
            disclosureOpen ? '' : '-rotate-90'
          }`}
          aria-hidden="true"
        />
        <span>{t('opencodeQuickKeys.toolbarLabel')}</span>
        <span className="ml-auto text-xs text-muted-foreground">{QUICK_KEY_COUNT}</span>
      </button>
      {disclosureOpen ? toolbar : null}
    </div>
  );
});

export default OpencodeQuickKeys;
