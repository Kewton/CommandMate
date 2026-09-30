# codex `config.toml` before/after a probe launch (Issue #3031)

Shapes measured on codex-cli 0.159.1 with a throwaway `CODEX_HOME`
(paths anonymised):

- `after-trust-dialog.toml` — answering "Trust this folder?" with
  "Trust and continue" adds a whole `[projects."<dir>"]` table, with a blank
  line in front, after the last existing `[projects…]` table.
  `-c projects.<dir>.trust_level=trusted` alone writes nothing.
- `after-nux-launch.toml` — codex also bumps `[tui.model_availability_nux]`
  by one on every launch until the count reaches 4, whoever launched it. That
  change is not the probe's own entry, so the restore must leave it alone.
