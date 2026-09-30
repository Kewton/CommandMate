# OpenCode V2 dialog frames (Issue #2971)

Captured on 2026-09-29 from the real `opencode2` **2.0.18**, launched through
`scripts/opencode-v2/launch.sh` on a private tmux socket (`tmux -L …`), pane
80x200, in a throwaway git repository. `HOME` and `XDG_CONFIG_HOME` /
`XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` pointed at a scratch
directory. ANSI was stripped, trailing blanks trimmed, and the footer's
working-directory cell shortened to `/…/tmp/probe/repo`. Nothing else was edited
(the model list shows the free models plus whatever local providers the machine
advertised).

| File | What |
|---|---|
| `select-model.txt` | `ctrl+x m` on the launch screen: `Select model … esc` / `Search` / the model list |
| `select-variant.txt` | after picking a model that has variants: `Select variant … esc` / `Search` / `Default` … `max` |
| `select-variant-typed.txt` | the same dialog after typing `Reply with exactly: UAT-MODEL-2`: the text sits in the filter row, `No results found` (the UAT F-1 shape) |
| `select-variant-over-transcript.txt` | the variant dialog opened after a finished turn (isolated CommandMate server, the pane it launched): transcript above, bare gutter composer and footer below |
| `commands.txt` | `ctrl+p`: `Commands … esc`; the palette runs over the composer rows |
| `sessions.txt` | `ctrl+x l`: `Sessions for repo … esc` |
| `select-agent.txt` | `ctrl+x a`: `Select agent … esc` |

Every one keeps the footer (`… ctrl+p commands`), which is why the footer alone
cannot say the composer is free. The title row is ~150 rows above the bottom, far
outside the 15-line status window.

Pinned by `tests/unit/detection/tools/opencode-v2/detect.test.ts` and
`tests/unit/cli-tools/opencode-v2.test.ts`.
