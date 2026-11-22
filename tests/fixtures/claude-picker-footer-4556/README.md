# claude-picker-footer-4556

Issue #4556. Raw tmux captures (ANSI kept, 200 cols x 60 rows) of the pickers whose
footer changed in Claude Code 2.1.329.

- Conditions: claude 2.1.330, private tmux socket (`tmux -L <name>`), an empty
  `CLAUDE_CONFIG_DIR` under `$TMPDIR` (onboarding flag only, `settings.json` = `{}`),
  not logged in, 2026-11-22. No commit key was pressed; each picker was closed with Esc.
- Anonymised: the working directory in the banner was replaced with `/private/tmp/cmprobe/work`.
  Nothing else was edited.
- `claude-2.1.330-effort.raw.txt`: `/effort` slider —
  `←/→ to adjust · s to use this session only · Enter to save · Esc to cancel`
- `claude-2.1.330-model.raw.txt`: `/model` picker of the same session —
  `s to use this session only · Enter to save · Esc to cancel`

The 2.1.286 spellings of the same two screens are in `../claude-effort-picker-3052/`.
