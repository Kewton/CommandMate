/**
 * Pure forward / inverse transform that derives the `-dev` skills
 * (cmate-handoff-dev / cmate-delegate-dev) from the published
 * `Kewton/commandmate-skills` packages (Issue #4323).
 *
 * The -dev skills call the CLI as `commandmatedev` (the develop build) instead
 * of the public `commandmate`. The rule table below is closed: every change is
 * one of R1 / R1b / R2 / E / D, and `inverse` undoes them exactly, so
 * `sha256(inverse(derived)) === upstream sha256` proves a derived file came
 * from the pinned upstream bytes (no checkout of the skills repo needed).
 *
 * Rules (applied in this order by `forward`):
 *   R1  CLI call: `commandmate` followed by blanks and a lowercase sub-command.
 *   R1b `commandmate` wrapped in backticks.
 *   R2  skill name `cmate-delegate` / `cmate-handoff` -> `…-dev`.
 *   E   two literal exceptions in ask.sh (default value of the launcher).
 *   D   a fixed prefix on the SKILL.md frontmatter `description:`.
 */

/** Word characters, Unicode-aware (matches Python's `\w` used in the design). */
const W = '\\p{L}\\p{N}_';

export const R1 = new RegExp(`(?<![${W}./@$:{-])commandmate(?=[ \\t]+[a-z-])`, 'gu');
export const R1B = /`commandmate`/g;
export const R2 = new RegExp(
  `(?<![${W}])(?<!fixtures/)cmate-(delegate|handoff)(?![${W}])(?![:-])`,
  'gu',
);

/** Exceptions R1 cannot reach (`{-` guards the default value; see design §1.3). */
export const EXCEPTIONS = [
  ['LAUNCHER="${CM:-commandmate}"', 'LAUNCHER="${CM:-commandmatedev}"'],
  ['(default: $CM, else commandmate)', '(default: $CM, else commandmatedev)'],
];

export const DESCRIPTION_PREFIX = {
  'cmate-delegate': '【開発ブランチ用・CLI は commandmatedev。公開版は cmate-delegate】',
  'cmate-handoff': '【開発ブランチ用・CLI は commandmatedev。公開版は cmate-handoff】',
};

const DESCRIPTION_LINE = /^description: /m;

/** Which package a SKILL.md belongs to, from its `name:` line. */
function skillNameOf(text) {
  const m = /^name: (cmate-(?:delegate|handoff))(?:-dev)?$/m.exec(text);
  return m ? m[1] : null;
}

export function isSkillMd(rel) {
  return rel === 'SKILL.md';
}

/** upstream bytes (as text) -> derived text. */
export function forward(rel, text) {
  const baseName = isSkillMd(rel) ? skillNameOf(text) : null;
  let out = text.replace(R1, 'commandmatedev').replace(R1B, '`commandmatedev`').replace(R2, '$&-dev');
  for (const [from, to] of EXCEPTIONS) {
    // Exceptions only apply where the literal exists (ask.sh); never invent one.
    out = out.split(from).join(to);
  }
  if (baseName) {
    out = out.replace(DESCRIPTION_LINE, `description: ${DESCRIPTION_PREFIX[baseName]}`);
  }
  return out;
}

/** derived text -> upstream text. Strips the D prefix first, then names, then CLI. */
export function inverse(rel, text) {
  let out = text;
  if (isSkillMd(rel)) {
    for (const prefix of Object.values(DESCRIPTION_PREFIX)) {
      out = out.replace(`description: ${prefix}`, 'description: ');
    }
  }
  out = out.replace(/cmate-(delegate|handoff)-dev/g, 'cmate-$1').replace(/commandmatedev/g, 'commandmate');
  return out;
}

/** Count of `commandmatedev` occurrences. */
export function countDevCli(text) {
  return (text.match(/commandmatedev/g) ?? []).length;
}
