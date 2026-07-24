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

# Generation anchor.
# The reliable "still generating" signal is the token counter (`↓ 1.4k tokens`)
# or a background-agent wait line — NOT the `isGenerating` field (it is only true
# for the narrow thinking_indicator status) and NOT `[0-9]+m [0-9]+s`, which also
# matches the *completion* summary line `✻ Brewed for 8m 55s` and would pin a
# finished session as "generating" forever.
# `↓` is emitted literally by JSON.stringify (no \u escaping), so a raw grep over
# the --json file matches inside content/realtimeSnippet without JSON decoding.
ml_has_gen_anchor() {
  grep -aqE '↓ [0-9]|Waiting for [0-9]+ background agent' "$1"
}

# Rate-limit / credits banners observed in Claude/Codex TUIs. On a hit the
# recipe is to send "a" immediately (do not sleep) to resume.
ml_has_rate_limit() {
  grep -aqiE 'usage limit reached|rate.?limit|rate_limit_error|429 too many requests|context credits' "$1"
}

# Selection/approval prompt markers, including AskUserQuestion's
# "❯ 1. Submit answers", which the product prompt detector does NOT flag as
# isPromptWaiting — so a text-marker check is required to avoid mistaking a
# blocked question for idle.
ml_has_prompt_marker() {
  grep -aqE '❯ [0-9]+\.|Do you want to (proceed|make this edit)' "$1"
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
