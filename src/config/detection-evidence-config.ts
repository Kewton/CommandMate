/**
 * Per-tool rollout of the D1 idle-evidence rule, and its kill switch
 * (Issue #1927, 方針書 §4 D1 決定 1 / §13.1 DR3-016).
 *
 * §4 D1 forbids declaring a turn finished on the absence of a busy marker. The
 * fix has to land **one tool at a time**: a tool whose idle rule is not yet
 * measured must keep the pre-#1927 reading, because flipping it early publishes
 * `evidence: 'none'` for ordinary idle frames (DR2-002).
 *
 * Issue #2011 is the incident this warning predicted, and it also narrowed what
 * an early flip actually costs. `TerminalEscapeHatch` and `wait`'s completion
 * rule are gated on `isUnclassifiedActive`, which #1927 had derived from
 * `evidence` — so an early flip took both of them out. #2011 gave the flag its
 * own expression again (`isUnclassifiedFrame`, in `status-evidence.ts`), so a
 * premature `enforce` now degrades only what `statusEvidence` itself feeds:
 * §7's "last confirmed status" row and the `unclassified_frames` tally that
 * measures the rollout. That is a smaller blast radius, not a licence to skip
 * the `observe` step below.
 *
 * That makes three things necessary, and all three live here:
 *
 *  - **a table**, so "which tools have a measured rule" is one list rather than
 *    a property scattered across seven modules;
 *  - **a kill switch**, so an operator who sees the rollout misfire in
 *    production can put one tool back to the old reading without a redeploy;
 *  - **an observe mode**, so the rollout can be measured BEFORE it is turned on
 *    — §11's live row makes "`unclassified_frames` の記録件数が倒す前後で有意に
 *    増えない" an acceptance condition, and you cannot check that without a run
 *    that computes the new verdict while still publishing the old one.
 */

import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * What to do with a tool's measured idle-evidence rule.
 *
 * - `enforce` — the rule decides `evidence`. This is D1 applied.
 * - `observe` — the rule runs and its verdict is counted
 *   ({@link recordIdleEvidenceObservation}), but `'positive'` is published.
 *   Behaviour is byte-identical to `legacy`; only the counters move.
 * - `legacy` — the rule is not consulted at all. The pre-#1927 reading, where
 *   any composer row was treated as positive completion evidence.
 */
export type IdleEvidenceMode = 'enforce' | 'observe' | 'legacy';

/** Every accepted value of {@link IdleEvidenceMode}, for parsing and tests. */
export const IDLE_EVIDENCE_MODES: readonly IdleEvidenceMode[] = ['enforce', 'observe', 'legacy'];

/**
 * The rollout state each tool ships in.
 *
 * `enforce` is set only for a tool whose rule was measured from its own live
 * frames at production pane geometry, with a positive fixture and a mutation
 * fixture each, AND whose `observe` run has shown that enforcing it does not
 * move the `unclassified_frames` rate (§11's live row):
 *
 * | tool     | rule                                                        | Issue |
 * |----------|-------------------------------------------------------------|-------|
 * | claude   | turn-completion marker `✻ <Verb> for <N>s` at the transcript tail, or the startup banner with no user turn under it | #1927 |
 * | copilot  | the pane's bottom status bar reads idle (`readCopilotStatusBar`) | #1885 |
 * | opencode | the gutter-anchored idle composer, or `▣ … · <duration>`     | #1883 / #1893 |
 *
 * **claude is `observe`, not `enforce` (Issue #2011).** It shipped straight to
 * `enforce` in #1927 without the measurement above, and the live rate was
 * measured afterwards instead: on 2026-08-24, 7 of 8 idle Claude panes answered
 * `'none'`. The rule is not wrong about those frames — a `/model` result row, a
 * `⎿ Tip:` row, `✔ Update installed` and `new task? /clear to save …` really do
 * carry no completion marker — it is simply not yet complete enough to be the
 * authority, because a legitimately idle Claude pane has no marker at all after
 * `/model`, after `/clear`, at startup, or after an Esc interrupt. Building the
 * rule that covers those is deliberately a separate Issue; what `observe` buys
 * meanwhile is the tally that says when it is done.
 *
 * The rest are `legacy` because no rule has been read off their frames yet, and
 * D1 決定 1 says in as many words that a tool without a rule must not be
 * flipped. Giving them `enforce` here would not tighten anything either — their
 * modules declare no `readIdleEvidence`, so the chain answers `'positive'`
 * regardless. The row is kept so the table states the rollout rather than
 * hiding it in an omission.
 */
export const IDLE_EVIDENCE_DEFAULT_MODE: Readonly<Record<CLIToolType, IdleEvidenceMode>> = {
  claude: 'observe',
  copilot: 'enforce',
  opencode: 'enforce',
  codex: 'legacy',
  gemini: 'legacy',
  antigravity: 'legacy',
  'vibe-local': 'legacy',
  // Issue #2250: Command Code ships `legacy` for the reason D1 決定 1 gives --
  // its module declares no `readIdleEvidence`, so the chain answers `'positive'`
  // whatever this row says, and claiming `enforce` would state a rollout that
  // does not exist. Epic #2249 決定 3 pins the same value from the other side.
  'command-code': 'legacy',
};

/**
 * The kill switch.
 *
 * A comma-separated list of `<tool>=<mode>` pairs, with `*` for "every tool":
 *
 * ```
 * CM_DETECTION_IDLE_EVIDENCE=claude=legacy            # one tool back to the old reading
 * CM_DETECTION_IDLE_EVIDENCE=*=observe                # measure the whole rollout first
 * CM_DETECTION_IDLE_EVIDENCE=*=observe,opencode=enforce
 * ```
 *
 * Read on every call rather than at module load: the value has to be flippable
 * without a rebuild, and a cached read would make the switch a restart away
 * from the incident it exists for.
 */
export const IDLE_EVIDENCE_ENV_VAR = 'CM_DETECTION_IDLE_EVIDENCE';

function isMode(value: string): value is IdleEvidenceMode {
  return (IDLE_EVIDENCE_MODES as readonly string[]).includes(value);
}

/**
 * Resolve one tool's rollout mode.
 *
 * Later entries win over earlier ones, and a tool-specific entry wins over `*`
 * whatever the order — so `*=observe,claude=enforce` and
 * `claude=enforce,*=observe` mean the same thing. An unparseable entry is
 * ignored rather than throwing: this is read on the status polling path, and a
 * typo in an env var must not take the detector down.
 *
 * @param tool - CLI tool to resolve for
 * @param env - Environment to read; injectable for tests
 */
export function resolveIdleEvidenceMode(
  tool: CLIToolType,
  env: NodeJS.ProcessEnv = process.env,
): IdleEvidenceMode {
  const raw = env[IDLE_EVIDENCE_ENV_VAR];
  let wildcard: IdleEvidenceMode | null = null;
  let specific: IdleEvidenceMode | null = null;

  if (typeof raw === 'string' && raw.trim() !== '') {
    for (const entry of raw.split(',')) {
      const [rawKey, rawValue] = entry.split('=');
      if (rawValue === undefined) continue;
      const key = rawKey.trim();
      const value = rawValue.trim();
      if (!isMode(value)) continue;
      if (key === '*') wildcard = value;
      else if (key === tool) specific = value;
    }
  }

  return specific ?? wildcard ?? IDLE_EVIDENCE_DEFAULT_MODE[tool] ?? 'legacy';
}
