/**
 * A tool whose account hit its usage limit (Issue #3729).
 *
 * On 2026-10-16 command-code 1.81.0 answered every probe turn with
 * `You've reached your weekly usage limit. Resets in 1d 17h` (and the taste
 * call behind it with `POST /alpha/generate → 429`). With no model call there
 * is no running screen, no approval dialog and no `stop` hook — three fails
 * (#3717 / #3718 / #3719) that say nothing about CommandMate and that no code
 * change can fix. Such a check is reported as a `usage-limit` skip instead,
 * counted in `skipByKind` so a tool that stays limited is still visible.
 *
 * Nothing is relaxed:
 * - a check that holds still passes;
 * - only a frame of this tool's own session that shows the limit excuses a fail;
 * - the patterns are the tools' "the limit was reached" wording. A bare
 *   `usage limit` or `429` is not enough: Claude's healthy banner advertises
 *   "up to 50% of your weekly usage limit" and codex's footer says
 *   "You have 1 usage limit reset available" (`lib/detection/upstream-faults.ts`
 *   learned the same lesson).
 */

import { stripAnsi } from '@/lib/detection/ansi';
import { paneEvidence } from './report';
import { skipCheck } from './coverage';
import type { AgentHealthCheck } from './types';

export interface UsageLimitSignature {
  id: string;
  /** The CLI whose wording this is (documentation; every pattern is tried on every tool). */
  tool: string;
  pattern: RegExp;
}

/**
 * The wording each tool uses once the limit is reached. Add a row when a new
 * tool's wording is seen; keep the row specific to "reached".
 */
export const USAGE_LIMIT_SIGNATURES: readonly UsageLimitSignature[] = [
  // command-code 1.81.0, measured 2026-10-16 (#3718 / #3719):
  // `◼ You've reached your weekly usage limit. Resets in 1d 17h (日 1:04).`
  { id: 'command-code-reached', tool: 'command-code', pattern: /\bYou(?:'|’)ve reached your (?:\w+ )?usage limit\b/i },
  // The same run's `⚠ taste learning failed: POST /alpha/generate → 429 error: You've reached …`
  { id: 'http-429-usage-limit', tool: 'command-code', pattern: /\b429\b[^\n]*\busage limit\b/i },
  // claude: `Claude usage limit reached. Your limit will reset at 3pm.` (upstream-faults-1839 fixture)
  { id: 'claude-limit-reached', tool: 'claude', pattern: /\busage limit reached\b/i },
  // claude / codex: `You've hit your limit · resets 3pm`, `You've hit your usage limit. Upgrade to …`
  { id: 'hit-your-limit', tool: 'claude/codex', pattern: /\bYou(?:'|’)ve hit your (?:\w+ )?(?:usage )?limit\b/i },
];

export interface UsageLimitMatch {
  signature: UsageLimitSignature;
  /** The whole line that carried it, trimmed. */
  line: string;
}

/** The first usage-limit signature on the frame (ANSI stripped here), or null. */
export function findUsageLimit(frame: string): UsageLimitMatch | null {
  const clean = stripAnsi(frame);
  for (const signature of USAGE_LIMIT_SIGNATURES) {
    const match = signature.pattern.exec(clean);
    if (!match) continue;
    const start = clean.lastIndexOf('\n', match.index) + 1;
    const end = clean.indexOf('\n', match.index);
    const line = clean.slice(start, end === -1 ? undefined : end).trim();
    return { signature, line: line || match[0] };
  }
  return null;
}

/** The first of `frames` that shows the limit, with its match. */
export function firstUsageLimitFrame(
  frames: readonly string[]
): { frame: string; match: UsageLimitMatch } | null {
  for (const frame of frames) {
    const match = findUsageLimit(frame);
    if (match) return { frame, match };
  }
  return null;
}

/**
 * A check of a tool session whose frames may show the usage limit: a `fail`
 * becomes a `usage-limit` skip when one of `frames` shows it; anything else is
 * returned unchanged.
 *
 * @param frames - for a `screen-*` check, the frames it judged; for
 *   `hook-correlation`, the frame of the session that showed the limit (if any)
 */
export function judgeUsageLimit(check: AgentHealthCheck, frames: readonly string[]): AgentHealthCheck {
  if (check.status !== 'fail') return check;
  const seen = firstUsageLimitFrame(frames);
  if (!seen) return check;
  return {
    ...skipCheck(
      check.checkId,
      'usage-limit',
      `検査不能: ツールの利用上限に達している（${seen.match.line}）`,
      `利用上限に達しておりプロンプトが処理されないため判定できない（画面: ${seen.match.line}）。判定していれば: ${check.summary}`
    ),
    // The pane, not the hook JSON: the limit is what explains the missing events.
    evidence: check.checkId === 'hook-correlation' ? paneEvidence(seen.frame) : (check.evidence ?? paneEvidence(seen.frame)),
  };
}
