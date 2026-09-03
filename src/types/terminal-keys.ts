/**
 * Terminal navigation key vocabulary (Issue #1922).
 *
 * This lives outside `src/lib/tmux/**` on purpose. `NavigationKey` is the one
 * tmux-adjacent symbol the browser bundle needs (`NavigationButtons.tsx` /
 * `TerminalEscapeHatch.tsx` type their key props with it), and as long as it was
 * declared in `src/lib/tmux/tmux.ts` those two client components had to import
 * from the tmux module to get it — a client → tmux dependency edge that the
 * `no-restricted-imports` guard added for §4 D4 of
 * `docs/design/multi-agent-state-architecture.md` exists to remove.
 *
 * The alternative considered and rejected (D4, DR3-001) was switching the guard
 * to `@typescript-eslint/no-restricted-imports` with `allowTypeImports: true`.
 * That would permanently bless the edge and leave a path where deleting the word
 * `type` from an import turns a compile-time reference into a runtime one. Moving
 * the declaration costs one file and closes the edge outright.
 *
 * Values only — no tmux process access — so this module is safe from any layer.
 */

/**
 * The characters a dialog is answered WITH rather than navigated by (Issue #2254).
 *
 * `1`–`9` are the option numbers every numbered TUI dialog in this repository
 * offers (codex's trust / `/model` pickers, claude's `PermissionRequest`
 * screens, the hooks-review flow), and `y` / `n` are the two letters a bare
 * `[y/n]` accepts. They are LITERAL characters on the wire, exactly like the
 * codex pager's `q` has been since #1017 and opencode's chord letters since
 * #2046 — `tmux send-keys -- 1` types a `1`.
 *
 * WHY THEY ARE IN THE BASE VOCABULARY, i.e. offered to every tool
 * ---------------------------------------------------------------
 * The state this exists for is "a wait is on screen and nothing could read it"
 * (`ChatSurface`'s `promptUnreadable`). By construction nobody knows which tool
 * drew that dialog *shape*, so there is no per-tool declaration to hang these
 * off; what IS known is that the dialog is waiting for an answer, and that the
 * chat surface had no way to send one before this Issue — the `/send` route
 * refuses with `prompt_waiting`, and `/special-keys` published only arrows.
 *
 * The cost is the same one #2046 weighed for opencode's letters: a caller may
 * POST `{cliToolId:"claude", keys:["y"]}` at an IDLE pane and type a `y` into
 * the composer. That is a typo, not an escalation — the route has always been
 * able to type `q` into any composer, sending a character is what the route is
 * FOR, and the UI only draws these buttons while a wait is unreadable. What is
 * deliberately still refused is a free string: `/send`'s `prompt_waiting` guard
 * is untouched, `MAX_KEYS_LENGTH` is 10, and every other letter stays a 400.
 *
 * Note the overlap with {@link OPENCODE_LEADER_CHORD_VALUES}: `n` is in both,
 * and `tests/unit/cli-tools/navigation-keys-declaration-2046.test.ts` pins the
 * intersection to exactly `['n']` so a future widening of either list cannot
 * quietly hand another tool an opencode chord letter.
 */
export const ANSWER_KEY_VALUES = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'y', 'n',
] as const;

/**
 * Navigation keys accepted by the special-keys API and the terminal UI.
 *
 * Separate from `SPECIAL_KEY_VALUES` (the `sendSpecialKey()` control keys) and
 * from `ALLOWED_SPECIAL_KEYS` (the broader `sendSpecialKeys()` TUI set).
 *
 * [DR3-001] Named NAVIGATION_KEY_VALUES to avoid collision with existing SPECIAL_KEY_VALUES.
 * [DR2-004] Exported as an `as const` array + type guard (not a Set) for immutability.
 */
export const NAVIGATION_KEY_VALUES = [
  'Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Tab', 'BTab',
  // Issue #1017: Codex pager / edit-previous mode keys surfaced by NavigationButtons.
  // 'q' is the pager quit key (literal char). PageUp/PageDown/Home/End are tmux named keys.
  'PageUp', 'PageDown', 'Home', 'End', 'q',
  // Issue #2254: the answer characters. Appended rather than interleaved so the
  // pre-#2254 prefix of this list is still readable as one line in a diff.
  ...ANSWER_KEY_VALUES,
] as const;

/**
 * Navigation key type derived from NAVIGATION_KEY_VALUES.
 */
export type NavigationKey = typeof NAVIGATION_KEY_VALUES[number];

// ---------------------------------------------------------------------------
// Per-tool vocabularies (Issue #2046)
// ---------------------------------------------------------------------------

/**
 * opencode's leader prefix — the first half of a two-step chord.
 *
 * Measured, not assumed: opencode 1.18.22 ships `leader: "ctrl+x"` and
 * `leader_timeout: 2000` as the defaults in its own binary, and a live TUI on a
 * private tmux socket answered `C-x` + one letter at the 100 ms
 * `SPECIAL_KEY_DELAY_MS` the transport already sends multi-key requests with
 * (3/3 on `C-x` `a`). See `docs/design/opencode-server-live-verification.md` §22.
 */
export const OPENCODE_LEADER_KEY = 'C-x';

/**
 * The letters that complete an opencode leader chord, in the order the quick-key
 * strip renders them.
 *
 * These are LITERAL characters, not tmux key names — `tmux send-keys -- a` puts
 * an `a` through, exactly as `q` has done for the codex pager since #1017. The
 * one thing that makes them safe to hand to `tmux send-keys` is that they are
 * fixed single characters chosen here, delivered through `execFile` and never a
 * shell; the one thing that makes them safe to hand to *opencode* is that the
 * route only accepts them for a tool that declares them (see
 * `ICLITool.navigationKeys()`), so an `a` can never reach claude's composer.
 *
 * **`b` (`sidebar_toggle`) is deliberately absent.** It is a real opencode
 * binding and it is the one this Issue measured and refused: §22.3.
 */
export const OPENCODE_LEADER_CHORD_VALUES = [
  'a', 'l', 'n', 't', 'm', 'g', 'u', 'r', 'c',
] as const;

/**
 * opencode keys that need no leader.
 *
 * `C-p` opens the command palette (opencode prints `ctrl+p commands` in its own
 * footer) and `C-t` cycles the model variant — both confirmed live on 1.18.22.
 * `Tab` / `BTab` cycle the agent and are already in {@link NAVIGATION_KEY_VALUES}.
 */
export const OPENCODE_DIRECT_KEY_VALUES = ['C-p', 'C-t'] as const;

/**
 * {@link OPENCODE_LEADER_CHORD_VALUES} minus what the base pad already carries.
 *
 * Issue #2254 moved `n` into {@link ANSWER_KEY_VALUES}, and therefore into
 * {@link NAVIGATION_KEY_VALUES}, which every tool's declaration starts from —
 * so spreading the full chord list into the two unions below would list `n`
 * twice. A duplicate is harmless to `Array.prototype.includes`, which is all the
 * route does with these, and that is exactly why it needs its own guard: the
 * only thing that would notice is the "no duplicate entries" assertion in
 * `tests/unit/cli-tools/navigation-keys-declaration-2046.test.ts`.
 *
 * Written out rather than filtered at runtime because both unions are `as const`
 * tuples whose LITERAL member types are the `TerminalKey` union — a
 * `.filter()` would collapse them to `string[]` and take the compile-time check
 * with it. The same suite pins this list to
 * `OPENCODE_LEADER_CHORD_VALUES \ NAVIGATION_KEY_VALUES` so it cannot drift out
 * of step with either side.
 */
const OPENCODE_CHORD_ONLY_VALUES = ['a', 'l', 't', 'm', 'g', 'u', 'r', 'c'] as const;

/**
 * Everything an opencode pane may be sent — the base navigation pad plus this
 * tool's own chords. Returned by `OpenCodeTool.navigationKeys()`.
 */
export const OPENCODE_NAVIGATION_KEY_VALUES = [
  ...NAVIGATION_KEY_VALUES,
  OPENCODE_LEADER_KEY,
  ...OPENCODE_DIRECT_KEY_VALUES,
  ...OPENCODE_CHORD_ONLY_VALUES,
] as const;

/**
 * The union of every tool's vocabulary — what the tmux transport must be able to
 * deliver.
 *
 * This is NOT what any single request is validated against. Since Issue #2046
 * the special-keys route validates against the *declaring tool's* set
 * (`ICLITool.navigationKeys()`), and this list exists so the transport's
 * allow-list has one place to be checked against. The #2032 invariant is now
 * stated per tool — every declared key must be deliverable — and
 * `tests/unit/tmux/special-keys-allowlist-2032.test.ts` plus
 * `tests/unit/cli-tools/navigation-keys-declaration-2046.test.ts` pin both
 * halves.
 */
export const TERMINAL_KEY_VALUES = [
  ...NAVIGATION_KEY_VALUES,
  OPENCODE_LEADER_KEY,
  ...OPENCODE_DIRECT_KEY_VALUES,
  // Issue #2254: `n` is in the base pad now — see OPENCODE_CHORD_ONLY_VALUES.
  ...OPENCODE_CHORD_ONLY_VALUES,
] as const;

/** Any key name a tool may declare in its {@link NavigationKeySpec}. */
export type TerminalKey = typeof TERMINAL_KEY_VALUES[number];
