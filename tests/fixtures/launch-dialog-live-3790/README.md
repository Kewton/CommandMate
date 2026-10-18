# Startup confirmations on live panes (Issue #3790)

Recorded on 2026-10-18 with `tmux -L <private socket> capture-pane -p` (no ANSI), each CLI started
under `env -i` with a private HOME and private `XDG_*` directories, in an empty folder, at 120 x 50
(gemini) or 200 x 50 (claude). The temp folder's path is replaced with `/tmp/cm3790-live`; nothing
reads it.

- `gemini-trust-dialog-0-64-0.txt` — gemini 0.64.0, the folder-trust question with the cursor on
  `● 1. Trust folder (gm1)`. Same rows as v0.62.0 (`tests/fixtures/gemini-live-3776/`).
- `gemini-after-digit-1-100ms-0-64-0.txt` — the same pane 100 ms after a bare `1` (what the Auto-Yes
  poller types before its Enter): the digit alone confirmed `Trust folder` (`trustedFolders.json`
  reads `TRUST_FOLDER`) and gemini drew `Gemini CLI is restarting to apply the trust changes...`
  under the answered dialog.
- `gemini-after-digit-1-2s-0-64-0.txt` — 2 s after that `1`: the restarted gemini's authentication
  picker, unanswered. With the poller's Enter 100 ms after the `1` (4 private HOMEs), the Enter was
  lost in the restart every time and the picker stayed unanswered; an Enter sent 3 s after the `1`
  confirmed `Sign in with Google`.
- `claude-trust-2-1-302.txt` — Claude Code 2.1.302 (Bedrock mode with dummy keys, to get past the
  login screen): the folder-trust dialog, unnumbered, cursor on `No, exit` by default. The Auto-Yes
  poller reads it as no prompt.

copilot 1.0.91 drew the same folder-trust rows as `tests/fixtures/copilot-folder-trust-1080.ts`; a bare
`1` dismissed it at once, and a second `1` + Enter typed afterwards was submitted as a user message
(`✗ You must be logged in to send messages` on that logged-out HOME).
