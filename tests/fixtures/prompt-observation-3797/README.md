# prompt-observation-3797 — agy 1.4.2 screens for the prompt observation (Issue #3797)

Read by `tests/unit/lib/prompt-observation/antigravity-model-picker-3797.test.ts`.
The directory name does not start with a tool id for the reason
`prompt-observation-3755/README.md` gives (the dialog-gate suites walk every
`<tool>-*` directory as their corpus).

**Raw on purpose: do not strip ANSI.** Every frame is a live
`tmux capture-pane -p -e -S 0 -E 999` of a 200x1000 pane.

## Provenance

| | |
|---|---|
| Captured | 2026-10-18 |
| Agent | Antigravity CLI 1.4.2 (`agy`, `~/.local/bin/agy`), Gemini 3.8 Flash (High) |
| Pane geometry | 200x1000 (`new-session -x 200 -y 1000`, `window-size manual`, `resize-window -x 200 -y 1000`) |
| Server | a private tmux server (`tmux -L cm3797`), killed afterwards; no CommandMate server. `CM_HOOK_URL` pointed at a closed port so agy's hooks reached nothing |
| Session | `antigravity-login-method.txt`: a private `HOME` (temp dir, no credentials; `HOME`/`XDG_*` checked with `ps eww`). The others: the user's own sign-in (not copied), in an already-trusted scratch folder, so no trust screen was answered |

Redacted: the account e-mail is `agy-user@example.com`, the folder is
`~/agy3797-probe`. Every other byte is verbatim.

## The frames

| file | screen | expected reading |
|---|---|---|
| `antigravity-model-picker-1.4.2.txt` | `/model`: composer ABOVE, `Switch Model`, `Search:` box and its underline, five models with `> Gemini 3.8 Flash (current)`, `Effort` slider, `Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back` | `antigravity-model-picker`, highlight 2 — `unknown` before #3797 |
| `antigravity-model-picker-1.4.2-highlight-3.txt` | the same after one `Down` | highlight 3 |
| `antigravity-model-picker-1.4.2-highlight-1.txt` | the same after two `Up`s | highlight 1 |
| `antigravity-model-picker-1.4.2-search.txt` | `claude` typed: two models, footer `… esc Clear search` | `antigravity-model-picker`, two options |
| `antigravity-model-picker-1.4.2-no-match.txt` | `claudezzzz` typed: `No models match "claudezzzz"`, footer `Keyboard: esc Clear search` | `unknown` (nothing to choose) |
| `antigravity-slash-popup-1.4.2-one-row.txt` | `/model` typed in the composer: one popup row `> /model  Set a model, …`, `↑/↓ Navigate · enter Select · tab Complete` | not the picker (`unknown`) |
| `antigravity-login-method.txt` | not signed in: `Select login method:` over `> 1. Google OAuth` / `2. Use a Google Cloud project`, `↑/↓ Navigate · enter Select` | `unknown` — `antigravity-permission` before #3797 |
| `antigravity-idle-after-picker.txt` | after `esc` twice: `⎿  Exited /model command`, composer back | `composer` |
