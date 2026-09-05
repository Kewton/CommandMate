# chat-dialog-card-2254 — raw TUI dialog panes for the chat surface's dialog card

Live `tmux capture-pane -p -e` captures used by
`tests/unit/lib/chat/dialog-frame-2254.test.ts` (Issue #2254) and, since Issue
#2297, by `tests/unit/lib/detection/selection-shape-2297.test.ts`,
`tests/unit/lib/detection/command-code-selection-list-2297.test.ts` and
`tests/unit/components/worktree/ChatSurface-selection-keys-2297.test.tsx` —
which read the same bytes for what the dialog OFFERS rather than for where the
blank rows are.

**These files are raw on purpose. Do not strip ANSI, do not trim the blank rows,
and do not "tidy" the box drawing or the trailing spaces out of them.** The blank
rows ARE the subject: `extractDialogFrameTail()` exists because a 200x1000 pane
is mostly empty, and the two claude/codex captures disagree about *which end* the
emptiness is at. A fixture with the padding normalised away would let a naive
`lines.slice(-16)` pass every assertion here and then render a blank card in
production. The first test in the suite asserts the raw bytes are still present
and fails loudly if someone normalises them.

## Provenance

| | |
|---|---|
| Captured | 2026-09-03; the two Issue #2297 rows on 2026-09-04 (`tmux -L cm2297`); the four Issue #2326 rows on 2026-09-05 (`tmux -L cm2326`) |
| Pane geometry | **200x1000** — `TUI_PANE_WIDTH` x `TUI_PANE_HEIGHT` from `src/config/tmux-pane-config.ts`, i.e. the production layout. Issue #2254's "known traps" calls this out: at a default 80x24 the blank-padding shapes below do not appear at all. |
| Isolation | private tmux socket (`tmux -L cmate-2254`), one throwaway `git init` directory under the session scratchpad, `kill-server` afterwards |
| Command | `tmux -L cmate-2254 capture-pane -p -e -t '=dlg:0.0' -S -0 -E -` |

Each agent was launched in that pane, driven to the dialog with `send-keys`, and
captured. **No dialog was confirmed**: every picker was closed with `Escape`, and
claude's `/model` overlay reported `Kept model as Opus 5 (1M context)` on exit —
the trap recorded in `docs/design/`-adjacent notes and in Issue #1495 is that
`Enter` on that overlay rewrites the user's global default.

## The files

| file | agent | dialog | rows | rows with content | where the content is |
|------|-------|--------|------|-------------------|----------------------|
| `claude-model-2-1-259.txt` | claude 2.1.259 | `/model` picker (5 numbered models, `❯` on the current one, effort row, `Enter to set as default · s to use this session only · Esc to cancel`) | 1000 | 14 | rows 2–4, then **986–1000** |
| `claude-trust-2-1-259.txt` | claude 2.1.259 | folder-trust dialog (`❯ No, exit` / `Yes, I trust this folder`) — an arrow-driven list with NO numbers | 1000 | 11 | rows **1–18** |
| `codex-model-0-151-0.txt` | codex-cli 0.151.0 | `Select Model and Effort` picker, 7 numbered options | 1000 | 25 | rows **1–32** |
| `codex-trust-0-151-0.txt` | codex-cli 0.151.0 | directory-trust dialog (`› 1. Yes, continue` / `2. No, quit`) | 1000 | 6 | rows **1–9** |
| `opencode-agent-overlay-1-18-27.txt` | opencode 1.18.27 | `ctrl+x a` agent-list overlay over a two-turn transcript, sidebar ON | 200 | 200 | everywhere |
| `claude-model-2-1-260.txt` | claude 2.1.260 | the same `/model` picker one build later (Issue #2297) — identical shape, and the build the "a number key commits AND saves the default" measurement was taken on | 1000 | 14 | rows 2–4, then **986–1000** |
| `command-code-model-1-40-1.txt` | Command Code 1.40.1 | `/model` picker (Issue #2297): provider-grouped model NAMES with no option numbers, a `› Type to search models...` filter row, footer `type to search · ↑/↓ navigate · shift+↑/↓ jump provider · enter to select · esc to cancel` | 1000 | 89 | rows **1–89** |
| `command-code-model-1-47-1-open.txt` | Command Code 1.47.1 | the same picker over a FIVE-TURN session (Issue #2326), as it opens — arrows on the default `DeepSeek V4 Flash (latest)` | 1000 | 333 | rows **1–333**: 256 of session, 77 of picker |
| `command-code-model-1-47-1-middle.txt` | Command Code 1.47.1 | the same frame after 32 ▼ — arrows on `Tencent Hy4 Preview` | 1000 | 333 | as above |
| `command-code-model-1-47-1-bottom.txt` | Command Code 1.47.1 | the same frame after 72 ▼ — arrows on the last row, `Grok 4.6` | 1000 | 333 | as above |
| `command-code-model-1-47-1-closed.txt` | Command Code 1.47.1 | the same pane immediately after `Escape` closed the picker: no footer, so nothing to crop to | 1000 | 258 | rows **1–258** |

### Both ends of the pane are represented, and that is the point

`claude-model` is **bottom-anchored**: claude has taken the terminal's alternate
screen (`ALTERNATE_SCREEN_CLI_TOOLS`) and paints the last ~15 rows, so the
padding is above the dialog. Rows 2–4 are the shell line that launched it, from
before the switch — worth having, because they are what a naive "everything from
the first content row" would drag into the card.

`codex-model`, `codex-trust` and `claude-trust` are **top-anchored**: codex
scrolls normally rather than using the alternate screen, and claude's trust
dialog is drawn *before* it takes the alternate screen. A session that has not
yet produced 1000 rows therefore leaves the rest of the pane blank **below** the
dialog.

That second shape is the one a "just take the last N lines" card renders as an
empty black box, and it is not a corner case: it is every codex session's first
dialog, and claude's folder-trust prompt — the two screens a user meets before
anything else. It is also why `ChatSurface` is handed `PaneTerminalState.output`
rather than `realtimeSnippet`: the snippet is `lines.slice(-100)`, which for
`codex-model-0-151-0.txt` is 100 blank rows.

`compactBlankRuns()` (Issue #1172 / #2049) drops leading AND trailing blank runs
outright, which is the whole reason `extractDialogFrameTail()` compacts *before*
it slices.

### Why the opencode file is 200 rows and the others are 1000

It was captured in the same 200x1000 pane, and opencode paints a background on
every row, so the full capture is ~191 KB of SGR — too large to be a useful
fixture. What is committed is its **last 200 rows**, which is
`OPENCODE_PANE_HEIGHT` (`src/config/tmux-pane-config.ts`): the height opencode's
own sessions actually run at in production, so the committed slice is the
production frame shape rather than an arbitrary trim. Every byte inside it is the
original capture's.

The sidebar is ON (the pane is 200 columns, well past opencode's 121-column
auto-gate), so the overlay shares its rows with the session/cost column. Issue
#2095 named that; Issue #2254 **accepts** it — the card's job is "you can see the
dialog", and pulling the overlay out of a two-column frame is Issue #2255.

## What Issue #2297 added, and what it could not get

`claude-model-2-1-260.txt` and `command-code-model-1-40-1.txt` were captured the
same way, on a private socket (`tmux -L cm2297`, `kill-session -t '=<name>:'`
afterwards, the user's default server never touched).

**Neither picker was confirmed with `Enter`**, and both were closed with
`Escape`. One thing DID change on the host and is recorded here rather than
hidden: while measuring whether a number key moves claude's highlight, `4` was
sent to the 2.1.260 `/model` overlay and claude answered `Set model to Sonnet 5
and saved as your default for new sessions`, writing `~/.claude/settings.json`.
That is the measurement design B rests on — **on claude's `/model` a number key
is the commit, and the commit is the global write** — and it is why the chat
surface refuses to draw number buttons on a frame whose footer offers a session
scope.

**No gemini capture.** Gemini CLI v0.57.0 is installed on the machine these were
taken on and could not reach a session: after the folder-trust dialog it stops on
`Failed to sign in. Message: This client is no longer supported for Gemini Code
Assist for individuals. To continue using Gemini, please migrate to the
Antigravity suite of products`, so `/model` never opens. Nothing about gemini's
picker is claimed anywhere in Issue #2297's implementation as a result; it keeps
the base vocabulary and the pre-#2297 controls.

## What Issue #2326 added: a picker that is NOT alone on its pane

The four `command-code-model-1-47-1-*` rows above were captured on 2026-09-05,
the same way as everything else here — private socket (`tmux -L cm2326`), a
throwaway directory under the session scratchpad, pane at the production
200x1000, `kill-server` afterwards. **The picker was never confirmed**: it was
closed with `Escape`, and the fourth file is that pane. The host's default model
is unchanged.

What is different about them is the 256 rows ABOVE the dialog. Command Code is
an inline tool (`alternate_on=0`), so `/model` paints the picker under whatever
the session has already printed rather than clearing the screen, and the
existing `command-code-model-1-40-1.txt` could not show that: it was captured on
a session with no turns behind it, so its "transcript" is nine rows of boot
banner. These four were driven through five real turns first — four of them
asking for a list of numbers, which is what makes 256 rows cheaply — and then
`/model`.

That gap is exactly the Issue: `extractDialogFrameTail`'s `selectionList` path
returned **every** compacted row, so the card drew 333 rows of which the picker
was the last 77, and the arrow-moved highlight was scrolled to below the fold.

Three of the four are the same session with the arrows in three different
places, so the frames differ **only** in which row carries the selection
background `48;2;45;43;85`. That is deliberate: it lets
`ChatDialogCard-2326.test.tsx` measure the follow at the top, the middle and the
bottom of the same list without any other variable moving.

### The trap these carry that the 1.40.1 capture does not

`48;2;45;43;85` is not only the picker's selection. Command Code paints the
same background on every past USER INPUT row (`❯ List the numbers …`), so the
open capture has six painted rows — five of them transcript — and the five are
caret-shaped as well. Issue #2323's "last mark on the screen wins" reads through
that correctly, and the crop removes the question by removing the rows; both are
asserted, so neither can quietly stop being true.

## Not here

- **No opencode permission dialog.** The install used for these captures approves
  bash and edit tool calls without asking (verified: `echo hello-2254` and a file
  write both ran with no prompt), so the side-by-side approval buttons #1893
  describes could not be reproduced. The overlay renderer is the same one the
  agent-list dialog above uses — the frames are drawn by the same painted-panel
  code — and `tests/fixtures/opencode-live-2046/w80/dialog-*.txt` remain the
  in-repo captures of the other four opencode dialogs at 80 columns.
- **No confirmed dialog.** Nothing here was answered; see Provenance.
