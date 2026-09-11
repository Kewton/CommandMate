# Long-body send fixtures (Issue #2464)

Live captures and probe bodies behind `docs/design/2464-long-body-repro-matrix.md`
and `tests/unit/cli-tools/submit-verified-sender-long-body-2464.test.ts`.

## How they were taken (2026-09-11)

- tmux 3.5a, a private server (`tmux -L cm2464probe …`), sessions created at the
  production geometry 200x1000 (`TUI_PANE_WIDTH` x `TUI_PANE_HEIGHT`).
- claude 2.1.268, codex-cli 0.154.0, Command Code 1.53.0 (launched with
  `--trust --skip-onboarding --no-auto-update`), Antigravity CLI (`agy`) 1.2.0.
- Each `*.capture` is `capture-pane -p -e -S -12` — the capture the sender's
  read-back takes — with ANSI attributes intact.

### Crop and redaction

The committed frames keep the **last 40 drawn rows and every blank row under
them**. The blank rows are the point for codex / Command Code / agy: those TUIs
draw from the top of the 1000-row pane (last drawn row 306 / 297 / 286 of 1,002),
so the last twelve rows of the capture are padding — the reason the read-back
never found their composer before #2464. Rows above the 40 are earlier probe
turns and were dropped. The scratch sandbox path is rewritten to
`/tmp/probe/sb-<tool>`, the home directory to `/Users/user`, the account e-mail
to `user@example.com` and the claude session URL to `session_REDACTED`; nothing
else is changed.

The extensions are `.capture` / `.body` rather than `.txt` on purpose:
`tests/unit/lib/chat/dialog-frame-2326.test.ts` sweeps every `.txt` under
`tests/fixtures/` and pins the exact set its reader crops.

## Files

| File | What it shows |
|------|---------------|
| `claude-tail-only-after-send-keys.capture` | The defect. `send-keys -l` of `P12knl.body` (12,288 bytes / 60 lines) into an idle claude; the composer holds `key xray yankee zulu al.` — the body's last 24 bytes (`12288 mod 1022`) — and Enter submitted exactly that. Captured with `-S -200`; the composer rows are the same. |
| `claude-pasted-60-lines.capture` | `P12knl.body` pasted with `paste-buffer -p -r`: `[Pasted text #86 +59 lines]` (claude counts newlines). |
| `claude-pasted-30-lines.capture` | `P4knl.body` pasted: `[Pasted text #N +29 lines]`. Used as "still pasting" for the 60-line body. |
| `claude-pasted-one-line.capture` | `P12kflat.body` pasted: `[Pasted text #N]` — no count for a single line. |
| `claude-idle.capture` | Idle composer with a dim ghost suggestion. |
| `codex-pasted-content.capture` | `P12knl.body` pasted: `[Pasted Content 12288 chars]`. |
| `codex-idle.capture` | Idle composer, `Ask Codex to do anything`. |
| `antigravity-pasted-60-lines.capture` | `P12knl.body` pasted: `[Pasted text #5 +60 lines]` (agy counts lines). |
| `antigravity-pasted-chars.capture` | `P12kflat.body` pasted: `[Pasted text #6 12288 chars]`. |
| `antigravity-idle.capture` | Idle composer, a bare `>`. |
| `command-code-pasted-60L.capture` | `P12knl.body` pasted: `[PROBE P12k… +60L]` (first ten characters, line count). |
| `command-code-idle.capture` | Idle composer, `Ask your question...`. |
| `P12knl.body` / `P12kflat.body` / `P4knl.body` | The probe bodies. Every line carries a unique `L<nn>` marker so a truncated arrival shows where it starts. |
| `matrix.json` | The measured matrix: per tool, path (`send-keys` = before #2464, `paste` = after) and body, the bytes sent and the bytes the tool's own transcript recorded. `ptyReadBytes` is the pty read size the claude losses fit exactly. |
