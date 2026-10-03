# Claude Code folder-trust dialog (Issue #3078)

- `allowlist-default-no-2-1-287.txt` — Claude Code 2.1.287, first start in a repository whose
  `.claude/settings.json` pre-approves 36 tool permissions (2026-10-02, reporter's pane, ANSI stripped).
  The cursor starts on `No, exit`, so a bare Enter quits Claude Code.
- `down-swallowed-cursor-still-no-2-1-287.txt` — the same dialog on the poll right after `Down` was sent
  to a TUI that was not taking keys yet (Issue #3089, slow Linux container): the cursor is still on
  `No, exit`, so Enter must not follow until a later screen shows it on `Yes, I trust this folder`.

The default-Yes layout (` ❯ 1. Yes, I trust this folder` / `   2. No, exit`) is the Issue #201
shape used by `tests/unit/lib/claude-session.test.ts`; the unnumbered default-No layout without an
allow-list is `tests/fixtures/chat-dialog-card-2254/claude-trust-2-1-259.txt`.
