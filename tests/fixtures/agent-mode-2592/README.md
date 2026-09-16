# `agent-mode-2592` — permission-mode frames

Frames for `detectAgentMode()` (`src/lib/detection/agent-mode.ts`), one per mode
per declaring tool, plus frames in the state where **nothing names a mode**.
Read by `tests/unit/lib/detection/agent-mode-2592.test.ts`,
`antigravity-mode-banner-2592.test.ts`, `model-info-codex-trailer-2592.test.ts`,
and the e2e spec `tests/e2e/agent-mode-control-2592.spec.ts`.

Every file is a whole pane at the geometry it was captured at (1000/1001 rows,
200 columns). That is deliberate: Command Code and codex render inline, so most
of a capture is padding, and a reader that counts raw rows instead of content
rows never reaches the footer. A trimmed fixture would hide that.

## Why this directory was re-cut (2026-09-16, PR #2594 UAT)

The first version of this directory built the antigravity, copilot and codex
mode rows from **the Issue's prose** — the Issue recorded the spellings, not the
frames. The pre-merge UAT then ran all five tools in an isolated environment and
two of those reconstructions turned out to have the wrong SHAPE:

- **antigravity** — the fixture put `accept-edits · Gemini …` on a row of its own.
  On agy 1.2.4 it shares ONE row with `? for shortcuts`, 150 columns to its left.
  The reader only accepted `^` / `·` before the word, matched the fixture, and
  read `unknown` on every live step.
- **copilot** — the fixture appended the word at the end of the bar. 1.0.85
  puts it right after `← open sidebar`, and after the autopilot permission dialog
  is answered "Continue with limited permissions" the word is
  `autopilot (limited)`, which the reader did not accept.

**Rule for anyone editing these files:** a fixture for a mode row must come from
a live capture. If a live pane ever disagrees with a file here, fix the pattern in
`src/lib/cli-tools/agent-mode-spec.ts` (or the detector) and re-cut the file from
a new capture — never adjust the reader to match a fixture.

The live source frames are in `dev-reports/issue/2592/uat-live-frames/` (not
committed), together with the per-step cycle logs (`cycle-*.tsv`).

## Provenance

### A. Live captures (byte for byte, except one redaction)

| file | source | tool / version | shows |
|---|---|---|---|
| `antigravity-default.txt` | `uat-live-frames/antigravity-1.2.4-default-live.txt` | agy 1.2.4 | row 18 bare `>`, row 20 `? for shortcuts … Gemini 3.8 Flash · hig` |
| `antigravity-accept-edits.txt` | `…/antigravity-1.2.4-accept-edits-live.txt` | agy 1.2.4 | row 18 `> Accept-edits mode: file edits auto-approved (shift+tab to cycle)`, row 20 `? for shortcuts … accept-edits · Gemini 3.8 Flash · hi` |
| `antigravity-plan.txt` | `…/antigravity-1.2.4-plan-live.txt` | agy 1.2.4 | row 18 `> Plan mode: research & plan only (shift+tab to cycle)`, row 20 `? for shortcuts … plan · Gemini 3.8 Flash · hi` |
| `copilot-autopilot-limited.txt` | `…/copilot-1.0.85-current-live.txt` | copilot 1.0.85 | row 1000 `← open sidebar · autopilot (limited) · / commands · tab next tab … GPT-5.6 Terra` |
| `codex-plan.txt` | `…/codex-0.154.0-plan-with-thread-title-live.txt` | codex 0.154.0 | row 40 `gpt-6-astra medium · ~/… · Reply with one word … Plan mode (shift+tab to cycle)` |
| `claude-auto.txt` | `tests/fixtures/claude-live-2247/boot-banner.txt` | claude 2.1.258 | `⏵⏵ auto mode on (shift+tab to cycle) · ← for agents` |
| `command-code-default.txt` | `tests/fixtures/command-code-live-2250/boot-idle-1490.txt` | Command Code 1.49.0 | `? for shortcuts · taste on` |
| `codex-default.txt` | `tests/fixtures/codex-live-2310/idle-composer.txt` | codex 0.15x | a status bar that ends in the path, no badge |

The one redaction: the three antigravity files replace the account address on
the banner's second row (row 7) with `user@example.com`. Nothing reads that row.
The user name inside paths is left as captured, as the other live fixtures in
this repository do.

The ANSI-bearing files are the three from older live directories (`claude-auto`,
`command-code-default`, `codex-default`). The UAT captures were taken stripped,
so the re-cut files carry no SGR; the older ANSI files are what keep the
"forgot `stripAnsi`" failure covered.

### B. A live frame with ONE row replaced by a live row from the UAT cycle log

The cycle logs record the footer text of every step, whitespace collapsed. Each
file below is the live frame named in the second column with exactly one row
replaced (`diff` against the source shows a single-row change), re-padded so the
right-aligned element keeps its live column.

| file | base frame | row | replaced with (from) |
|---|---|---|---|
| `copilot-default.txt` | copilot 1.0.85 live | 1000 | ` ← open sidebar · / commands · ? help · tab next tab` (`cycle-copilot-first.tsv` step 0) |
| `copilot-plan.txt` | copilot 1.0.85 live | 1000 | ` ← open sidebar · plan · / commands · ? help · tab next tab` (step 1) |
| `copilot-autopilot.txt` | copilot 1.0.85 live | 1000 | ` ← open sidebar · autopilot · / commands · tab next tab` (step 2 — note `? help` is gone) |
| `codex-default-thread-title.txt` | codex 0.154.0 live | 40 | `gpt-6-astra xhigh · ~/… · Reply with one word`, no badge (`cycle-codex.tsv` step 2) |
| `claude-manual.txt` | `claude-live-2247/boot-banner.txt` | 1000 | row 1000 of `tests/unit/lib/tmux/fixtures/capture-claude-idle.txt`, verbatim |

The transcript above the replaced row is the base frame's, so e.g.
`codex-default-thread-title.txt` still shows `Model changed to … for Plan mode.`
as its last notice. Nothing that reads these files looks there; the footer is the
bottom-most match.

### C. A real row with one phrase substituted

| file | base row | substitution | confirmed live by |
|---|---|---|---|
| `claude-accept-edits.txt` | claude footer, row 1000 | `⏵⏵ auto mode on` → `⏵⏵ accept edits on` | #1927's table (`src/lib/detection/tools/claude/patterns.ts`); UAT `cycle-claude.tsv` passed |
| `claude-plan.txt` | claude footer, row 1000 | `⏵⏵ auto mode on` → `⏸ plan mode on` | #1927's table; `cycle-claude.tsv` step 3 prints the same row |
| `command-code-accept-edits.txt` | 1.49.0 idle frame | new row `» accept edits on [shift+tab]` above the shortcut row | `cycle-command-code.tsv` step 1 (1.54.1) shows this exact stack |
| `command-code-plan.txt` | 1.49.0 idle frame | new row `plan mode [shift+tab]` above the shortcut row | `cycle-command-code.tsv` step 2 |
| `command-code-bypass-1490.txt` | 1.49.0 idle frame | shortcut row replaced by `» permission bypass on` | #2250's `ModeIndicator` list (1.49.0 layout). Not reachable by `shift+tab`, not in the UAT cycle |
| `codex-plan-no-thread-title.txt` | codex 0.154.0 live, row 40 | `· Reply with one word` removed, badge kept at its column | not captured — stands for a session whose thread has no title yet, and is the only frame exercising the extractor's column-gap trailer |

## Not in this directory

`opencode`, `vibe-local` and `gemini` have no frames here because they declare no
mode spec (`resolveAgentModeSpec` returns `null`), and the suite pins that
negative against the real registry rather than against a fixture. See
`src/lib/cli-tools/agent-mode-spec.ts` for why each one is out.
