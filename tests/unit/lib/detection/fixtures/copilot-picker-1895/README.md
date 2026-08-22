# copilot-picker-1895 — raw copilot TUI frames of the picker screens

Live `tmux capture-pane -p -e` captures used by
`tests/unit/detection-copilot-picker-1895.test.ts` (Issue #1895).

**These files are raw on purpose. Do not strip ANSI and do not re-capture them
at a smaller pane height.** Like the `copilot-live-1885/` set next door, the
verdict under test is *positional*: a picker is what copilot draws **instead of**
its bottom chrome, so the evidence is the bottom of the pane and the trap is the
transcript ~950 rows above it. A frame trimmed to a default pane height would put
both inside the same window and stop reproducing the bug. The first test in the
suite asserts both properties and fails loudly if someone normalises them.

## Provenance

| | |
|---|---|
| Captured | 2026-08-22 |
| Agent | GitHub Copilot CLI 1.0.80, launched as `gh copilot` — the production `COPILOT_LAUNCH_COMMAND` |
| Pane geometry | 200x1000 — the production layout for copilot (design policy §4 D2) |
| Session | `cp1895` on a private tmux socket (`tmux -L cm1895probe`), over a scratch git repository, killed afterwards |
| Command | `tmux -L cm1895probe capture-pane -t '=cp1895:' -p -e -S -1000 -E -` |

## The two shapes of the bottom of the pane

Idle or generating, copilot pins five rows to the bottom:

```
 <cwd> [⎇ <branch>]                                   Session: N AIC used
────────────────────────────────────────────────────────────────────────
❯                                                                          ← composer
────────────────────────────────────────────────────────────────────────
 ← open sidebar · / commands · ? help · tab next tab       GPT-5.6 Terra   ← STATUS BAR
```

While a picker is up, **none of those five rows are drawn**. What sits at the
bottom instead is the picker's own key-hint footer:

```
 ↑/↓ to navigate · ←/→ reasoning effort · tab context window · shift+tab group: recommended · enter to select · esc to cancel
```

That substitution is the whole detector. `readCopilotStatusBar` (Issue #1885)
and `isCopilotSelectionFrame` (Issue #1895) read the same row and are mutually
exclusive by construction, which is what settles the order between the running
check and the picker check in `detectSessionStatus`.

## The frames

| File | What it is | Expected verdict |
|---|---|---|
| `picker-agent.txt` | `/agent`, with no custom agents in the workspace. Footer `n new agent · ? learn more · esc cancel` — the one picker with **no `↑/↓`** — and it is not the bottom row: a closing full-width rule sits under it | `waiting` / `copilot_selection_list` |
| `picker-theme.txt` | `/theme`. A boxed live preview above an unboxed footer | `waiting` / `copilot_selection_list` |
| `picker-permissions.txt` | `/permissions`. A picker whose body is a **two-option numbered list** (`❯ 1. Manual ✓` / `2. Allow all`) | `waiting` / `prompt_detected` / `hasActivePrompt: true` — PromptPanel, not NavigationButtons |
| `picker-skills.txt` | `/skills`. Footer `↑/↓ to navigate · enter to toggle · esc to close` | `waiting` / `copilot_selection_list` |
| `picker-mcp.txt` | `/mcp`. Footer `↑/↓ to select · enter to show · a to add · esc to close` | `waiting` / `copilot_selection_list` |
| `picker-statusline.txt` | `/statusline`. A boxed preview that contains a **fake composer row** (`│  ❯ Summarize the footer preview changes`) above the footer | `waiting` / `copilot_selection_list` |
| `picker-subagents.txt` | `/subagents`. Footer above a closing rule, like `/agent` | `waiting` / `copilot_selection_list` |
| `picker-vocabulary-in-response.txt` | copilot was asked to print the picker vocabulary and answered `Use /model. It opens the Select Model dialog.` / `Then type into the Search models... field.` / `↑/↓ to navigate · enter to select · esc to cancel` / `/ search · ↑/↓ navigate · …` as body text, while the status bar shows key hints | `ready` / `input_prompt`; the picker check must **not** match — this is the false-positive half of the Issue |
| `model-arg-immediate.txt` | The frame ~1s after `/model gpt-5-mini`: `● Model changed from gpt-5.6-terra (xhigh) to gpt-5-mini (medium) for this session.` and the chrome already back. **No picker was ever drawn** | `ready` / `input_prompt` |

`/model`'s own picker is not duplicated here — `copilot-live-1885/model-picker.txt`
is the same screen and the suite reads it from there.

## The eleven pickers, and the three that are not committed

`/model`, `/agent`, `/theme`, `/permissions`, `/skills`, `/mcp`, `/settings`,
`/statusline`, `/subagents`, `/resume` and `/session` were all opened in the
capture session and all eleven were verified against `isCopilotSelectionFrame`.
Three are deliberately absent from this directory: `/settings`, `/resume` and
`/session` render the operator's own configuration, session titles and paths from
unrelated repositories. Their **footer rows** carry no such content and are
pinned verbatim in the suite instead (`MEASURED_PICKER_FOOTERS`), which is the
half of those frames any pattern reads.

## What was measured, and what it rules out

**The pattern that was there matched nothing.** `COPILOT_SELECTION_LIST_PATTERN`
looked for `Search \w+...`, `Select Model`, and `to navigate … Enter to
select|confirm`. Against the eleven live pickers it matched **0**: `/model`
renders `❯  Search models…` with U+2026 rather than three periods, no picker
prints the words `Select Model`, and every footer spells its verbs in lower case.
So `detectSessionStatus` fell through to the `running`/`default` floor — no
NavigationButtons, and `cmate wait` sat on an open picker until a human closed
it — and `CopilotTool.waitForSelectionList` expired its full 5s window every
time.

**And it matched copilot's prose.** `picker-vocabulary-in-response.txt` is the
other direction, live: the reply contains `Select Model` and `Search models...`
verbatim. `normalizeTuiFrameForDetection` collapses the ~950 rows of blank
padding to one, which pulls the transcript into the old 30-row window, so that
finished turn was published as `waiting`/`copilot_selection_list`. The suite
asserts the trap text is still in the fixture, so the negative cannot go vacuous.

**Why a dialog is not a picker.** copilot draws the screens it wants *answered*
inside a box — every row reads `│ … │` and the bottom row is `╰─…─╯` — and they
wear the same lower-case `↑/↓ to navigate · enter to select · esc to cancel`
footer as the pickers. `copilot-live-1885/permission-dialog.txt` and
`tests/fixtures/copilot-folder-trust-1080.ts` are those screens, and both must
stay on `prompt_detected` with `hasActivePrompt: true`: they are the agent
blocked on the human, not a list the operator opened. Skipping boxed rows is
what keeps them there.

**`/permissions` is the exception that is not one.** It is a picker by footer and
a two-option numbered menu by body, so it lands on `prompt_detected` through the
`optionsCount <= 3` branch that has guarded this since Issue #547 — the branch
that was dead for as long as the pattern matched nothing.

**`/model <id>` opens no picker.** Measured: with an argument copilot switches in
place and the status bar carries the new model within ~300ms; with an unknown id
it prints the list of valid ids and changes nothing. Neither draws a picker,
which is why `sendModelCommand` no longer waits for one — and no longer sends the
bare `C-m` that wait used to guard.
