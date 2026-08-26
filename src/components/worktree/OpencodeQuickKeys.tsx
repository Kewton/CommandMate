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
 * ## The phone had to fold it away (Issue #2106)
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
 * So the mobile caller passes `collapsible`, which folds the whole strip behind
 * one 44px toggle that is CLOSED by default. PC does not: `collapsible` defaults
 * to false and `TerminalSplitPaneContent` renders the same always-open toolbar
 * it rendered before, because a split pane has the width and nothing there is
 * being squeezed.
 */

import { memo, useCallback, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { OPENCODE_LEADER_KEY } from '@/types/terminal-keys';
import { useSpecialKeys } from '@/hooks/useSpecialKeys';
import { KEY_PRESS_FEEDBACK_RESET_MS } from '@/config/ui-feedback-config';
import { useOpencodeQuickKeysDisclosure } from '@/hooks/useOpencodeQuickKeysDisclosure';

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
   * Issue #2106: wrap the strip in a persisted disclosure (mobile only).
   *
   * Off by default, so PC (`TerminalSplitPaneContent`) keeps rendering the bare
   * always-open toolbar it has rendered since #2046 — it has the width, and
   * nothing there is being squeezed. When on, the component renders a single
   * 44px toggle row and reveals the toolbar underneath only while open; the
   * open/closed state is device-wide and survives reloads
   * ({@link useOpencodeQuickKeysDisclosure}).
   */
  collapsible?: boolean;
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

export const OpencodeQuickKeys = memo(function OpencodeQuickKeys({
  worktreeId,
  cliToolId,
  instanceId,
  hasAgentSession,
  onKeysSent,
  compact = false,
  collapsible = false,
}: OpencodeQuickKeysProps) {
  const t = useTranslations('worktree');
  const [activeId, setActiveId] = useState<string | null>(null);
  const send = useSpecialKeys(worktreeId, cliToolId, instanceId, onKeysSent);
  // Issue #2106. Called unconditionally (hooks rule) and for every tool, which
  // is one localStorage read on a PC pane that then ignores the value — the
  // alternative was moving the `cliToolId !== 'opencode'` gate into the mobile
  // caller, i.e. a second copy of the one gate #2046 deliberately kept here.
  const { open: disclosureOpen, toggle: toggleDisclosure } = useOpencodeQuickKeysDisclosure();
  const panelId = useId();

  const handleClick = useCallback(
    (def: QuickKeyDef) => {
      setActiveId(def.id);
      setTimeout(() => setActiveId(null), KEY_PRESS_FEEDBACK_RESET_MS);
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
      className={`flex flex-wrap items-center gap-1.5 ${
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
                {compact ? null : (
                  <span className="ml-1.5 text-xs text-muted-foreground">{def.notation}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );

  // PC (`TerminalSplitPaneContent`) takes this branch and renders exactly what
  // it rendered before #2106.
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
