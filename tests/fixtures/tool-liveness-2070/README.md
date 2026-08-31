# tool-liveness-2070 — live panes for "the session is there, the TOOL is not"

Real `tmux capture-pane` output used by
`tests/unit/detection/tool-liveness-2070.test.ts` and
`tests/unit/cli-tools/session-relaunch-2070.test.ts` (Issue #2070).

Each tool appears twice: a pane it still owns, and the pane it leaves behind
when it quits. The pair is the whole point — the rule under test is a
conjunction ("none of this tool's chrome at the bottom" **and** "the last row is
positively a shell prompt"), and a fixture set with only the second half would
let a rule that reads every `❯` as a shell pass.

## Provenance

| | |
|---|---|
| Captured | 2026-08-31 |
| Pane geometry | 200 x 1000 — `TUI_PANE_WIDTH` x `TUI_PANE_HEIGHT`, the production layout (`opencode-*` is the same server-side geometry; opencode resizes itself after launch) |
| Isolation | a private tmux server, `tmux -L cm2070`, one throwaway directory per tool under a scratch path; torn down with `kill-session -t '=<name>:'` |
| Command | `tmux -L cm2070 capture-pane -t '=cm2070-<tool>:' -p -S -60 -E -` |
| Shell | zsh with the macOS default prompt (`user@host dir %`) |

ANSI escapes are **not** present: the capture was taken without `-e`, which is
also what `scripts/check-control-chars.mjs` requires of a tracked file. Every
consumer of these frames strips ANSI before matching anyway
(`judgeToolLiveness` calls `stripAnsi` first).

The operator's user name and host name are replaced, **length for length**
(`maenokota` → `localuser`, `MAENOnoMac-Studio` → `EXAMPLEMac-Studio`), and so
are the session UUIDs. The length is load-bearing and must stay so: the exited
codex prompt is exactly 40 characters, which is exactly
`MAX_SHELL_PROMPT_LENGTH` — see below.

## Frames

| File | What is on the pane | What it pins |
|---|---|---|
| `claude-ready-21251.txt` | claude 2.1.251, banner and empty composer | `❯` is a composer, not a shell |
| `claude-exited-21251.txt` | after `/exit`: the launch line and a fresh prompt | claude's own verdict, unchanged by this Issue |
| `codex-ready-01491.txt` | codex 0.149.1, `› Ask Codex to do anything` | `›` is a composer |
| `codex-trust-dialog-01491.txt` | codex parked on "Do you trust the contents of this directory?" | a pane the tool owns even though it is not *ready* — a dialog must not read as an exit |
| `codex-exited-01491.txt` | after `Ctrl+C`: banner scrollback, `codex resume …`, prompt | **the frame this Issue exists for** (see below) |
| `copilot-ready-1080.txt` | copilot 1.0.80, composer between two rules | `❯` again, with a 198-column footer |
| `copilot-exited-1080.txt` | after `/exit` | |
| `opencode-ready-11823.txt` | opencode 1.18.23 home screen, `Ask anything...` behind the gutter | the placeholder plus `tab agents  ctrl+p commands` |
| `opencode-exited-11823.txt` | after `/exit` | the alternate screen is torn down, so nothing of the TUI survives |
| `gemini-dialog-0551.txt` | gemini 0.55.1 parked on its sign-in dialog | a full-width box with no composer: kept alive by the 200-column last row, not by a pattern |
| `gemini-exited-0551.txt` | after `Ctrl+C` twice: the session-summary box, then the prompt | box rows two lines above the shell prompt — which is why box drawing is **not** an alive pattern for gemini |

## Why `codex-exited-01491.txt` is the one that matters

Two properties of that single frame are what the rule had to be built around,
and `tests/unit/detection/tool-liveness-2070.test.ts` reverts each one in turn
to show the verdict flips:

1. **codex's own chrome is still in the pane.** `› 1. Yes, continue`, from the
   trust dialog the session was launched through, sits roughly a thousand rows
   above the shell prompt. A whole-frame `^›` test finds it and calls a dead
   session alive forever — hence `ToolLivenessSpec.aliveTailLines`.
2. **the shell prompt is exactly 40 characters.** `MAX_SHELL_PROMPT_LENGTH` is
   40 and claude's rule rejects a last row *at or above* it, so the endings rule
   alone reads this prompt as TUI output — hence
   `ToolLivenessSpec.shellPromptPatterns`, checked before the length gate.

claude keeps neither field (`aliveTailLines: null`, `shellPromptPatterns: []`),
because Issue #2070's acceptance condition is that claude's verdicts do not
move. That asymmetry is deliberate and is asserted, not merely commented.
