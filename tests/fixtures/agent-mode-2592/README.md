# `agent-mode-2592` — permission-mode frames

Frames for `detectAgentMode()` (`src/lib/detection/agent-mode.ts`), one per mode
per declaring tool, plus one frame per tool in the state where **nothing names a
mode**. Read by `tests/unit/lib/detection/agent-mode-2592.test.ts`.

Every file is a whole pane with its ANSI intact, at the geometry its base capture
was taken at. That is deliberate and it is what the suite is for: the measured
rows arrive wrapped in SGR (`\x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m …`), so a
reader that forgets `stripAnsi` matches nothing at all, and a reader that scans
the whole frame instead of a tail window answers with a footer from an hour ago.
A stripped or trimmed fixture would let both defects through.

## Provenance

Three kinds of file, and the distinction matters when one of these ever
disagrees with a real pane.

### A. Verbatim live captures (unmodified, byte for byte)

| file | copied from | shows |
|---|---|---|
| `claude-auto.txt` | `tests/fixtures/claude-live-2247/boot-banner.txt` | `⏵⏵ auto mode on (shift+tab to cycle) · ← for agents` (claude 2.1.258) |
| `command-code-default.txt` | `tests/fixtures/command-code-live-2250/boot-idle-1490.txt` | `? for shortcuts · taste on` (Command Code 1.49.0) |
| `codex-default.txt` | `tests/fixtures/codex-live-2310/idle-composer.txt` | a status bar with **no** mode badge (codex 0.15x) |
| `copilot-default.txt` | `tests/fixtures/tool-liveness-2070/copilot-ready-1080.txt` | the hint bar with **no** mode word (copilot 1.0.80) |
| `antigravity-default.txt` | `tests/fixtures/antigravity-live-2478/after-tool-turn.txt` | a footer with **no** mode segment (agy, `Gemini 3.8 Flash · hig`) |

The four "default" rows are the load-bearing ones. Issue #2592
§「設計に効く事実」3 says four of the five tools draw nothing in their base mode,
and these are that claim as data: the suite asserts `unknown` on them, which is
what stops anybody re-deriving `default` from "no row matched".

### B. One real row transplanted onto another real frame

| file | body from | footer row from |
|---|---|---|
| `claude-manual.txt` | `claude-live-2247/boot-banner.txt` | row 1000 of `tests/unit/lib/tmux/fixtures/capture-claude-idle.txt`, verbatim |

Both halves are live captures of the same tool at the same geometry; only the
pairing is synthetic.

### C. Reconstructed rows — the mode phrase substituted into a real row

The remaining files take a real captured row and splice in the spelling Issue
#2592 measured on 2026-09-16 (private tmux socket, 200x60, repository root, the
tools killed afterwards). The Issue records the spellings and not the frames, so
the surrounding bytes — indentation, SGR, right-alignment, line width — are the
real capture's and only the named phrase is the Issue's.

| file | base row | substitution |
|---|---|---|
| `claude-accept-edits.txt` | claude footer, row 1000 | `⏵⏵ auto mode on` → `⏵⏵ accept edits on` |
| `claude-plan.txt` | claude footer, row 1000 | `⏵⏵ auto mode on` → `⏸ plan mode on` |
| `command-code-accept-edits.txt` | 1.49.0 idle frame | a new row `» accept edits on [shift+tab]` **above** the shortcut row (the 1.53.1 layout) |
| `command-code-plan.txt` | 1.49.0 idle frame | a new row `plan mode [shift+tab]` above the shortcut row |
| `command-code-bypass-1490.txt` | 1.49.0 idle frame | the shortcut row **replaced** by `» permission bypass on` (the 1.49.0 layout, where `ModeIndicator` swaps the row rather than adding one) |
| `codex-plan.txt` | codex status bar | `Plan mode (shift+tab to cycle)` appended at the bar's right end |
| `copilot-plan.txt` | copilot hint bar | ` · plan` spliced into the bar |
| `copilot-autopilot.txt` | copilot hint bar | ` · autopilot` spliced in **and `· ? help` removed** — #2592 measured the bar losing that element in autopilot, so the element count is mode-dependent and a positional reader would break here |
| `antigravity-accept-edits.txt` | agy footer | `accept-edits · ` in front of the model chip, the row keeping its width |
| `antigravity-plan.txt` | agy footer | `plan · ` in front of the model chip |

The claude spellings in (C) are not guesses: #1927's measurement table
(`src/lib/detection/tools/claude/patterns.ts`, claude-cli 2.1.240 across all four
permission modes) records `⏸ plan mode on (shift+tab to cycle)` and
`⏵⏵ accept edits on (shift+tab to cycle)` verbatim, and #2592 re-confirmed the
cycle on 2.1.273. The Command Code spellings are #2250's
(`tests/fixtures/command-code-live-2250/README.md`, "The footer row is
mode-dependent"), which lists all five of `ModeIndicator`'s strings.

**Two tools' base-mode spelling is therefore the only thing in this directory
that rests on #2592's prose alone**: codex's badge and copilot's words. If either
ever reads differently on a live pane, fix the pattern in
`src/lib/cli-tools/agent-mode-spec.ts` and re-cut the file here from a real
capture — do not adjust the reader to match the fixture.

## Regenerating

Nothing here is generated at test time; the files are checked in. They were
produced once by a script that does the substitutions above against the base
captures named in the tables. Re-cutting one by hand is fine — the tables say
exactly which row to touch.

## Not in this directory

`opencode`, `vibe-local` and `gemini` have no frames here because they declare no
mode spec (`resolveAgentModeSpec` returns `null`), and the suite pins that
negative against the real registry rather than against a fixture. See
`src/lib/cli-tools/agent-mode-spec.ts` for why each one is out.
