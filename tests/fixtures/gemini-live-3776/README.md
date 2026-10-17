# gemini folder-trust frames (Issue #3776)

Captured 2026-10-17 from gemini-cli v0.62.0 on macOS, `tmux -L` private socket,
200x50 pane, launched as `env -i HOME=<mktemp -d> PATH=… TERM=xterm-256color gemini`
in an empty `mktemp -d` folder. The production `~/.gemini` was not touched.
Plain `capture-pane -p` (no ANSI).

| file | screen |
|------|--------|
| `trust-dialog.txt` | `Do you trust the files in this folder?` drawn ~2 s after launch; cursor `●` on `1. Trust folder (<folder>)` by default |
| `trust-dialog-cursor-dont-trust.txt` | the same dialog after two `Down`: cursor on `3. Don't trust` |
| `after-enter-restarting.txt` | **synthetic** (review of #3776): rows 1–36 of `trust-dialog.txt` (the dismissed dialog, cursor and all) followed by the restart line and banner rows 11–18 of `after-enter-auth.txt`. Stands for the screen ~2 s after the Enter; the earlier capture of it was a copy of `after-enter-auth.txt` by mistake |
| `after-enter-auth.txt` | 7 s after the Enter: the restarted gemini's `How would you like to authenticate for this project?` picker (cursor on `1. Sign in with Google`); the dismissed dialog's option rows are still at the top of the pane |

`trustedFolders.json` in the private HOME read `TRUST_FOLDER` for the folder
afterwards. The private HOME had never signed in, which is why the auth picker
follows; a signed-in HOME goes to the prompt.

Note: the launch printed `Update successful! The new version will be used on
your next run.` and restarted as v0.64.0 — gemini's auto-update ran from the
private HOME too.

Not measured: the older wording `Do you trust this folder?` (before v0.62.0).
`tests/unit/cli-tools/gemini-prompt-detection.test.ts` draws it over the same
three option rows as v0.62.0 — an assumption, not a capture.
