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
ML_CLI_TOOL_IDS="claude codex gemini vibe-local opencode copilot antigravity"

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
