# opencode-live-1896 — raw opencode frames carrying a numbered list

Live `tmux capture-pane -p -e` captures used by
`tests/unit/detection-opencode-numbered-list-1896.test.ts` (Issue #1896).

**These files are raw on purpose. Do not strip ANSI and do not "tidy" the box
drawing out of them.** Two of the verdicts under test are anchored on the input
box's own gutter (`┃`, U+2503) — the permission button strip (Issue #1893) and
the composer row (Issue #1883) — and the whole point of the suite is that a
detector must tell an interactive box apart from the transcript above it. A
fixture with the box drawing normalised away would let a detector that reads
numbers out of a response body pass every assertion here. The first test in the
file asserts the raw bytes are still present and fails loudly if someone
normalises them.

## Provenance

| | |
|---|---|
| Captured | 2026-08-22 |
| Agent | opencode 1.18.21 (model `GPT-5.6 Luna`, provider GitHub Copilot) |
| Pane geometry | 80x200 — `OPENCODE_PANE_HEIGHT`, the production layout |
| Session | `probe` on a private tmux socket (`tmux -L oc1896`), over a throwaway git directory, killed afterwards |
| Project config | a scratch `opencode.json` holding `{"permission": {"bash": "ask", "edit": "ask"}}` — **not** written into any repository |
| Command | `tmux -L oc1896 capture-pane -p -e -t probe` |

Pane height matters here for the same reason it does in `opencode-live-1883`
and `opencode-live-1893`: opencode anchors its input box (and the permission
dialog that replaces it) to the BOTTOM of the pane, ~180 rows below the
transcript row the decision belongs to, and fills the gap with padding. The
false positive this Issue is about only reproduces once that padding is there,
because it is `normalizeTuiFrameForDetection`'s blank-row compaction that pulls
a numbered list at row 8 into the same 50-row detection window as the footer at
row 195.

## The reproduction

The prompt sent to opencode in every "numbered" frame below was:

> Answer with ONLY this: three deployment options as a numbered list
> (1. On-premises (self-hosted) deployment / 2. Cloud-managed platform
> (AWS/GCP/Azure) / 3. Containerized deployment with Kubernetes), each on its
> own line, then a final line asking: Which one do you want?

which is the Issue's repro step 1. opencode answers with the list and the
question, then draws its finished-turn marker underneath:

```
     1. On-premises (self-hosted) deployment
     2. Cloud-managed platform (AWS/GCP/Azure)
     3. Containerized deployment with Kubernetes
        Which one do you want?
     ▣  Build · GPT-5.6 Luna · 2.8s
```

## Frames

| File | What is on the pane | Verdict pinned |
|---|---|---|
| `numbered-answer.txt` | the repro above, turn finished (`· 2.8s`) | `ready` / `opencode_response_complete`; `detectPrompt` → **not a prompt** |
| `numbered-answer-running.txt` | a 12-item numbered list streaming in, footer still reads `esc interrupt`, `▣ Build · GPT-5.6 Luna` carries **no** duration | `running` / `opencode_processing_indicator`; `detectPrompt` → **not a prompt** |
| `permission-over-numbered.txt` | the finished repro turn, then a `ls -la` permission dialog open over it | `waiting` / `opencode_permission_prompt`, `hasActivePrompt: false`; `detectPrompt` → **not a prompt** |
| `select-model-in-response.txt` | a response body whose first line is `Select model to continue:` | `ready` / `opencode_response_complete` |
| `model-picker.txt` | the real `/models` overlay (`Select model … esc`, `Search`, `● GPT-5.6 Luna …`) | `waiting` / `opencode_selection_list`, `hasActivePrompt: false` |
| `command-palette.txt` | the real ctrl+p overlay (`Commands … esc`) on a fresh session | `running` / `default` — the header allowlist deliberately does not cover it (see below) |
| `composer-typed-numbered.txt` | the repro text typed into the composer but **not sent** | `detectPrompt` → not a prompt |

## What each frame was measured to prove

- **`numbered-answer.txt`** is the reported bug verbatim. Before the fix,
  `detectSessionStatus` answered `waiting` / `prompt_detected` /
  `hasActivePrompt: true` and `detectPrompt(stripBoxDrawing(stripAnsi(…)))`
  answered `multiple_choice` with the three list items as options — so Auto-Yes
  resolved `"1"`, typed it into the composer and sent it as a **user
  utterance**, `send` was refused by the prompt guard and the sidebar went
  orange for the rest of the session.

- **`numbered-answer-running.txt`** is worse than what the Issue reports and is
  why the fix could not simply be "ignore a list that sits above a finished-turn
  marker": the same false `waiting` / `prompt_detected` was returned for a frame
  whose footer still said `esc interrupt`. Auto-Yes would have sent `1` into a
  turn that was still generating.

- **`permission-over-numbered.txt`** is the one with teeth. Issue #1893 added
  positive detection for opencode's permission dialog, but that branch lives
  *below* priority 1 in `detectSessionStatus`, so a stale numbered list higher
  up won the frame: the session was published as `prompt_detected` with the
  **wrong** options, and `resolveAutoAnswer` produced `"1"`. A number does
  nothing to that button strip (measured in #1893) but the Enter after it
  confirms whatever is highlighted — which is `Allow once`. The numbered-list
  inference could therefore approve a tool call the operator never saw.

- **`select-model-in-response.txt`** is the second half of the Issue:
  `OPENCODE_SELECTION_LIST_PATTERN` was the bare phrase and
  `status-detector.ts` tests it against the whole content area, so an answer
  that merely wrote `Select model to continue:` parked the session on
  `waiting` / `opencode_selection_list`.

- **`model-picker.txt`** is the guard in the other direction: the real overlay
  must keep matching after the pattern is narrowed to require the right-aligned
  `esc` hatch. Note it is **not numbered** — `●` marks the current entry and the
  list is driven by ↑/↓ + Enter. Together with the permission strip's ←/→ + Enter,
  that is the whole of opencode 1.18's interactive surface, and it is the
  measurement behind `hasNumberedDialogs: false`.

- **`command-palette.txt`** records a gap rather than a fix. opencode draws the
  same picker chrome for ctrl+p under a `Commands` header, which the header
  allowlist does not include — before and after this change. The frame lands on
  `running` / `default`, i.e. the "no positive evidence" side that #1708's
  unclassified-frame guard already covers (`wait` stops after the 60s dwell
  rather than reporting a false completion), so widening the allowlist is a
  separate change that needs its own live frames.

- **`composer-typed-numbered.txt`** holds the repro text sitting *unsent* in the
  composer. It never was a prompt and must not become one.
