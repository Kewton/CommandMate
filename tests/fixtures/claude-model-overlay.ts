/**
 * Real capture of Claude Code v2.1.218's `/model` local-settings overlay.
 *
 * Captured via tmux (120x40) from an actual `claude` v2.1.218 session for
 * Issue #1495. The ❯-marked numbered model list ("1. Default … 5. Haiku") under
 * the "Select model" header is what detectMultipleChoicePrompt() previously
 * mis-detected as a real multiple_choice prompt, causing Auto-Yes to Enter-confirm
 * a selection and silently change the user's default model.
 *
 * The decisive, overlay-unique footer is:
 *   "Enter to set as default · s to use this session only · Esc to cancel"
 *
 * Do not hand-edit — regenerate from a fresh capture if the Claude TUI changes.
 */
export const CLAUDE_MODEL_OVERLAY_V2_1_218 = `
╭─── Claude Code v2.1.218 ─────────────────────────────────────────────────────────────────────────────────────────────╮
│                                                    │ Tips for getting started                                        │
│                 Welcome back Kota!                 │ Ask Claude to create a new app or clone a repository            │
│                                                    │ ─────────────────────────────────────────────────────────────── │
│                       ▐▛███▜▌                      │ What's new                                                      │
│                      ▝▜█████▛▘                     │ Changed \`/code-review\` to run as a background subagent, so rev… │
│                        ▘▘ ▝▝                       │ Added screen-reader announcements of deleted text for word and… │
│   Opus 4.8 (1M context) with xh… · Claude Max ·    │ Fixed Windows paths with \`\\u\`-prefixed segments (like \`C:\\User… │
│   newtons.boiled.clock@gmail.com's Organization    │ /release-notes for more                                         │
│        /…/scratchpad/model-capture-workdir         │                                                                 │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯












▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,
   specify with --model.

   ❯ 1. Default (recommended) ✔  Opus 4.8 with 1M context · Best for everyday, complex tasks
     2. Opus                     Opus 4.8 with 1M context · Best for everyday, complex tasks
     3. Fable                    Fable 5 · Most capable for your hardest and longest-running tasks
     4. Sonnet                   Sonnet 5 · Efficient for routine tasks
     5. Haiku                    Haiku 4.5 · Fastest for quick answers

   ◉ xHigh effort ←/→ to adjust

   Use /fast to turn on Fast mode (Opus 4.8).

   Enter to set as default · s to use this session only · Esc to cancel
`;
