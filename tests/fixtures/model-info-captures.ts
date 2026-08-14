/**
 * Real TUI captures used by the model / reasoning-effort extractor (Issue #1784).
 *
 * Taken on 2026-08-15 from throwaway sessions on an isolated tmux socket
 * (`tmux -L cm1784probe`) at a production-shaped pane geometry (200x60) — the
 * default 80-column geometry does not reproduce the right-aligned Antigravity
 * status bar at all. Nothing here was hand-written; regenerate from a fresh
 * capture if a CLI's chrome changes rather than editing the strings.
 *
 * Versions captured: codex-cli 0.147.0 / claude 2.1.232 / agy 1.1.13.
 *
 * The `*_ANSI` constants are the same frames captured with `capture-pane -e`.
 * They exist because the SGR sequences land **inside** the values — the Codex
 * footer really arrives as `ESC[38;2;…m gpt-5.6-sol xhigh ESC[2m ESC[39m · …` —
 * so any matcher that forgets to strip ANSI first matches nothing on a real
 * machine while passing every plain-text test.
 */

/**
 * codex-cli 0.147.0, idle at the composer.
 *
 * The status bar is the bottom-most line:
 *   "  gpt-5.6-sol xhigh · ~/share/work/github_kewton/MyCodeBranchDesk"
 *
 * The splash box above it repeats the same pair as
 * "model:     gpt-5.6-sol xhigh   /model to change" — deliberately kept in the
 * fixture: it has no trailing path, so it must NOT be mistaken for the footer.
 */
export const CODEX_FOOTER_CAPTURE_V0_147 = "╭────────────────────────────────────────────────────────╮\n│ >_ OpenAI Codex (v0.147.0)                             │\n│                                                        │\n│ model:     gpt-5.6-sol xhigh   /model to change        │\n│ directory: ~/share/work/github_kewton/MyCodeBranchDesk │\n╰────────────────────────────────────────────────────────╯\n\n  Tip: Try the Desktop app. Run 'codex app' or visit https://chatgpt.com/codex?app-landing-page=true\n\n\n› Use /skills to list available skills\n\n  gpt-5.6-sol xhigh · ~/share/work/github_kewton/MyCodeBranchDesk";

/**
 * The same codex frame with its escape sequences intact (`capture-pane -e`).
 */
export const CODEX_FOOTER_CAPTURE_V0_147_ANSI = "\u001b[2m╭────────────────────────────────────────────────────────╮\u001b[0m\n\u001b[2m│ >_ \u001b[0;1mOpenAI Codex\u001b[0;2m (v0.147.0)                             │\u001b[0m\n\u001b[2m│                                                        │\u001b[0m\n\u001b[2m│ model:     \u001b[0mgpt-5.6-sol xhigh\u001b[2m   \u001b[0m\u001b[38;5;6m/model\u001b[2m\u001b[39m to change        │\u001b[0m\n\u001b[2m│ directory: \u001b[0m~/share/work/github_kewton/MyCodeBranchDesk\u001b[2m │\u001b[0m\n\u001b[2m╰────────────────────────────────────────────────────────╯\u001b[0m\n\n  \u001b[1mTip:\u001b[0m Try the \u001b[1mDesktop app\u001b[0m. Run 'codex app' or visit https://chatgpt.com/codex?app-landing-page=true\n\n\n\u001b[1m›\u001b[0m \u001b[2mUse /skills to list available skills\u001b[0m\n\n  \u001b[38;2;246;226;183mgpt-5.6-sol xhigh\u001b[2m\u001b[39m · \u001b[0m\u001b[38;2;171;223;167m~/share/work/github_kewton/MyCodeBranchDesk\u001b[39m";

/**
 * claude 2.1.232 at session start.
 *
 * The banner is the third line:
 *   "▝▜█████▛▘  Opus 5 (1M context) with xhigh effort · Claude Max"
 *
 * The long run of blank rows between the banner and the composer is real — it is
 * why the banner scrolls out of a 2000-line history so quickly on a busy session.
 */
export const CLAUDE_STARTUP_BANNER_CAPTURE_V2_1_232 = "\n ▐▛███▜▌   Claude Code v2.1.232\n▝▜█████▛▘  Opus 5 (1M context) with xhigh effort · Claude Max\n  ▘▘ ▝▝    ~/share/work/github_kewton/MyCodeBranchDesk\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n                                                                                                      tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on' to ~/.tmux.conf for wheel scroll\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n❯ Try \"create a util logging.py that...\"\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  ⏸ manual mode on · ? for shortcuts · ← for agents                                                                                                                                         /rc · focus";

/**
 * agy 1.1.13, idle after one turn.
 *
 * Status bar: "? for shortcuts  …  Gemini 3.7 Flash · hig"
 * Banner:     "    ▀▀▀▀▀▀▀▀      Gemini 3.7 Flash (High)"
 *
 * Note the "hig". agy renders this right-aligned bar one column short of the pane
 * width, so the final glyph of the effort is always missing — reproduced at both
 * 200 and 120 columns, so it is the renderer and not the capture.
 */
export const ANTIGRAVITY_IDLE_CAPTURE_V1_1_13 = "\n      ▄▀▀▄        Antigravity CLI 1.1.13\n     ▀▀▀▀▀▀       dev@example.com                (Google AI Pro)\n    ▀▀▀▀▀▀▀▀      Gemini 3.7 Flash (High)\n   ▄▀▀    ▀▀▄     ~/share/work/github_kewton/MyCodeBranchDesk\n  ▄▀▀      ▀▀▄\n\n────────────────────────────────────────────────────────────\n> hi\n\n  Hello! How can I help you today with CommandMate or your coding tasks?\n\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n>\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n? for shortcuts                                                                                                                                                                  Gemini 3.7 Flash · hig";

/**
 * agy 1.1.13 mid-turn. Same bar, different left-hand hint ("esc to cancel"),
 * same truncated model/effort on the right.
 */
export const ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13 = "\n      ▄▀▀▄        Antigravity CLI 1.1.13\n     ▀▀▀▀▀▀       dev@example.com                (Google AI Pro)\n    ▀▀▀▀▀▀▀▀      Gemini 3.7 Flash (High)\n   ▄▀▀    ▀▀▄     ~/share/work/github_kewton/MyCodeBranchDesk\n  ▄▀▀      ▀▀▄\n\n────────────────────────────────────────────────────────────\n> hi\n⢿  Generating...\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n>\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\nesc to cancel                                                                                                                                                                    Gemini 3.7 Flash · hig";

/**
 * The same agy frame with its escape sequences intact (`capture-pane -e`).
 */
export const ANTIGRAVITY_IDLE_CAPTURE_V1_1_13_ANSI = "\n      \u001b[38;5;179m▄\u001b[38;5;208m\u001b[48;5;208m▀\u001b[38;5;203m\u001b[48;5;209m▀\u001b[49m▄\u001b[39m        \u001b[1m\u001b[94mAntigravity CLI 1.1.13\u001b[0m\n     \u001b[38;5;149m\u001b[48;5;113m▀\u001b[38;5;143m\u001b[48;5;107m▀\u001b[38;5;173m\u001b[48;5;173m▀\u001b[38;5;209m\u001b[48;5;209m▀\u001b[38;5;203m\u001b[48;5;167m▀▀\u001b[39m\u001b[49m       \u001b[90mdev@example.com                (Google AI Pro)\u001b[39m\n    \u001b[38;5;107m\u001b[48;5;113m▀\u001b[38;5;71m\u001b[48;5;72m▀\u001b[38;5;72m\u001b[48;5;68m▀\u001b[38;5;67m\u001b[49m▀\u001b[38;5;103m▀\u001b[38;5;98m\u001b[48;5;68m▀\u001b[38;5;97m\u001b[48;5;62m▀\u001b[38;5;132m\u001b[48;5;97m▀\u001b[39m\u001b[49m      \u001b[90mGemini 3.7 Flash (High)\u001b[39m\n   \u001b[38;5;78m▄\u001b[48;5;74m▀\u001b[38;5;73m▀\u001b[39m\u001b[49m    \u001b[38;5;68m\u001b[48;5;69m▀▀\u001b[49m▄\u001b[39m     \u001b[90m~/share/work/github_kewton/MyCodeBranchDesk\u001b[39m\n  \u001b[38;5;75m▄\u001b[38;5;79m\u001b[48;5;75m▀\u001b[38;5;75m\u001b[49m▀\u001b[39m      \u001b[38;5;69m▀\u001b[48;5;69m▀\u001b[49m▄\u001b[39m\n\n\u001b[90m────────────────────────────────────────────────────────────\u001b[39m\n\u001b[1m\u001b[34m> hi\u001b[0m\n\n  Hello! How can I help you today with CommandMate or your coding tasks?\n\n\u001b[90m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n\u001b[94m>\u001b[39m\n\u001b[90m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n? for shortcuts\u001b[39m                                                                                                                                                                  \u001b[2mGemini 3.7 Flash · hig\u001b[0m";

