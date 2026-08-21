# opencode-live-1893 — raw opencode permission-dialog frames

Live `tmux capture-pane -p -e` captures used by
`tests/unit/detection-opencode-permission-dialog-1893.test.ts` (Issue #1893).

**These files are raw on purpose. Do not strip ANSI and do not "tidy" the box
drawing out of them.** Two of the three verdicts under test are anchored on the
dialog box's own gutter (`┃`, U+2503): the button strip `Allow once   Allow
always   Reject` is read as positive evidence that a decision is pending only
when it sits *inside the box*, which is the same distinction Issue #1883 had to
draw for the composer row. A fixture with the box drawing normalised away would
let a detector that reads those labels out of a response body pass every
assertion in the suite. The first test in the file asserts the raw bytes are
still there and fails loudly if someone normalises them.

## Provenance

| | |
|---|---|
| Captured | 2026-08-22 |
| Agent | opencode 1.18.21 (model `GPT-5.6 Luna`, provider GitHub Copilot) |
| Pane geometry | 80x200 — `OPENCODE_PANE_HEIGHT`, the production layout |
| Session | `ocprobe` on a private tmux socket (`tmux -L cm1893probe`), over a throwaway directory, killed afterwards |
| Project config | a scratch `opencode.json` holding `{"permission": {"bash": "ask", "edit": "ask"}}` — **not** written into any repository |
| Command | `tmux -L cm1893probe capture-pane -t '=ocprobe:' -p -e -S -200 -E -` |

Pane height matters as much here as it does for `opencode-live-1883`. opencode
draws the permission box anchored to the BOTTOM of the pane — roughly 180 rows
below the transcript row the decision belongs to — and fills everything between
with padding, which is why `detectSessionStatus` has an opencode-specific
content-area branch at all (Issue #473). A frame re-captured at a default pane
height would put the box and the Build marker in the same tail window and would
not reproduce any of this.

## The frames

| File | What it is | Expected verdict |
|---|---|---|
| `permission-bash.txt` | The Issue's own repro: first turn, `ls -la` requested, box open on `# Shell command`. The transcript above it ends in the **duration-less** `▣  Build · GPT-5.6 Luna` | `waiting` / `opencode_permission_prompt` / `hasActivePrompt: false` |
| `permission-edit.txt` | The same box for an `edit`, with the unified diff in it. Same heading, same three buttons | `waiting` / `opencode_permission_prompt` |
| `permission-after-complete.txt` | The box open while the PREVIOUS turn's genuine `▣  Build · GPT-5.6 Luna · 2.3s` is still on screen | `waiting` / `opencode_permission_prompt`; `isOpenCodeComplete` **false** |
| `turn-aborted-no-duration.txt` | The frame after answering `Reject`: box gone, opencode idle, and the only Build row it left behind has no duration | not `ready`; no completion marker claimed |
| `turn-complete-short.txt` | A two-word answer that took 2.3 s: `▣  Build · GPT-5.6 Luna · 2.3s` | `ready` / `opencode_response_complete` |

## What the dialog actually takes (measured, not assumed)

This is the measurement that decided the published shape, so it is written down
rather than left in a commit message. Keys were sent with
`tmux -L cm1893probe send-keys` and the button row diffed byte-for-byte between
captures:

| Key | Effect on the button strip |
|---|---|
| `Right` | moves the highlight `Allow once` → `Allow always` → `Reject` |
| `Left` | moves it back |
| `Tab` | **nothing** — the `⇆ select` hint means the arrow keys, not Tab |
| `3` | **nothing** — the row is byte-identical before and after |
| `Enter` | confirms whatever is highlighted |

The highlight is an SGR background (`48;2;245;167;66` with `38;2;10;10;10`
foreground) on the selected label; `Allow once` carries it when the box opens.

That table is why the detector publishes this as a `menu`
(`SELECTION_LIST_REASONS`, `hasActivePrompt: false`) and not as a prompt with
three numbered options. `sendPromptAnswer` sends a numeric answer to opencode as
literal text followed by Enter — cursor navigation is reserved for
claude/antigravity — so `respond <id> 3` would type a swallowed `3` and then
confirm the highlighted button. **Asking to Reject would have approved.**
`wait` still stops for the frame (`isSelectionListActive` → exit 10) and the UI
renders NavigationButtons, which send the arrow keys the strip does take.

## Why the anchor is the button row and not the heading

`△ Permission required` is a heading; the strip is the affordance. Two further
reasons, both from these captures:

- `enter confirm` is **truncated to `enter con`** at opencode's own 80-column
  layout, so the footer verb cannot be anchored on;
- the `bash` and the `edit` dialog differ in their body (`# Shell command` and a
  `$ …` line vs a `→ Edit <path>` line and a diff) but share the heading and the
  strip exactly.

`turn-aborted-no-duration.txt` is the staleness half of the same argument: it
holds no `Allow once` at all, so a matched strip is always the live box and
never scrollback. (Compare Codex, where an answered approval block *does* linger
and needs `isCodexStalePrompt`.)

## Why "short responses omit the duration" was wrong

The docstring on `OPENCODE_RESPONSE_COMPLETE` justified an optional duration
with "short responses may omit the timing portion". `turn-complete-short.txt` is
a 2.3-second, two-word answer and it carries `· 2.3s`, so no completed turn ever
needed that branch. What the duration-less form actually marks is a step that is
**still open** — the one blocked on the dialog in `permission-bash.txt` — or one
that was **aborted**, as in `turn-aborted-no-duration.txt`.

Making the duration mandatory (`OPENCODE_TURN_COMPLETE_PATTERN`) therefore costs
one thing, deliberately: an aborted turn no longer reports `ready`. It falls
through to the heuristics with no positive evidence, which is what design rule
D1 asks for — `ready` there would be a completion nobody observed — and `wait`
reaches it through the existing unclassified path rather than reporting a turn
that never finished as done.

`OPENCODE_RESPONSE_COMPLETE` itself stays loose on purpose: `tui-accumulator`,
`response-cleaner` and the turn-boundary counter in `response-checker` use it to
DROP the summary row from an extracted response, and the mid-step row has to be
dropped too.
