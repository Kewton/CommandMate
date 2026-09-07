# codex-live-2310 — the codex frames the `›` rules are read off

Live `tmux capture-pane -p -e` captures used by
`tests/unit/lib/detection/codex-structural-dialog-2310.test.ts` (Issue #2310),
`tests/unit/lib/detection/codex-chrome-2400.test.ts` and
`tests/unit/lib/polling/response-checker-codex-saturated-footer-2400.test.ts`
(Issue #2400).

They sit here rather than beside the older detection frames because
`tests/unit/polling/auto-yes-dialog-gate.test.ts` walks
`tests/unit/lib/detection/fixtures/` whole and pins by name every answerable
dialog it finds — so dropping two more numbered dialogs into that tree would
rewrite another suite's control list as a side effect of capturing a frame.

**These files are raw on purpose. Do not strip ANSI from them.** The whole point
of the Issue is that codex draws `›` (U+203A) at column 0 for three different
things and only the SGR attributes tell them apart. A stripped fixture would let
a detector that reads every `›` as the composer pass the whole suite — which is
precisely the defect being fixed. The test file asserts the escape sequences are
still present and fails loudly if someone normalises them.

## Provenance

| | |
|---|---|
| Captured | 2026-09-04 |
| Agent | codex-cli 0.153.2 (model `gpt-5.6-sol`, `approval_policy = "on-request"`, `sandbox_mode = "workspace-write"`) |
| Pane geometry | 200x1000 (production layout) |
| Session | `probe` on a private tmux socket (`tmux -L cm2310`), disposable `HOME`, a scratch git repo as cwd; server killed and the copied credential removed afterwards |
| Command | `tmux capture-pane -p -e -t probe` |

## The frames

| File | Screen | Footer | Before #2310 | After |
|---|---|---|---|---|
| `dialog-experimental-toggles.txt` | `/experimental` | `Press space to select or enter to save for next conversation` | **`ready`** | `waiting` / `codex_selection_list` |
| `dialog-keymap-editor.txt` | `/keymap` | `left/right group · enter edit shortcut · * custom · - unbound · esc close` | **`ready`** | `waiting` / `codex_selection_list` |
| `dialog-permissions-picker.txt` | `/permissions` | `Press enter to confirm or esc to go back` | `waiting` / `codex_selection_list` | unchanged |
| `dialog-trust-directory.txt` | directory trust, first launch | `Press enter to continue` | `waiting` / `prompt_detected` | unchanged |
| `idle-composer.txt` | idle, empty composer | *(model/cwd status bar)* | `ready` | unchanged |
| `turn-running.txt` | generating, composer still drawn | *(status bar; `Working (7s · esc to interrupt)` above)* | `running` | unchanged |

The first two rows are the defect. Both screens are blocked on a keypress and
both were reported `ready`, which is what made Auto-Yes see nothing to answer,
the sidebar dot go green, and `commandmate wait` close on `scraper_ready` while
the operator's session had not moved.

The last four rows are the negative controls that any fix has to keep: two
dialogs that already resolved correctly (so the fix must not re-classify them)
and the two idle/running frames whose bottom-most `›` is the composer (so the
fix must not turn a live session yellow — the #1883 shape, where an over-eager
`waiting` closed the send guard on every send).

## The `›` rows, verbatim

This is the measurement the rules rest on. `cat -v`, with `^[` for ESC:

| Frame | Row | Kind |
|---|---|---|
| `dialog-experimental-toggles.txt` | `^[[1m^[[38;5;6m› [ ] Network proxy                Apply network proxy…^[[0m` | option — bold label |
| `dialog-keymap-editor.txt` | `^[[1m^[[38;5;6m› Global       - Open Agents                unbound^[[0m` | option — bold label |
| `dialog-permissions-picker.txt` | `^[[1m^[[38;5;6m› 1. Ask for approval (current)  Codex can read and edit…^[[0m` | option — bold label |
| `dialog-trust-directory.txt` | `^[[38;5;6m› 1. Yes, continue^[[39m` | option — **not bold**; recognised by the coloured glyph |
| `idle-composer.txt` | `^[[1m›^[[0m ^[[2mAsk Codex to do anything^[[0m` | composer — bold glyph, plain (dim) label |
| `turn-running.txt` row 13 | `^[[1;2m› ^[[0mRun the shell command: sleep 25…` | transcript echo — dim glyph |
| `turn-running.txt` row 21 | `^[[1m›^[[0m ^[[2mAsk Codex to do anything^[[0m` | composer — the bottom-most `›`, which is why the frame reads `running` and not `waiting` |

`dialog-trust-directory.txt` is why the rule recognises an option **positively**
(bold label OR coloured glyph) instead of defining it as "not the composer": its
option row is neither bold nor dim, so a rule phrased the other way round would
have to guess, and guessing wrong on an idle composer is the expensive direction.

## Neither leaking list is numbered

Both `/experimental` and `/keymap` draw their choices without `1. / 2. / 3.`, so
`findNumberedOptionBlock` — the reader every tool's `prompt.ts` uses — finds
nothing on either frame. That is why `readCodexDialogFrame` leads with the
attribute rule and keeps the numbered block as its second, `stripAnsi`-surviving
reading rather than the other way round.

## What these frames do NOT cover

An ANSI-stripped capture of the two leaking frames still reads `ready`: the lists
are unnumbered, so neither reading has anything left to work with once the
attributes are gone. That path is Auto-Yes's `captureAndCleanOutput`, which does
not publish session status, and the suite pins the limit explicitly rather than
leaving it to be discovered.

---

## Issue #2400 — the saturated pane, and the frames that made it

`response-checker.ts` had no bottom-pinned-chrome reader for codex, unlike
claude (#1289), copilot (#1897), opencode (#1911) and Command Code (#2250). That
cost nothing until the capture window saturated (#1670), at which point the turn
anchor became "the newest echoed user prompt, searched from the bottom" — and
the bottom-most `›` of a codex pane is the COMPOSER. Extraction started on the
row below it, so the reply saved for every turn on a saturated pane was codex's
status bar (`gpt-6-astra xhigh · ~/share/work/…`), identically each time, which
then locked `isDuplicateResponse` for the rest of the session.

### Provenance of the three frames added here

| | |
|---|---|
| Captured | 2026-09-07 |
| Agent | codex-cli 0.153.4 (model `gpt-6-astra`, `approval_policy = "on-request"`, `sandbox_mode = "workspace-write"`) |
| Pane geometry | 200x1000 (production layout) |
| Session | private tmux socket (`tmux -L cm2400`), disposable `HOME` with a copied credential, a scratch git repo as cwd; server killed and the credential removed afterwards |
| Command | `tmux capture-pane -p -e -t <session>` (`-S -10000` for the saturated one) |

| File | Screen | Why it is here |
|---|---|---|
| `saturated-idle-tail.txt` | idle, one finished turn, on a pane whose history had outgrown the capture window | The defect frame. The echo, the reply, the composer and the status bar, with the attributes that separate them |
| `turn-submitted-no-status.txt` | ~0.3 s after Enter: the echo is drawn, the `Working (… esc to interrupt)` row is not yet | The only measured frame where the scraper reads a live turn as `ready` / `input_prompt`, and the frame that shows a fresh echo is drawn **bold**, not dim |
| `steer-queued-running.txt` | a second message sent while a turn is running | The negative control for the same question: steering does **not** produce a `ready` gap |

### `saturated-idle-tail.txt` is a tail, and why

The capture it came from was 11,000 rows on a pane whose `history_size` was
11,025 — genuinely past `CACHE_MAX_CAPTURE_LINES`. Storing all of it would add
~220 KB to the repository of which 9,940 rows are the shell scrollback
(`transcript row <n>`, printed with `seq` before codex was started in the pane)
that exists only to push the pane past the window. So the **last 60 rows** are
stored raw and the filler is reconstructed by the poller-level suite, which
rebuilds a capture of exactly `CACHE_MAX_CAPTURE_LINES` rows and asserts
`isCaptureWindowSaturated` on it rather than assuming it. Everything that decides
the outcome — the echo, the three reply rows, the composer, the status bar and
their SGR attributes — is the live capture, byte for byte. The same
reconstruction is what `response-checker-capture-window-saturation.test.ts` has
done for #1670 since it was written; this fixture only replaces its hand-written
codex rows with measured ones.

### The `›` rows these three add

| Frame | Row | Kind |
|---|---|---|
| `saturated-idle-tail.txt` | `^[[1;2m› ^[[0mReply with exactly three short lines describing what a worktree is.` | settled transcript echo — dim glyph |
| `saturated-idle-tail.txt` | `^[[1m›^[[0m ^[[2mAsk Codex to do anything^[[0m` | composer — bold glyph, dim label |
| `turn-submitted-no-status.txt` | `^[[1m› ^[[0mWrite a haiku about tmux.` | **freshly submitted** echo — bold glyph, plain label |

The last row is the measurement #2310's table did not have, and it is why the
turn anchor cannot be a per-row attribute rule alone: for the first fraction of
a second after Enter, codex draws the echo with the composer's own signature and
only re-renders it dim once the turn settles. `findCodexUserEchoIndex` therefore
takes the composer boundary from its caller (position) and uses the attributes
only to recognise dialog options and settled echoes.

### What the steer measurement found

Issue #2400 asked whether `isCodexTurnActive` can see a turn that has just been
steered. Measured on 0.153.4, at 0.1–0.25 s sampling:

* **Steering a running turn keeps the turn visible.** With a tool call in flight
  and with pure generation, codex keeps `Working (Ns · esc to interrupt)` on
  screen and adds `Messages to be submitted after next tool call (press esc to
  interrupt and send immediately)` plus `↳ <the steered text>`
  (`steer-queued-running.txt`). 132 consecutive samples across a full
  steer-and-submit cycle: **zero** frames without the interrupt hint while the
  turn was live. `isCodexTurnActive` reads these as `running`.
* **The `ready` window belongs to plain submission, not to steering.** For
  roughly 0.3 s after Enter the echo is on screen and the `Working` row is not
  (`turn-submitted-no-status.txt`); that frame has no interrupt hint and no
  activity marker in the band above the composer, so it reads `ready` /
  `input_prompt` while the hooks-backed status already says `running`. Every
  send passes through it, steered or not.

Deciding what to do about that window (holding completion for N seconds after
`user_prompt_submit`, or reading it from the hook side) is left outside #2400 —
the frame is captured here so the next Issue starts from a measurement rather
than from the assumption that steering is what produces it.
