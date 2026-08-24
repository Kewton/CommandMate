/**
 * Claude Code's own detection patterns (Issue #1927).
 *
 * The regexes shared with other tools stay in `cli-patterns.ts`; what lives here
 * is what Issue #1927 had to measure to give Claude a §4 D1 idle rule, plus the
 * provenance of that measurement.
 *
 * ## Why Claude needed a new rule at all
 *
 * The design policy's first draft said Claude already had a completion marker
 * (`⏺` plus the composer). It does not: `⏺` is one of `CLAUDE_SPINNER_CHARS`,
 * i.e. a RUNNING signal, and the composer `❯` is drawn throughout a turn. So the
 * pre-#1927 route to `ready` was the generic `promptPattern` matching a composer
 * row that is on screen during generation too — the "absence of a negative"
 * §4 D1 forbids and #1885 reported for copilot.
 *
 * ## What was measured (claude-cli 2.1.240, 200x1000 pane, 2026-08-23)
 *
 * The bottom status row is NOT the answer here, unlike copilot's. Measured
 * across all four permission modes, idle and generating:
 *
 * | mode         | idle                                              | generating                                                       |
 * |--------------|---------------------------------------------------|------------------------------------------------------------------|
 * | manual       | `⏸ manual mode on · ? for shortcuts · ⇥ for agents` | `⏸ manual mode on · esc to interrupt · ⇥ for agents`             |
 * | auto         | `⏵⏵ auto mode on (shift+tab to cycle) · ⇥ for agents` | `⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ⇥ for agents` |
 * | plan         | `⏸ plan mode on (shift+tab to cycle) · ⇥ for agents` | —                                                                |
 * | accept edits | `⏵⏵ accept edits on (shift+tab to cycle) · ⇥ for agents` | —                                                            |
 *
 * In auto mode the row is byte-identical either side of `esc to interrupt`, so
 * an idle allowlist built from it would vouch for a generating frame. The row
 * discriminates in exactly one direction — `esc to interrupt` means busy — which
 * is `CLAUDE_INTERRUPT_HINT_PATTERN`'s job and not an idle rule.
 *
 * The transcript IS the answer. Every completed turn measured ends with a
 * duration-bearing marker as the last transcript row:
 *
 *   `✻ Brewed for 14s`   `✻ Baked for 20s`   `✻ Sautéed for 4s`
 *   `✻ Cooked for 8s · 5 messages hidden (/focus to show)`
 *
 * while a running turn ends with response prose, a tool result, or the
 * present-participle form of the same row — `✻ Manifesting… (3s · thinking with
 * xhigh effort)`, `· Enchanting… (5s · …)` — which carries no `for <duration>`.
 * The duration is what makes it evidence rather than decoration, the same
 * argument #1893 used to make opencode's `▣ … · 2.3s` duration mandatory.
 */

/**
 * Claude's turn-completion marker: a spinner glyph, a verb, and a duration.
 *
 * The glyph rotates through `CLAUDE_SPINNER_CHARS` while a turn runs and settles
 * on `✻` when it ends, so the glyph is NOT the discriminator and the whole set
 * is accepted here. The discriminator is `for <duration>` in the past tense:
 * the in-flight row is `<Verb>… (Ns · …)`, whose ellipsis and parenthetical the
 * pattern cannot match.
 *
 * `\d+m\s*` covers the minute form of a long turn. No `/g` (keeps `.test()`
 * stateless) and no nested quantifiers (ReDoS-safe).
 */
export const CLAUDE_TURN_COMPLETE_PATTERN =
  /^\s*[✻✽✶✢✳⦿◉●·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S+\s+for\s+(?:\d+m\s*)?\d+(?:\.\d+)?s(?:\s|$|\s*·)/;

/**
 * Claude's startup banner — the top edge of a session that has not run a turn.
 *
 * `╭─── Claude Code v2.1.240 ───…╮`. Paired with
 * {@link CLAUDE_TRANSCRIPT_USER_TURN_PATTERN} below it, this is the positive
 * form of §4 D1 決定 1 item 4 ("未開始"): the banner says the frame still shows
 * the start of the session, and the absence of a user turn UNDER a visible start
 * is a statement about the whole session rather than about what scrolled off.
 */
export const CLAUDE_BANNER_PATTERN = /^\s*╭─+\s*Claude Code v/;

/**
 * A user turn in the transcript: `❯ <text>` outside the composer box.
 *
 * Claude echoes every submitted message this way. Callers must exclude the
 * composer rows before scanning, since the composer wears the same glyph — see
 * `findClaudeInputBox`.
 */
export const CLAUDE_TRANSCRIPT_USER_TURN_PATTERN = /^\s*[>❯]\s+\S/;

/**
 * The right-aligned model/effort chip Claude draws directly above its input box.
 *
 * `◍ xhigh · /effort` / `● high · /effort`. It is chrome, not transcript, so the
 * walk that looks for the transcript tail has to step over it — without this the
 * tail of every frame that shows the chip is the chip itself and no completion
 * marker is ever reached. Anchored on the trailing `· /effort` because the glyph
 * varies with the reasoning level.
 */
export const CLAUDE_EFFORT_CHIP_PATTERN = /·\s*\/effort\s*$/;

/**
 * Which build these rules were read off.
 *
 * The value itself lives in `../verified-against` so §4 D2's staleness probe can
 * read every tool's stamp as data (Issue #1929); it is re-exported here so a
 * reader of these patterns still finds it next to them.
 */
export { CLAUDE_VERIFIED_AGAINST as VERIFIED_AGAINST } from '../verified-against';
