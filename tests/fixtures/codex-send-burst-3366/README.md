# `codex-send-burst-3366` — an Enter pressed inside codex's paste burst

Live frames of codex-cli 0.160.0 at the production geometry (200x1000), taken
with `capture-pane -e` on a private tmux socket while the Issue's body
`Run the shell command 'sleep 15 && ls', then reply with the single word WORD<n>.`
was sent. Read by
`tests/unit/cli-tools/submit-verified-sender-codex-burst-3366.test.ts`.

codex holds fast keystrokes back as a "paste burst" and draws them in one go
when the burst ends (measured: 34 characters ~180 ms, 80 ~380 ms, 135 ~630 ms,
539 ~2.2 s after `send-keys`). An Enter that arrives before that is inserted as
a newline under the body. Nothing to do with completion popups: no popup is
open in any frame.

| File | When | What it shows |
|---|---|---|
| `typed-in-burst.capture` | 100 ms after `send-keys` | the dim idle placeholder `Ask Codex to do anything` — the body is held in the burst. (Sometimes the first keystrokes are drawn as `› Run` before codex decides the rest is a burst.) |
| `verify-after-enter-in-burst.capture` | 200 ms after an Enter pressed at 100 ms | still the placeholder. The pre-#3366 read-back took this for "the message left the composer" and the send said `Message sent.` |
| `stuck-after-enter-in-burst.capture` | 1.5 s later | the body drawn, with the Enter as an empty composer row under it — unsent |
| `body-landed.capture` | before Enter, once the body is drawn | the body in the composer (real, not dim, text) |
| `submitted-working.capture` | Enter pressed on `body-landed` | `Working (… esc to interrupt)`, composer back to the placeholder |

Whole panes on purpose: codex renders inline, so most of a capture is padding.
