# command-code usage limit (Issue #3729)

- `running-turn.txt` / `approval-turn.txt`: the evidence panes of #3718 (`screen-running`) and
  #3719 (`screen-approval`), command-code 1.81.0 on 2026-10-16, copied verbatim from the Issue bodies
  (the report's `paneEvidence`, ANSI already stripped).
- `running-turn-no-limit.txt`: `running-turn.txt` with the usage-limit and 429 rows removed — the same
  "no reply, back at the composer" fail with no limit on the screen (negative control).
