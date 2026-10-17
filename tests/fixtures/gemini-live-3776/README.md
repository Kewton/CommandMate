# gemini folder-trust frames (Issue #3776)

Captured 2026-10-17 from gemini-cli v0.62.0 on macOS, `tmux -L` private socket,
200x50 pane, launched as `env -i HOME=<mktemp -d> PATH=… TERM=xterm-256color gemini`
in an empty `mktemp -d` folder. The production `~/.gemini` was not touched.
Plain `capture-pane -p` (no ANSI).

| file | screen |
|------|--------|
| `trust-dialog.txt` | `Do you trust the files in this folder?` drawn ~2 s after launch; cursor `●` on `1. Trust folder (<folder>)` by default |
| `trust-dialog-cursor-dont-trust.txt` | the same dialog after two `Down`: cursor on `3. Don't trust` |
| `after-enter-restarting.txt` | 2 s after one Enter on `1. Trust folder`: the dismissed dialog stays above `Gemini CLI is restarting to apply the trust changes...` and the restarted banner |
| `after-enter-auth.txt` | 7 s after the Enter: the restarted gemini's `How would you like to authenticate for this project?` picker (cursor on `1. Sign in with Google`); the dismissed dialog's option rows are still at the top of the pane |

`trustedFolders.json` in the private HOME read `TRUST_FOLDER` for the folder
afterwards. The private HOME had never signed in, which is why the auth picker
follows; a signed-in HOME goes to the prompt.

Note: the launch printed `Update successful! The new version will be used on
your next run.` and restarted as v0.64.0 — gemini's auto-update ran from the
private HOME too.
