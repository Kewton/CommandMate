# agent-health-picker-3053 — the pickers `screen-picker` opens

Used by `tests/unit/lib/agent-health/screen-picker-3053.test.ts` and
`tests/unit/scripts/agent-health/picker-3053.test.ts` (Issue #3053).

Captured on 2026-10-02 with `tmux capture-pane -p -e` in a private tmux server
(200x1000 pane, the probe's geometry), each picker opened from an empty
composer and closed with Esc. The work-dir path in the banner was replaced
with `/private/tmp/cm-agent-health-probe/<tool>`.

| File | What | Version |
|---|---|---|
| `claude-model.txt` | `/model` (`claude --model haiku --permission-mode manual`) | claude 2.1.286 |
| `claude-effort.txt` | `/effort`, the slider with `Faster` / `Smarter` (#3052: not read as a picker) | claude 2.1.286 |
| `codex-model.txt` | `/model`, first stage (`Select Model and Effort`) | codex-cli 0.159.3 |
