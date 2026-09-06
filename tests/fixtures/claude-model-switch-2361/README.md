# claude-model-switch-2361 — raw panes around a Claude `/model` switch

Live `tmux capture-pane -p -e` captures read by
`tests/unit/lib/detection/model-info-claude-switch-2361.test.ts`,
`tests/unit/lib/session/agent-model-switch-2361.test.ts` and
`tests/integration/model-change-claude-switch-2361.test.ts` (Issue #2361):
what `extractModelInfo('claude', …)` must answer after the session's model
changed, and what the #2357 receivers must do with that answer.

**Raw on purpose.** ANSI intact, blank rows intact. The model name on the
confirmation row is wrapped in its own SGR
(`Set model to \x1b[38;5;153mSonnet 5\x1b[39m for this session only`), which is
what the ANSI test reads. The one thing edited is the probe's working
directory on the banner's third row, which carried a user name:
`/private/tmp/cm2361-probe/work` stands in for it.

## Provenance

| | |
|---|---|
| Captured | 2026-09-06, claude 2.1.263 (`~/.local/bin/claude`), `tmux -L cm2361` |
| Pane geometry | **200x1000** (`TUI_PANE_WIDTH` x `TUI_PANE_HEIGHT`, `src/config/tmux-pane-config.ts`), `window-size manual` |
| Isolation | Private tmux socket. **`CLAUDE_CONFIG_DIR`** pointed at a throwaway directory holding a copy of `settings.json` (no hooks, no plugins) and a trimmed `.claude.json` (onboarding flags only); `HOME` untouched so the Keychain credentials still resolved. Every `/model` confirmation — including the ones that "saved as your default" — landed in that throwaway `settings.json` (`model: opus[1m]`, `modelSettings.claude-opus-5.effortLevel: high` were observed there); the host's `~/.claude/settings.json` was byte-for-byte unchanged, checked by mtime and content after the probe. `kill-server` afterwards. |
| Command | `tmux -L cm2361 capture-pane -t '=probe:' -p -e -S -0 -E -` |
| Launch | `claude --permission-mode default` in an empty `git init` directory; the folder-trust dialog was answered `Yes, I trust this folder` |

Two renderers were captured. The host's `settings.json` has `tui: fullscreen`,
so that is the production shape on the machine these were taken on
(alternate screen, `alternate_on=1`, transcript painted from the top of the
1000-row canvas, composer at the bottom). The `inline-*` rows had the key
removed (`alternate_on=0`, ordinary scrolling). The confirmation line and the
banner rewrite are the same in both.

**Two frames are trimmed** (`*-scrolled.txt`): each was 1000 rows of the
2.1.263 release notes (`/release-notes` → `Show all`, 387 versions), 130–440 KB
with SGR. What is committed is the **last 300 rows** (60 for the inline one,
whose SGR is denser); every byte inside is the original capture's, and the rows
that matter — the confirmation line, the composer, and hundreds of prose rows
about `/model` — are all in the tail.

## The files

| file | state | what the reader must answer |
|------|-------|-----------------------------|
| `fullscreen-boot-fable.txt` | fresh launch, `Fable 5.1 with xhigh effort · API Usage Billing` on the banner | `Fable 5.1` / `xhigh` — the banner, as before this Issue |
| `fullscreen-picker-open.txt` | `/model` picker open over that banner (5 numbered rows, `◉ xHigh effort ←/→ to adjust`, `Enter to set as default · s to use this session only · Esc to cancel`) | unchanged: `Fable 5.1` / `xhigh` |
| `fullscreen-switch-sonnet-session-only.txt` | ↓ to `4. Sonnet`, **`s`** — `⎿  Set model to Sonnet 5 for this session only`; banner rewritten to `Sonnet 5 with xhigh effort` | `Sonnet 5` / `xhigh` — the rewritten banner, which wins while on screen |
| `fullscreen-switch-opus-default-effort-high.txt` | ↑↑ to `2. Opus (1M context)`, ← once on the effort row, **Enter** — `⎿  Set model to Opus 5 (1M context) and saved as your default for new sessions with high effort`; banner rewritten to match | `Opus 5 (1M context)` / `high` — banner and line agree |
| `fullscreen-switch-haiku-arg.txt` | `/model haiku` — `⎿  Set model to Haiku 4.5 and saved as your default for new sessions`; banner rewritten to `Haiku 4.5 · API Usage Billing` (**no effort clause**) | `Haiku 4.5` / null — the banner reader has nothing to read, the line is the source |
| `fullscreen-same-model-haiku-arg.txt` | `/model haiku` a second time: the identical line again, not `Kept model as` | `Haiku 4.5` / null |
| `fullscreen-picker-escaped-kept.txt` | `/model`, **Esc** — `⎿  Kept model as Haiku 4.5` | `Haiku 4.5` / null |
| `fullscreen-fast-on.txt` | `/fast`, Tab, Enter — `⎿  ↯ Fast mode ON · model set to Opus 5 · $10/$50 per Mtok`; banner rewritten to `Opus 5 (1M context) with high effort`. **The lowest `/model` line on this pane is `Kept model as Haiku 4.5`** | `Opus 5 (1M context)` / `high` — the banner; "lowest row wins" would answer the stale `Haiku 4.5` |
| `fullscreen-fast-off.txt` | `/fast`, Tab, Enter again — `⎿  Fast mode OFF`; the banner still reads `Opus 5 (1M context) with low effort` (the model does NOT revert) | `Opus 5 (1M context)` / `low` — the banner |
| `fullscreen-after-clear.txt` | `/clear` on a session switched to Haiku: only the rewritten banner `Haiku 4.5 · API Usage Billing` and the composer remain | unknown — honest null, the latch keeps `Haiku 4.5` |
| `fullscreen-effort-low.txt` | `/effort low` — `⎿  Set effort level to low (saved as your default for new sessions): …`; banner rewritten to `Fable 5.1 with low effort` | `Fable 5.1` / `low` — the banner, over the older switch line below it |
| `inline-switch-sonnet-arg.txt` | inline renderer, `/model sonnet` — same line, same rewrite | `Sonnet 5` / `xhigh` |
| `inline-switch-haiku-banner-scrolled.txt` | inline renderer, banner in scrollback (history 1940 rows), `/model haiku` — last 60 rows | `Haiku 4.5` / null |
| `fullscreen-switch-sonnet-banner-scrolled.txt` | **the Issue**: the release notes pushed the banner off the canvas, then `/model sonnet` — last 300 rows, the confirmation on row 995 of the original | `Sonnet 5` / null |
| `fullscreen-switch-line-scrolled.txt` | the release notes printed once more, so the confirmation line is gone as well — last 300 rows, 27 of which mention a model | unknown |

## What the probe measured, and why the reader looks the way it does

The Issue's starting point was the sentence quoted in `selection-shape.ts`
(`Set model to Sonnet 5 and saved as your default for new sessions`) and an
explicit instruction to re-measure it first, because #2358's premises had
both failed on the pane. Both of this Issue's did too:

- **The banner is rewritten in place on every switch**, fullscreen and inline
  alike: `Fable 5.1 with xhigh effort` became `Sonnet 5 with xhigh effort` on
  the same row, `history_size` unchanged. `/effort` and `/fast` rewrite it as
  well. So the existing banner reader already follows a switch *while the
  banner is on screen*; the gap is the long session, where the banner is gone
  and the confirmation line is the only statement left. **The banner
  therefore wins while it is readable, and the lowest confirmation line is
  the fallback.** The Issue asked for "whichever is lower" on the premise that
  the banner is static; `fullscreen-fast-on.txt` is the measured
  counter-example — its lowest `/model` line is `Kept model as Haiku 4.5`,
  printed before the `/fast` that moved the session to Opus and rewrote the
  banner above it.
- **The scope suffix comes before the effort**: `… and saved as your default
  for new sessions with high effort`. Three suffix forms in total —
  `and saved as your default for new sessions`, `for this session only`, and
  `Kept model as <model>` for Esc — plus the `/fast` line.
- **Haiku's banner has no effort clause**, so `CLAUDE_STARTUP_BANNER_PATTERN`
  (which anchors on `with … effort`) does not read it. Deliberately not
  widened — without that anchor a box-framed table row containing ` · ` would
  read as a banner — the confirmation line covers the switch, and a fresh
  Haiku launch keeps the hook's `SessionStart` as its source.
- **The hook channel is silent on a switch.** With every documented hook event
  registered in the isolated `settings.json` and logged: `/model sonnet` fired
  nothing; `/clear` fired `SessionEnd(reason: clear)` + `SessionStart(source:
  clear)` **without a `model` key**; `SessionStart(source: startup)` carried
  `model: claude-haiku-4-5-20251001` / `claude-sonnet-5` (the full id form, not
  the `opus[1m]` alias `settings.json` holds). This is why
  `agent-event-state` now lets a frame that starts naming a different model
  AFTER the hook last spoke overtake the hook for claude — before #2361 the
  merged value was the stale hook id and the three receivers never fired.
- **2.1.263 does emit `PreModelSwitch` / `PostModelSwitch`**, with
  `from_model` / `to_model` / `requested_model` / `source` (`command`, and
  `picker` / `sdk` / `auto` / `resume` per the binary's schema). Measured:
  `/model fable` → `to_model: claude-fable-5-1`, `/fast` → `to_model:
  claude-opus-5[1m]`. CommandMate registers neither event, and its Claude
  source reads only a `model` key, so wiring them is a separate Issue; the
  frame reader here is what the Issue asked for and works without them.
- **The `/fast` line is measured and deliberately not read.** It spells the
  model `Opus 5` where the banner and `Kept model as` spell it `Opus 5 (1M
  context)`; #2357 compares one channel exactly, so reading it would announce
  a spurious change the next time the fuller spelling appeared. While the
  banner is on screen the rewrite covers `/fast`; once it is gone the switch is
  missed until the next `/model` line — `PostModelSwitch` is the right fix.

## Not here

- **No confirmation on the host.** Everything that "saved as your default"
  wrote to the throwaway `CLAUDE_CONFIG_DIR`. The trap Issue #1495 and the
  `chat-dialog-card-2254` README record — a number key on this picker commits
  AND writes the global default — is exactly why the probe was isolated that
  way rather than by noting the value and restoring it.
- **No fallback switches.** The binary carries `Switched to <model> due to
  high demand for <model>` / `… because <model> is not available` /
  `… for this session · <model> requires usage credits`, printed on an
  automatic downgrade. None could be provoked live, so none is read.
- **No `Model set to …` toast.** The picker hotkey path shows a 3-second
  feedback toast with that wording (`tengu_model_picker_hotkey`), not a
  transcript row; it rewrites the banner like every other path.
