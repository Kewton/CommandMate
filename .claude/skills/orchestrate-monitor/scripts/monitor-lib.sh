#!/usr/bin/env bash
# orchestrate-monitor — shared helper functions.
#
# bash 3.2 compatible on purpose (macOS ships /bin/bash 3.2.57):
#   - no associative arrays (`declare -A`)
#   - no `mapfile` / `readarray`
#   - no `${var,,}` case conversion
# Cross-poll state is passed as arguments or held in temp files by callers,
# never in an associative array.
#
# Learned-from (see SKILL.md § "根拠"):
#   feedback_monitor_bash32_no_assoc_arrays, feedback_orchestrate_monitor_recipe,
#   feedback_orchestrate_monitor_started_guard, feedback_sed_grep_guard_false_pass.

# Extract a top-level scalar from a pretty-printed (2-space indent) JSON file.
# capture --json emits `JSON.stringify(payload, null, 2)`, so top-level keys are
# indented by exactly two spaces; anchoring on that avoids colliding with the
# nested keys inside `autoYes`/`promptData`.
# Usage: ml_json_scalar <file> <key>  ->  prints the value, quotes/comma stripped.
ml_json_scalar() {
  ml__file=$1
  ml__key=$2
  sed -n "s/^  \"${ml__key}\"[[:space:]]*:[[:space:]]*\(.*\)/\1/p" "$ml__file" \
    | head -1 \
    | sed 's/[[:space:]]*$//; s/,$//; s/^"//; s/"$//'
}

# Extract a nested OBJECT belonging to a top-level key, lines included.
# The same two-space anchor as ml_json_scalar makes the range unambiguous: the
# object opens on `  "<key>": {` and closes on the next line that starts with two
# spaces and a brace, which no deeper level can produce (options entries close at
# six spaces, their array at four). A key whose value is `null` — which is what
# `promptData` is on most frames — yields nothing, and every caller below treats
# "nothing" as "no evidence" rather than as a permissive default (skills #59,
# ported in Issue #2904).
# Usage: ml_json_block <file> <key>
ml_json_block() {
  sed -n "/^  \"${2}\"[[:space:]]*:[[:space:]]*{/,/^  }/p" "$1"
}

# --- text normalization -------------------------------------------------------
# Every text anchor below matches against normalized text, never against the raw
# JSON. Issue #1522: `↓ [0-9]` was grepped straight out of the --json file and so
# NEVER fired in production — the live TUI writes the arrow, then a colour reset,
# then the count:
#   'Sublimating… \u001b[38;5;246m(4m 25s · ↓\u001b[39m \u001b[38;5;246m14.9k tokens'
# so no digit follows "↓ ". The fixtures shipped with the first version of this
# skill were hand-written with the ANSI already stripped, which is why the unit
# tests were green while every real worker was classified IDLE. The fixtures are
# now raw captures (ANSI intact) and normalization happens here instead.
#
# Two normalizations, both from observed live payloads:
#   1. CSI sequences, in the JSON-escaped form (`\u001b[38;5;246m`, which is what
#      JSON.stringify emits) and in the raw-ESC form (a capture piped as text).
#   2. The non-breaking space the TUI puts between a marker and its payload
#      (`❯\xa0`, `⎿ \xa0Tip:` — both present in the real captures). Left alone it
#      defeats `❯ [0-9]+\.` for exactly the same reason ANSI defeated `↓ [0-9]`.
# LC_ALL=C keeps sed byte-oriented: a pane capture can carry a half-written
# multibyte glyph, and BSD sed aborts with "illegal byte sequence" on those in a
# UTF-8 locale.
ML__SED_CSI_ESCAPED='s/\\u001[bB]\[[0-9;]*[a-zA-Z]//g'
ML__SED_CSI_RAW=$'s/\033\\[[0-9;]*[a-zA-Z]//g'
ML__SED_NBSP_ESCAPED='s/\\u00[aA]0/ /g'
ML__SED_NBSP_RAW=$'s/\xc2\xa0/ /g'

# ml_strip_ansi [file]: normalize <file>, or stdin when called with no argument.
ml_strip_ansi() {
  if [ $# -gt 0 ]; then
    LC_ALL=C sed -e "$ML__SED_CSI_ESCAPED" -e "$ML__SED_CSI_RAW" \
                 -e "$ML__SED_NBSP_ESCAPED" -e "$ML__SED_NBSP_RAW" "$1"
  else
    LC_ALL=C sed -e "$ML__SED_CSI_ESCAPED" -e "$ML__SED_CSI_RAW" \
                 -e "$ML__SED_NBSP_ESCAPED" -e "$ML__SED_NBSP_RAW"
  fi
}

# ml_pane_text <file>: the normalized text of what is ON SCREEN NOW, i.e. the
# `realtimeSnippet` field (`lines.slice(-100)` in
# src/lib/session/current-output-builder.ts).
#
# Scoping matters: `content` is the *delta since lastCapturedLine*, so the first
# poll of a monitor loop returns the whole buffer — including the task text the
# orchestrator sent the worker. Issue #1522 (5th defect) was exactly this: the
# task text contained the identifier `ml_has_rate_limit`, the old bare
# `rate.?limit` anchor matched it, and the loop fired `tmux send-keys a Enter` at
# two healthy generating workers on its very first iteration. One queued the `a`,
# the other had it delivered into the conversation.
# The same scoping protects the *live* anchors from the mirror-image failure: a
# spinner line (`↓ 14.9k tokens`, `esc to interrupt`) that scrolled into history
# would otherwise pin a finished session as GENERATING forever.
# Falls back to the whole file when realtimeSnippet is absent (e.g. the
# session_not_running payload, which carries no pane at all).
ml_pane_text() {
  ml__snippet=$(ml_json_scalar "$1" realtimeSnippet)
  if [ -n "$ml__snippet" ] && [ "$ml__snippet" != "null" ]; then
    printf '%s\n' "$ml__snippet" | ml_strip_ansi
  else
    ml_strip_ansi "$1"
  fi
}

# Generation anchor. Three signals, all "the product is mid-turn right now":
#   - the token counter `↓ 14.9k tokens`
#   - a background-agent wait line
#   - the footer hint `esc to interrupt`, which the TUI shows ONLY while a turn is
#     running (it reads `? for shortcuts` when idle). This is what catches a
#     worker that is still thinking before its first token — `✳ Cascading… (19s)`
#     carries no counter, and such workers were being reported as idle.
# Deliberately NOT used:
#   - the `isGenerating` field: true only for the narrow thinking_indicator
#     status, so it is false during real generation.
#   - `[0-9]+m [0-9]+s`: also matches the *completion* summary `✻ Brewed for
#     8m 55s` and would pin a finished session as generating forever.
ml_has_gen_anchor() {
  ml_pane_text "$1" | grep -aqiE '↓ ?[0-9]|Waiting for [0-9]+ background agent|esc to interrupt'
}

# The idle footer hint. Its presence is positive proof the turn is over, which is
# how a retry line left on screen is told apart from a retry in progress.
ml_has_idle_footer() {
  ml_pane_text "$1" | grep -aqiE '\? for shortcuts'
}

# ml_is_retrying <file>: the CLI is inside its OWN transient-error backoff
# (`✻ 529 Overloaded · Retrying in 4s · attempt 7/10`). The session has not
# stopped, so an intervention is queued rather than applied — observed live: the
# `a` sent during a backoff sat in the composer as `❯ a` with `Press up to edit
# queued messages`, then got delivered after the retry succeeded and pushed the
# worker into contract-violating work.
# The idle-footer veto is load-bearing: the `attempt 10/10` line stays on screen
# after the retries are exhausted, and without it a dead session would read as
# alive forever and never reach the resend path.
ml_is_retrying() {
  ml_pane_text "$1" | grep -aqiE 'retrying in [0-9]+s|attempt [0-9]+/[0-9]+' || return 1
  ! ml_has_idle_footer "$1"
}

# ml_has_terminal_api_error <file>: the CLI gave up (retries exhausted / hard API
# error) and dropped back to a prompt. Nothing resumes on its own from here, so
# monitor.sh resends. Kept to the current pane and gated by the caller on
# IDLE + idle-threshold + a resend budget, because `api error` is broad enough to
# appear in a worker's own output.
ml_has_terminal_api_error() {
  ml_pane_text "$1" | grep -aqiE 'api error|retry limit reached|maximum retries'
}

# Rate-limit / credits banners observed in Claude/Codex TUIs. On a hit the recipe
# is to send "a" immediately (do not sleep) to resume.
# Only product banner wording is listed. A bare `rate.?limit` alternative used to
# be here and it matched any prose or source code containing `rate_limit` /
# `rate-limit`, injecting an `a` into healthy workers (Issue #1522, 5th defect) —
# the same "matched a sentence that was merely describing the thing" failure that
# ml_count_violations already guards against. `rate_limit_error` is kept because
# it is the literal error `type` the 429 banner prints; the residual risk that a
# worker displays that identifier is covered by classify-state.sh evaluating
# RATE_LIMIT only after generation has been ruled out.
ml_has_rate_limit() {
  ml_pane_text "$1" | grep -aqiE 'usage limit reached|rate_limit_error|429 too many requests|1M context credits|upgrade to increase your usage limit'
}

# Selection/approval prompt markers, including AskUserQuestion's
# "❯ 1. Submit answers", which the product prompt detector does NOT flag as
# isPromptWaiting — so a text-marker check is required to avoid mistaking a
# blocked question for idle.
ml_has_prompt_marker() {
  ml_pane_text "$1" | grep -aqE '❯ [0-9]+\.|Do you want to (proceed|make this edit)'
}

# --- Antigravity (agy) screen markers ------------------------------------------
# Issue #2606. Every anchor above is Claude's wording, and none of it is on an
# agy screen: agy says `esc to cancel` and draws a braille spinner while it
# generates, stops drawing `? for shortcuts` after a tool turn (#2478), and asks
# `Run this command?` / `Allow creation of this file?` above `> 1. Yes …` and an
# `↑/↓ Navigate` footer. In the #2595 pilot all 59 polls of an agy worker came
# out `IDLE started=0`. The functions below are agy's own markers; they sit next
# to the Claude ones instead of replacing them, and classify-state.sh picks the
# set from the payload's `cliToolId` (the same field #1601 derives the
# intervention target from).
#
# The markers are read off the rows of agy's frame, measured on the live
# captures in tests/fixtures/antigravity-live-2364/ (agy 1.1.27),
# antigravity-live-2478/ (1.2.1) and agent-mode-2592/ (1.2.4), plus
# ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13 in tests/fixtures/model-info-captures.ts
# (the one generating capture in the repository). The rules mirror the product's
# own reading of the same screens (src/lib/detection/cli-patterns.ts,
# src/lib/cli-tools/antigravity.ts) without importing it.
#
# Where the frame comes from matters as much as the markers. agy renders inline
# in a 200x1000 pane and is top-anchored: until the transcript fills the pane,
# its rows sit at the TOP and everything below is blank padding. realtimeSnippet
# is the last 100 raw rows (current-output-builder.ts), so on such a pane it is
# nothing but blank rows — no marker can be found there, whatever it looks for.
# `content` is a suffix of the same capture (the rows from the poller's cursor
# on), so the longer of the two is the one that reaches further up, and both end
# at the same bottom row. The frame is that text with the blank padding dropped
# and cut to its last ML_AGY_FRAME_ROWS rows — "the bottom of what agy drew",
# which is where its live UI (status row, input box, dialog) always is.
# ANSI and the nbsp are normalized as for the Claude path; the JSON string
# escapes are undone too, because these rules read ROWS, while the Claude
# anchors are substring matches over the still-escaped one-line value.

# Rows kept from the bottom of the frame: the tallest dialog block the product
# reads (ANTIGRAVITY_DIALOG_MAX_ROWS = 60), plus the footer and status rows.
ML_AGY_FRAME_ROWS=64
# How far up a spinner / retry line may sit: the product's 15-row detection
# window (STATUS_CHECK_LINE_COUNT, src/lib/detection/tools/frame.ts).
ML_AGY_TAIL_ROWS=15

ML__SOH=$(printf '\001')
ML__NL='
'

# ml__json_unescape: turn a JSON string body (read from stdin) back into rows.
# `\\` is parked on a placeholder first so a literal backslash followed by `n`
# in the pane text does not become a line break.
ml__json_unescape() {
  LC_ALL=C sed \
    -e "s/\\\\\\\\/${ML__SOH}/g" \
    -e "s/\\\\n/\\${ML__NL}/g" \
    -e $'s/\\\\t/\t/g' \
    -e 's/\\r//g' \
    -e 's/\\"/"/g' \
    -e "s/${ML__SOH}/\\\\/g"
}

# ml_agy_frame <file>: agy's frame as rows (see above), trailing blank rows
# dropped, at most ML_AGY_FRAME_ROWS of them.
ml_agy_frame() {
  ml__snip=$(ml_json_scalar "$1" realtimeSnippet)
  ml__cont=$(ml_json_scalar "$1" content)
  [ "$ml__snip" = "null" ] && ml__snip=""
  [ "$ml__cont" = "null" ] && ml__cont=""
  if [ ${#ml__cont} -gt ${#ml__snip} ]; then
    ml__src=$ml__cont
  else
    ml__src=$ml__snip
  fi
  printf '%s\n' "$ml__src" | ml_strip_ansi | ml__json_unescape \
    | LC_ALL=C awk -v keep="$ML_AGY_FRAME_ROWS" '
        { row[NR] = $0; if ($0 ~ /[^ \t]/) last = NR }
        END {
          first = last - keep + 1
          if (first < 1) first = 1
          for (i = first; i <= last; i++) print row[i]
        }'
}

# ml__agy_signals <file>: one pass over the frame, printing a token per marker
# that holds: `footer`, `dialog`, `busy`, `box`, `idle`, `retry`.
# Plain awk on purpose (macOS awk, mawk and gawk alike, all byte-oriented under
# LC_ALL=C): no interval expressions, no POSIX classes, and every non-ASCII
# glyph is matched as a literal string with index(), never inside a bracket.
ml__agy_signals() {
  ml_agy_frame "$1" | LC_ALL=C awk \
    -v tail_rows="$ML_AGY_TAIL_ROWS" \
    -v RULE='─' -v UPDOWN='↑/↓' -v BULLET='●' -v ELBOW='⎿' -v TRI='▸' \
    -v BR0=$'\xe2\xa0' -v BR1=$'\xe2\xa1' -v BR2=$'\xe2\xa2' -v BR3=$'\xe2\xa3' '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function starts(s, p) { return index(s, p) == 1 }
    # A horizontal rule: the turn separator, the input-box border, the line
    # under a dialog header. Nothing but `─` (at least three).
    function is_rule(s,   t, k) {
      t = s
      k = gsub(RULE, "", t)
      return k >= 3 && t == ""
    }
    # The braille spinner (U+2800-U+28FF = E2 A0..A3 xx) opening a row.
    function is_spinner(s) {
      return starts(s, BR0) || starts(s, BR1) || starts(s, BR2) || starts(s, BR3)
    }
    # The input box row when it is empty: a bare `>`, or the permission-mode
    # banner that replaces it (ANTIGRAVITY_PROMPT_PATTERN, #2592).
    function is_prompt_row(s) {
      return s == ">" || s ~ /^>[ \t]+[A-Z][A-Za-z-]*[ \t]mode:.*\(shift\+tab to cycle\)$/
    }
    # `↑/↓ Navigate`, the footer under every arrow-key screen agy owns
    # (ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN). Not anchored to the row start: the
    # /model picker prefixes it with `Keyboard:`.
    function has_footer(s,   p, rest) {
      p = index(s, UPDOWN)
      if (p == 0) return 0
      rest = substr(s, p + length(UPDOWN))
      sub(/^[ \t]+/, "", rest)
      return starts(rest, "Navigate")
    }
    # A row that ends the dialog block when reading upward from the footer
    # (ANTIGRAVITY_DIALOG_BOUNDARY_PATTERN): a rule, a tool / result / thought
    # row, or a `>` row that is not a numbered option (the echoed prompt, the
    # composer, the highlighted row of an unnumbered picker).
    function is_boundary(s) {
      if (is_rule(s)) return 1
      if (starts(s, BULLET) || starts(s, ELBOW) || starts(s, TRI)) return 1
      return starts(s, ">") && s !~ /^>[ \t]*[0-9]+\.[ \t]+[^ \t]/
    }
    function is_numbered(s) { return s ~ /^>?[ \t]*[0-9]+\.[ \t]+[^ \t]/ }
    function skip_blank(i) {
      while (i >= 1 && row[i] == "") i--
      return i
    }
    { row[NR] = trim($0) }
    END {
      n = NR

      # A selection screen is up: its footer is on one of the bottom three rows
      # (the status row, and on /model a blank row, sit under it). Kept to the
      # bottom so a `↑/↓ Navigate` quoted in the transcript — task text, the
      # the summary a worker writes — is never read as a screen.
      footer = 0
      for (i = n; i >= 1 && i > n - 3; i--) {
        if (has_footer(row[i])) { footer = i; break }
      }

      # A numbered dialog: at least two `N. label` rows between the footer and
      # the nearest boundary above it, and not the Switch Model picker
      # (isAntigravityNumberedDialog). The trust screen, /model and the
      # slash-command popup draw unnumbered rows and stay out.
      dialog = 0
      if (footer) {
        numbered = 0
        picker = 0
        floor = footer - 60
        if (floor < 1) floor = 1
        for (i = footer - 1; i >= floor; i--) {
          if (is_boundary(row[i])) break
          if (row[i] == "Switch Model") picker = 1
          if (is_numbered(row[i])) numbered++
        }
        dialog = (numbered >= 2 && !picker)
      }

      # Generating: `esc to cancel` opening the status row, or the spinner row
      # above the input box. `Generating` alone is NOT used — agy leaves thought
      # summaries such as "Generating the specified file" in the transcript of a
      # finished turn (idle-after-deny.txt).
      busy = 0
      for (i = n; i >= 1 && i > n - 3; i--) {
        if (starts(row[i], "esc to cancel")) busy = 1
      }
      for (i = n; i >= 1 && i > n - tail_rows; i--) {
        if (is_spinner(row[i])) busy = 1
      }

      # The input box at the bottom of the frame: rule / `>` (blank rows
      # allowed under it, agy 1.2.1 leaves the box three rows tall) / rule /
      # status row. Mirrors readInputBoxStatusRow (src/lib/cli-tools/antigravity.ts).
      # The status row is optional and may hold nothing but the model label —
      # the #2478 frame — which is why the footer text is not required.
      box = 0
      status = ""
      i = n
      if (i >= 1 && !is_rule(row[i])) { status = row[i]; i = skip_blank(i - 1) }
      if (i >= 1 && is_rule(row[i])) {
        i = skip_blank(i - 1)
        if (i >= 1 && is_prompt_row(row[i])) {
          i = skip_blank(i - 1)
          if (i >= 1 && is_rule(row[i])) box = 1
        }
      }
      # The box is drawn while agy generates too, so it means idle only
      # together with the absence of the busy markers. `? for shortcuts` on the
      # status row settles it on its own, as in isAntigravityReady.
      idle = box && (status ~ /^\?[ \t]+for[ \t]+shortcuts/ || !busy)

      # Backoff wording in the live rows. It is the wording of the Claude
      # anchor, because no agy backoff screen has been captured.
      retry = 0
      for (i = n; i >= 1 && i > n - tail_rows; i--) {
        line = tolower(row[i])
        if (line ~ /retrying in [0-9]+s/ || line ~ /attempt [0-9]+\/[0-9]+/) retry = 1
      }

      if (footer) print "footer"
      if (dialog) print "dialog"
      if (busy) print "busy"
      if (box) print "box"
      if (idle) print "idle"
      if (retry) print "retry"
    }'
}

ml__agy_has() {
  ml__agy_signals "$1" | grep -qx "$2"
}

# ml_agy_has_dialog_footer <file>: an agy selection screen is open (a
# permission dialog, the trust screen, /model, the slash-command popup).
ml_agy_has_dialog_footer() {
  ml__agy_has "$1" footer
}

# ml_agy_has_prompt_marker <file>: an agy numbered dialog is waiting for an
# answer — `↑/↓ Navigate` plus numbered options (`> 1. Yes`, `2. No, deny
# creation`). The unnumbered screens are left to the server's
# isPromptWaiting / sessionStatus, exactly as before.
ml_agy_has_prompt_marker() {
  ml__agy_has "$1" dialog
}

# ml_agy_has_gen_anchor <file>: agy is mid-turn (`esc to cancel` status row or
# the spinner). Every agy selection screen ALSO prints `esc to cancel` on its
# status row (dialog-create-file.txt, popup-slash-commands.txt), so the dialog
# footer is evaluated first and vetoes the reading — an open dialog is a
# prompt, never generation.
ml_agy_has_gen_anchor() {
  ml__agy_signals "$1" | awk '
    $0 == "footer" { footer = 1 }
    $0 == "busy" { busy = 1 }
    END { exit !(busy && !footer) }'
}

# ml_agy_has_idle_box <file>: agy's empty input box is at the bottom of the
# frame and agy is not generating. agy's counterpart of ml_has_idle_footer: the
# footer text cannot be used because agy 1.2.1+ stops drawing it after a tool
# turn (#2478), so the box itself is read.
ml_agy_has_idle_box() {
  ml__agy_has "$1" idle
}

# ml_agy_is_retrying <file>: ml_is_retrying for an agy pane. Same wording, read
# on the live rows only, and vetoed by the idle box (agy's proof that the turn
# is over) and by an open dialog, so a stale retry line can neither pin a
# finished worker as alive nor hide a dialog behind GENERATING.
ml_agy_is_retrying() {
  ml__agy_signals "$1" | awk '
    $0 == "retry" { retry = 1 }
    $0 == "idle" { idle = 1 }
    $0 == "footer" { footer = 1 }
    END { exit !(retry && !idle && !footer) }'
}

# --- Command Code screen markers ------------------------------------------------
# Issue #4245. Command Code draws the same words the Claude markers read (the
# status row `esc to interrupt • 0s • ↓ 0`, the `? for shortcuts` footer, dialogs
# as `❯ 1. Yes`), measured on tests/fixtures/command-code-live-2250/. What it
# does not share is WHERE they are: it renders inline in a 200x1000 pane and is
# top-anchored, so until the transcript fills the pane `realtimeSnippet` (the last
# 100 raw rows) is blank padding and the Claude path read every frame as IDLE
# (all 15 live frames, measured). The fix is the window, as for agy (#2606): the
# bottom ML_CC_FRAME_ROWS non-blank rows of the longer of content / realtimeSnippet.
# The anchors themselves are the Claude ones, applied to that frame. Frames with
# no measured capture (a retry backoff, a rate-limit banner) get no new marker.
ML_CC_FRAME_ROWS=30

# ml_cc_frame <file>: the bottom of what Command Code drew, as rows.
ml_cc_frame() {
  ml__snip=$(ml_json_scalar "$1" realtimeSnippet)
  ml__cont=$(ml_json_scalar "$1" content)
  [ "$ml__snip" = "null" ] && ml__snip=""
  [ "$ml__cont" = "null" ] && ml__cont=""
  if [ ${#ml__cont} -gt ${#ml__snip} ]; then
    ml__src=$ml__cont
  else
    ml__src=$ml__snip
  fi
  printf '%s\n' "$ml__src" | ml_strip_ansi | ml__json_unescape \
    | LC_ALL=C awk -v keep="$ML_CC_FRAME_ROWS" '
        { row[NR] = $0; if ($0 ~ /[^ \t]/) last = NR }
        END {
          first = last - keep + 1
          if (first < 1) first = 1
          for (i = first; i <= last; i++) print row[i]
        }'
}

ml_cc_has_gen_anchor() {
  ml_cc_frame "$1" | grep -aqiE '↓ ?[0-9]|Waiting for [0-9]+ background agent|esc to interrupt'
}

ml_cc_has_prompt_marker() {
  ml_cc_frame "$1" | grep -aqE '❯ [0-9]+\.|Do you want to (proceed|make this edit)'
}

ml_cc_is_retrying() {
  ml_cc_frame "$1" | grep -aqiE 'retrying in [0-9]+s|attempt [0-9]+/[0-9]+' || return 1
  ! ml_cc_frame "$1" | grep -aqiE '\? for shortcuts'
}

# --- prompt approval policy (skills #59, ported in Issue #2904) ---------------
# Enter is not a neutral "unblock". Two facts, both measured, decide whether it
# may be typed at all:
#
#   1. It goes into the pane directly, so it overrides whatever the SERVER
#      decided. When a contract declares `autoYes.mode: off` or `denyPatterns`,
#      CommandMate withholds the answer on purpose (#1547) and publishes that it
#      did — `autoYes.lastSuppression` (#1684). Typing Enter there re-approves
#      exactly what the contract author asked to escalate.
#   2. On a multiple_choice prompt Enter confirms the DEFAULT option (#1681),
#      not "yes". That is only an approval when the default IS an approval.
#
# Measured against live `capture --json` frames (2026-08-05, CommandMate 0.21.2,
# 6 worktrees, 30 frames carrying promptData; see commandmate-skills PR #77):
#   - promptData.type was `multiple_choice` on 30/30 frames. Claude Code's plain
#     permission prompt is multiple_choice too, so "hold every multiple_choice"
#     would hold 100% of real approvals — it is not a usable discriminator.
#   - options[].isDefault existed on every frame and exactly one option carried
#     it; its label was "Yes" (number 1) on 34/34 options.
#   - the dangerous shape is visible in the SAME field: the AskUserQuestion-style
#     picker recorded for prompt db9f9d48 (`capture --prompts --json`) carries
#     three prose options and NO isDefault at all, so Enter there confirms
#     whatever the cursor happens to sit on.
#   - autoYes.lastSuppression was present on every frame (null throughout, since
#     no contract policy withheld anything during the window).
#
# Hence the rule is a positive test, not a deny-list: Enter is sent only when the
# poll shows a binary approval whose default is affirmative. Anything else — a
# policy suppression, no promptData, no default option, a non-affirmative default
# — is held and reported. Holding stalls a worker; approving the wrong option
# cannot be undone.

# ml_autoyes_suppressed <file>: the contract's autoYes policy withheld an answer
# for this session. Absent on CommandMate older than #1684, where it reads as
# "not suppressed" — the pre-Issue-#2904 behaviour, which is why the caller must
# still document that a contract-backed dispatch is not this loop's job.
ml_autoyes_suppressed() {
  ml_json_block "$1" autoYes | grep -qE '^    "lastSuppression"[[:space:]]*:[[:space:]]*\{'
}

# ml_autoyes_suppression_reason <file>: `mode-off` / `deny-pattern` /
# `deny-pattern-unusable` / `type-not-allowed` (AutoYesSuppressionReason,
# src/lib/polling/auto-yes-resolver.ts), for the operator-facing line.
ml_autoyes_suppression_reason() {
  ml_json_block "$1" autoYes \
    | sed -n 's/^      "reason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -1
}

# ml_prompt_type <file>: promptData.type, empty when the frame carries no
# promptData (which is the case whenever PROMPT came from ml_has_prompt_marker
# rather than from the product's own detector).
ml_prompt_type() {
  ml_json_block "$1" promptData \
    | sed -n 's/^    "type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -1
}

# ml_prompt_default_label <file>: the label Enter would confirm, empty when the
# frame states no default.
# JSON.stringify emits an option object in declaration order (number, label,
# isDefault, requiresTextInput — MultipleChoiceOption, src/types/models.ts), so
# the label of the default option is the last one seen before `"isDefault": true`.
# A label can hold arbitrary command text but never a line that STARTS with
# `"isDefault"`, because every JSON member is on its own line and newlines inside
# a string are escaped.
# yes_no prompts carry plain-string options instead; their optional
# `defaultOption` is read as the label.
ml_prompt_default_label() {
  ml__block=$(ml_json_block "$1" promptData)
  ml__labelline=$(printf '%s\n' "$ml__block" | awk '
    /^[[:space:]]*"label"[[:space:]]*:/ { ml_lab = $0 }
    /^[[:space:]]*"isDefault"[[:space:]]*:[[:space:]]*true/ { print ml_lab; exit }
  ')
  if [ -n "$ml__labelline" ]; then
    printf '%s\n' "$ml__labelline" \
      | sed 's/^[[:space:]]*"label"[[:space:]]*:[[:space:]]*"//; s/",*[[:space:]]*$//'
    return 0
  fi
  printf '%s\n' "$ml__block" \
    | sed -n 's/^    "defaultOption"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -1
}

# ml_is_affirmative <text>: the option label reads as an approval rather than as
# a choice. Anchored at the start and followed by a non-alphanumeric or the end,
# so "Yes" and "Yes, and don't ask again for: …" pass while "No" and a prose
# answer do not. LC_ALL=C keeps grep byte-oriented for the same reason
# ml_strip_ansi does: a label carries whatever the worker printed.
ml_is_affirmative() {
  printf '%s' "${1:-}" | LC_ALL=C grep -aqiE '^(y|yes|allow|approve|proceed|accept|ok)([^a-zA-Z0-9]|$)'
}

# ml_prompt_enter_verdict <file> -> approve | hold:<why>
#   hold:policy          the server withheld the answer under the contract policy
#   hold:no-prompt-data  the frame carries no promptData; what Enter selects is unknown
#   hold:type            a prompt type this rule has never been measured against
#   hold:no-default      no option is marked default; Enter confirms the cursor
#   hold:choice          the default option is not an approval
ml_prompt_enter_verdict() {
  if ml_autoyes_suppressed "$1"; then
    printf 'hold:policy\n'
    return 0
  fi
  ml__ptype=$(ml_prompt_type "$1")
  if [ -z "$ml__ptype" ]; then
    printf 'hold:no-prompt-data\n'
    return 0
  fi
  case "$ml__ptype" in
    yes_no|multiple_choice) ;;
    *) printf 'hold:type\n'; return 0 ;;
  esac
  ml__label=$(ml_prompt_default_label "$1")
  if [ -z "$ml__label" ]; then
    # A yes_no prompt states no default because there is nothing to choose: the
    # product's own resolver answers it "yes" (resolveBaseAnswer), and `mode:
    # safe` is defined as "yes_no only". A multiple_choice without a default is
    # the picker shape, where Enter confirms the cursor position.
    if [ "$ml__ptype" = "yes_no" ]; then
      printf 'approve\n'
    else
      printf 'hold:no-default\n'
    fi
    return 0
  fi
  if ml_is_affirmative "$ml__label"; then
    printf 'approve\n'
  else
    printf 'hold:choice\n'
  fi
}

# ml_prompt_signature <file> <verdict>: identity of the held prompt, so a prompt
# that stays on screen for twenty polls is reported (and counted) once rather
# than twenty times. Derived from the promptData block, which is stable while the
# prompt is up and different for the next one; the verdict is mixed in so a
# changed reason re-reports.
ml_prompt_signature() {
  { printf '%s\n' "${2:-}"; ml_json_block "$1" promptData; } | cksum | awk '{print $1}'
}

# --- the return line (Issue #4532) ---------------------------------------------
# Until #4532 a worker ended a turn with a bare `IMPL_COMPLETED`, and the
# orchestrator waited on that line. Two failures came from it: a permission prompt
# or an ordinary `DONE:` turn looked like nothing at all, and `IMPL_COMPLETED`
# itself is easy to mistake a stale line for. The goal now asks for a return line
# as the turn's LAST line:
#
#   DONE: #<N> <sha> verify exit <n>   /   WAIT: <reason>   /   STOP: <reason>
#
# and `IMPL_COMPLETED` is a shape-OUTSIDE ending: named and reported, never
# accepted as completion.
#
# Anchored at the start of a line on purpose: the goal text itself names all three
# shapes (`手番の最後の行は \`DONE: …\`・\`WAIT: <理由>\`・\`STOP: <理由>\` …`) and scrolls
# into the pane, so a substring match would read the instructions as an ending.
# A return line is a whole line that STARTS with the shape.
#
# ml_pane_rows <capture-json-file>: the rows of the longer of content /
# realtimeSnippet, JSON-unescaped. NOT what the loop judges an ending on (#4532
# review P1-A): one of the two `--json` fields is still a window — codex's split
# canvas (#3946) puts the composer in the snippet and nothing in content once
# the reply was saved, so the DONE above the blank gap is in neither. monitor.sh
# reads `capture --pane` on every poll and scans that with ml_return_line_text.
# ml_return_line below is kept for callers that hold only a `--json` frame.
ml_pane_rows() {
  ml__rows_snip=$(ml_json_scalar "$1" realtimeSnippet)
  ml__rows_cont=$(ml_json_scalar "$1" content)
  [ "$ml__rows_snip" = "null" ] && ml__rows_snip=""
  [ "$ml__rows_cont" = "null" ] && ml__rows_cont=""
  if [ ${#ml__rows_cont} -gt ${#ml__rows_snip} ]; then
    ml__rows_src=$ml__rows_cont
  else
    ml__rows_src=$ml__rows_snip
  fi
  printf '%s\n' "$ml__rows_src" | ml_strip_ansi | ml__json_unescape
}

# ml_return_line <capture-json-file> -> the newest ending in that pane, or `none`:
#   `DONE: …` / `WAIT: …` / `STOP: …`   the newest such line in the pane
#   `SHAPE_OUTSIDE IMPL_COMPLETED[ head=<sha>]`   the old ending
#   `none`
# The DONE line is the shape of wait-verify.mjs's DONE_LINE_RE (#4532 review
# P3-B): fields separated by `[ \t]+` (spaces or tabs, any number), leading and
# trailing blanks allowed, a sha of 7-40 hex. A 1-character token or a 41-hex
# one must not read as a DONE here while the orchestrator's own reader refuses
# it, and two spaces must not be refused here while it accepts them. The sha
# length is checked in awk code rather than as `{7,40}`: an interval expression
# is not portable across the awks this runs under (BSD awk, gawk, older mawk).
# One table of rows pins both readers to the same answers
# (monitor-pane-invariants-4532.test.ts, T3).
ML_DONE_LINE_RE='^DONE:[ \t]+#[0-9]+[ \t]+[0-9a-f]+[ \t]+verify[ \t]+exit[ \t]+[0-9]+$'
ML_DONE_SHA_MIN=7
ML_DONE_SHA_MAX=40

# --- the row normalization (#4532 S10, review r4 P1-B) -----------------------
# One definition of "the row a reader matches", for every reader that anchors at
# the head of a row: the ending scan below (DONE / WAIT / STOP / IMPL_COMPLETED)
# and, for the panel step, the pane frame the prompt markers read
# (ml_pane_as_capture). Its JS copy is wait-verify.mjs `normalizePaneLine`, and
# pane-line-agreement-4532.test.ts pins both to one table of rows (N1).
#   1. ANSI (CSI) and the non-breaking space — ml_strip_ansi, before the awk.
#   2. The right-hand panel. claude 2.1.330 draws its "N files edited (show)"
#      diff panel to the right of the transcript, so every row reads
#      `<left column><blanks>│ <panel>`, and a reader anchored at the row's end
#      missed `DONE: … exit 0      │ src/x.ts +12 -3`. The row is cut at the
#      FIRST `│` (U+2502) that follows text and two or more blanks; that `│`
#      and everything after it go. A `│` with nothing but blanks to its left is
#      kept (` │ Blocked: …` — Command Code's tool output — and codex's header
#      box start their rows that way), and so is one after a single blank (a
#      boxed quote `│ DONE: … │`), so a panel-only or a quoted `DONE:` still
#      does not sit at the head of the row (N2).
#   3. The blanks at the end (step 2 leaves the run before the `│`).
#   4. ml_pane_line only: the blanks at the start, then ONE reply marker at
#      the head and the one blank after it (review r3 P3-E, lead r1, review
#      P2-1). A CLI puts its marker on the FIRST row of a reply, so a one-line
#      reply (`<marker> DONE: …`, the live `<marker> IMPL_COMPLETED`) is the
#      ending on that row. The markers are reply-markers.tsv, next to this file,
#      and nothing else (ML_REPLY_MARKERS below; the data names each tool, the
#      platform — claude draws a different glyph on macOS and elsewhere — and
#      where each glyph was measured). Only one, and only with one blank after
#      it: the composer `❯ DONE: …` (typed, not sent), the user echo `›`, a
#      doubled marker, a marker behind `│` and `- …` stay as they are and are
#      not an ending. After the strip nothing more is trimmed, so a marker and
#      two blanks before `DONE` does not sit at the head either.
# Done with awk index()/substr() over bytes (LC_ALL=C) rather than a UTF-8
# regex, so it behaves the same under BSD awk, gawk and mawk.
#
# The data is read once, when this file is sourced. A missing or empty file is
# an ERROR on stderr, not a silent empty set: a reader with no markers would
# miss every one-line reply, the very miss the data exists to prevent.
ML_REPLY_MARKERS_FILE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/reply-markers.tsv"
ML_REPLY_MARKERS=$(LC_ALL=C awk -F '\t' '
  /^#/ || NF < 3 || $3 == "" { next }
  !seen[$3]++ { printf "%s%s", (n++ ? " " : ""), $3 }' "$ML_REPLY_MARKERS_FILE" 2>/dev/null) || ML_REPLY_MARKERS=""
if [ -z "$ML_REPLY_MARKERS" ]; then
  echo "monitor-lib: ERROR no reply markers read from $ML_REPLY_MARKERS_FILE — one-line replies are not read as endings" >&2
fi
ML_PANE_PANEL_BAR='│'
ML__PANE_ROW_AWK='
function ml_pane_row(line,   off, p, left) {
  off = 0
  while ((p = index(substr(line, off + 1), bar)) > 0) {
    left = substr(line, 1, off + p - 1)
    if (left ~ /[^ \t][ \t][ \t]+$/) { line = left; break }
    off += p + length(bar) - 1
  }
  sub(/[ \t]+$/, "", line)
  return line
}
function ml_pane_line(line,   i, m) {
  line = ml_pane_row(line)
  sub(/^[ \t]+/, "", line)
  if (!ml__marks_split) { ml__nmark = split(marks, ml__mark, " "); ml__marks_split = 1 }
  for (i = 1; i <= ml__nmark; i++) {
    m = ml__mark[i]
    if (substr(line, 1, length(m)) == m && substr(line, length(m) + 1, 1) ~ /^[ \t]$/) {
      line = substr(line, length(m) + 2)
      break
    }
  }
  return line
}'

# ml_pane_lines <pane-text-file>: every row of the file, normalized (steps 1-4).
ml_pane_lines() {
  ml_strip_ansi "$1" | LC_ALL=C awk -v bar="$ML_PANE_PANEL_BAR" -v marks="$ML_REPLY_MARKERS" "$ML__PANE_ROW_AWK"'
    { print ml_pane_line($0) }'
}

# The one scan of a list of rows. Both readers below feed it, so a raw
# `capture --json` and a `--pane` transcript name the ending the same way. Each
# row is normalized first (ml_pane_line), so the reported line carries no panel
# text either: a WAIT next to a changing panel is still the same WAIT.
ml__return_line_scan() {
  LC_ALL=C awk -v done_re="$ML_DONE_LINE_RE" -v sha_min="$ML_DONE_SHA_MIN" -v sha_max="$ML_DONE_SHA_MAX" \
    -v bar="$ML_PANE_PANEL_BAR" -v marks="$ML_REPLY_MARKERS" "$ML__PANE_ROW_AWK"'
    { line = ml_pane_line($0) }
    line ~ done_re {
      split(line, field, /[ \t]+/)
      if (length(field[3]) >= sha_min + 0 && length(field[3]) <= sha_max + 0) { out = line; found = 1 }
    }
    line ~ /^WAIT:/ { out = line; found = 1 }
    line ~ /^STOP:/ { out = line; found = 1 }
    line ~ /^IMPL_COMPLETED([ \t]+head=[0-9a-f]+)?[ \t]*$/ { out = "SHAPE_OUTSIDE " line; found = 1 }
    END { print (found ? out : "none") }
  '
}

# The frame is read with ml_pane_rows (JSON-unescaped rows, ANSI stripped).
ml_return_line() {
  ml_pane_rows "$1" | ml__return_line_scan
}

# ml_return_line_text <pane-text-file>: the same scan over a `capture --pane`
# transcript — EVERY line, with no window (#4532 review P1-1, P1-A). This is
# the reader monitor.sh judges the ending with, for every CLI: a Command Code
# pane is top-anchored (the ending sits above the last 30 non-blank rows), and
# a codex pane puts the composer at the bottom of its canvas (the ending sits
# above the last 100 rows). Each row goes through the row normalization above
# (ANSI, the right-hand panel, the blanks at both ends).
ml_return_line_text() {
  [ -f "$1" ] || { echo "none"; return 0; }
  ml_strip_ansi "$1" | ml__return_line_scan
}

# ml_pane_as_capture <pane-text-file> <cli-tool-id>: the `capture --pane`
# transcript written out as a capture frame, so classify-state.sh can put the
# SAME per-CLI prompt marker it puts on `--json` on the pane too (#4532 review
# P2-A). #4434's frame had an empty content and a blank snippet, and a dialog
# that only the pane showed was never PROMPT.
#   content          every row of the pane — the field ml_cc_frame / ml_agy_frame
#                    window from (they take the longer field and keep its bottom
#                    drawn rows), so Command Code and agy read their own window.
#   realtimeSnippet  the bottom ML_PANE_LIVE_ROWS drawn (non-blank) rows — what
#                    the Claude markers (ml_pane_text) read. Kept to the bottom
#                    on purpose: a marker word in the transcript above (the task
#                    text, an answered dialog) is not a prompt (#1522).
# No marker is added for a CLI that has none (codex): its prompt stays the
# server's isPromptWaiting. The strings are JSON-escaped (`\` `"` and the line
# break), which is all ml_json_scalar / ml__json_unescape need.
# Every row goes through steps 1-3 of the row normalization first (ANSI, the
# right-hand panel, the trailing blanks): a dialog word in claude's diff panel
# is panel text, not the dialog. The leading blanks are kept — ml_cc_frame and
# ml_agy_frame count the drawn rows as they are.
ML_PANE_LIVE_ROWS=30
ml__pane_rows_cut() {
  ml_strip_ansi "$1" | LC_ALL=C awk -v bar="$ML_PANE_PANEL_BAR" "$ML__PANE_ROW_AWK"'
    { print ml_pane_row($0) }'
}
ml_pane_as_capture() {
  ml__pac_escape='{ gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "") }'
  ml__pac_all=$(ml__pane_rows_cut "$1" | LC_ALL=C awk "$ml__pac_escape"'
    { out = (NR == 1 ? $0 : out "\\n" $0) } END { printf "%s", out }')
  ml__pac_live=$(ml__pane_rows_cut "$1" | LC_ALL=C awk -v keep="$ML_PANE_LIVE_ROWS" "$ml__pac_escape"'
    { if ($0 ~ /[^ \t]/) row[++n] = $0 }
    END {
      first = n - keep + 1
      if (first < 1) first = 1
      for (i = first; i <= n; i++) out = (i == first ? row[i] : out "\\n" row[i])
      printf "%s", out
    }')
  printf '{\n  "isRunning": true,\n  "cliToolId": "%s",\n  "content": "%s",\n  "realtimeSnippet": "%s"\n}\n' \
    "$2" "$ml__pac_all" "$ml__pac_live"
}

# ml_has_return_line <capture-json-file> <shape>: whether the newest ending is
# that shape (`DONE` / `WAIT` / `STOP` / `SHAPE_OUTSIDE`). A stale `DONE:` from an
# earlier turn is not distinguishable from this turn's on the pane alone, so the
# caller still ties it to its own task (the same reason wait-verify reads the
# reply rather than the pane when it can).
ml_has_return_line() {
  ml__line=$(ml_return_line "$1")
  case "$2" in
    DONE) case "$ml__line" in DONE:*) return 0 ;; esac ;;
    WAIT) case "$ml__line" in WAIT:*) return 0 ;; esac ;;
    STOP) case "$ml__line" in STOP:*) return 0 ;; esac ;;
    SHAPE_OUTSIDE) case "$ml__line" in SHAPE_OUTSIDE*) return 0 ;; esac ;;
  esac
  return 1
}

# --- tmux session targeting ---------------------------------------------------
# The pane an intervention is typed into is DERIVED from the capture payload, not
# guessed from a fixed prefix.
#
# Issue #1601: monitor.sh shipped with `SESSION_PREFIX="cm"`, so every
# `tmux send-keys -t cm-<worktree-id>` addressed a session that has never existed
# — `tmux ls` has no `cm-` session at all. Each call ended in `2>/dev/null || true`,
# so the miss was invisible: the loop printed "sending 'a'" before sending and
# counted approvals it had never delivered. Every intervention the skill exists to
# perform was a no-op, and the log said it had worked.
#
# A fixed prefix cannot be made right by changing its default either. The real
# name is built per CLI tool and per instance:
#   mcbd-<cliToolId>-<worktreeId>[-<instance suffix>]
# (BaseCLITool.getSessionName, src/lib/cli-tools/base.ts; the claude path in
# src/lib/session/claude-session.ts is the same shape), so a single prefix cannot
# address a fleet running claude and codex, nor a `--instance codex-2` worker.
#
# `cliToolId` is a top-level field of the capture payload (CurrentOutputPayload in
# src/lib/session/current-output-builder.ts) — the tool the SERVER resolved for
# this very poll. Deriving from it is what makes the pane we type into provably
# the pane we classified.

# The product's CLI tool ids (CLI_TOOL_IDS, src/lib/cli-tools/types.ts). A plain
# space-separated string because bash 3.2 has no arrays worth the trouble here.
# monitor-lib.test.ts cross-checks it against the TypeScript source: a drifted
# list silently stops resolving the agent of a `<worktree-id>@<instance-id>` spec,
# which puts the capture on the wrong pane — the same class of silent miss as
# #1601 itself.
ML_CLI_TOOL_IDS="claude codex gemini vibe-local opencode copilot antigravity command-code opencode-v2"

# ml_agent_from_instance <instance-id> -> the CLI tool the instance belongs to,
# empty (and exit 1) when the id matches no known tool.
# Instance ids are `<tool>` or `<tool>-<suffix>` (getPrimaryInstanceId /
# buildInstanceId, src/lib/cli-tools/types.ts), so the tool is recoverable without
# a DB lookup. Matched against the id list rather than by cutting at the first
# hyphen, because `vibe-local` contains one.
ml_agent_from_instance() {
  ml__instance=${1:-}
  ml__match=""
  [ -n "$ml__instance" ] || return 1
  for ml__tool in $ML_CLI_TOOL_IDS; do
    if [ "$ml__instance" = "$ml__tool" ]; then
      ml__match=$ml__tool
      break
    fi
    case "$ml__instance" in
      "${ml__tool}-"*)
        # Longest match wins, so an id is never attributed to a shorter tool.
        if [ ${#ml__tool} -gt ${#ml__match} ]; then
          ml__match=$ml__tool
        fi
        ;;
    esac
  done
  [ -n "$ml__match" ] || return 1
  printf '%s\n' "$ml__match"
}

# ml_session_suffix <instance-id> <cli-tool-id> -> the session-name suffix for a
# non-primary instance, empty for the primary one.
# Mirrors deriveSessionSuffix() (src/lib/cli-tools/types.ts): the leading
# `<tool>-` is stripped so `claude-2` yields `2` (the session is
# `mcbd-claude-<wt>-2`, not `mcbd-claude-<wt>-claude-2`), and an id that does not
# carry the prefix is used verbatim.
ml_session_suffix() {
  ml__instance=${1:-}
  ml__tool=${2:-}
  if [ -z "$ml__instance" ] || [ "$ml__instance" = "$ml__tool" ]; then
    return 0
  fi
  if [ -z "$ml__tool" ]; then
    printf '%s\n' "$ml__instance"
    return 0
  fi
  case "$ml__instance" in
    "${ml__tool}-"*) printf '%s\n' "${ml__instance#"${ml__tool}-"}" ;;
    *) printf '%s\n' "$ml__instance" ;;
  esac
}

# ml_session_name <worktree-id> <cli-tool-id> [<instance-id>] [<prefix-override>]
#   -> the tmux session name, or exit 1 when it cannot be derived.
# <prefix-override> is the legacy `--session-prefix` escape hatch: it replaces the
# derived `mcbd-<cliToolId>` head only. The instance suffix is still appended, so
# an override cannot silently re-point an instance at its primary's pane.
ml_session_name() {
  ml__wid=${1:-}
  ml__tool=${2:-}
  ml__instance=${3:-}
  ml__prefix=${4:-}
  [ -n "$ml__wid" ] || return 1
  if [ -n "$ml__prefix" ]; then
    ml__base="${ml__prefix}-${ml__wid}"
  elif [ -n "$ml__tool" ]; then
    ml__base="mcbd-${ml__tool}-${ml__wid}"
  else
    # No cliToolId in the payload and no override: refuse rather than invent a
    # name. The caller reports it; a wrong name is what #1601 was.
    return 1
  fi
  ml__suffix=$(ml_session_suffix "$ml__instance" "$ml__tool")
  if [ -n "$ml__suffix" ]; then
    printf '%s\n' "${ml__base}-${ml__suffix}"
  else
    printf '%s\n' "$ml__base"
  fi
}

# ml_tmux_target <session-name> -> the exact-match target specifier `=<name>:`.
# Mirrors exactTarget() (src/lib/tmux/tmux.ts, Issue #1156). A bare `-t <name>`
# falls back to prefix/fnmatch matching when nothing matches exactly, and instance
# names ARE prefixes of one another (`mcbd-claude-w1` prefixes
# `mcbd-claude-w1-2`): without `=`, an intervention aimed at a primary that is not
# running is delivered to the `-2` instance instead. The trailing `:` is required
# — `=name` alone is parsed as a pane spec by send-keys and fails.
ml_tmux_target() {
  printf '=%s:\n' "${1:-}"
}

# Count real violations of a forbidden pattern, ignoring comment lines.
# Two deliberate choices, both learned from guard false-reports:
#   1. Comment lines (`^[[:space:]]*#`) are excluded so a pattern that appears in
#      explanatory prose is not counted as a real occurrence
#      (feedback_orchestrate_monitor_started_guard: the bare-`npx commandmate`
#      grep flagged a sentence that was *describing* the rule).
#   2. Plain `grep -c` is used and its "0" on no-match is kept as-is. We never
#      write `grep -c ... || echo 0`, which appends a second "0" and yields the
#      two-line "0\n0" that breaks a later numeric test
#      (feedback_sed_grep_guard_false_pass).
ml_count_violations() {
  ml__file=$1
  ml__pat=$2
  grep -vE '^[[:space:]]*#' "$ml__file" | grep -cE "$ml__pat"
}
