/**
 * The scanner behind the observation-point table of Issue #4288 (docs/design/verify-lock-holder-group-4288.md §2.8).
 *
 * The rule it enforces: every observation a decision to take, recover or release the machine-wide
 * lock reads — `kill -0`, an owner record, a directory listing, a `mkdir`, a `rename` — answers in
 * three values (alive / gone / unknown), and unknown never takes, deletes or releases. The three
 * implementations route those observations through one family of functions each (bash `lock_obs_*`,
 * TS / sync JS `obs.*` from `makeObserver`), named by an observation point. Two things are collected
 * from the source text, mechanically:
 *
 *   - the observation points each implementation names (`lock_obs_mkdir mkdir-lock …`,
 *     `obs.mkdir('mkdir-lock', …)`), to be compared with the table, and
 *   - every RAW call of an observing primitive (`kill -0`, `mkdir`, `readdirSync(`, …) with the
 *     function it sits in, to be compared with the list of the places allowed to make one: the
 *     observer functions themselves and the call sites the table exempts with a reason.
 *
 * A new observation that bypasses the observers shows up as a raw call nobody listed; a new point
 * shows up as a point the table does not have. Both fail the test.
 */

export type Impl = 'bash' | 'ts' | 'sync';

/** Primitives whose raw call is an observation (or the action an observation reads). */
export const RAW_PRIMITIVES: Record<Impl, { name: string; re: RegExp }[]> = {
  bash: [
    { name: 'kill -0', re: /\bkill -0\b/g },
    { name: 'mkdir', re: /(?:^|[\s;&|({$])mkdir(?![-\w])/g },
    { name: 'mv', re: /(?:^|[\s;&|({$])mv(?![-\w])/g },
    { name: 'ls', re: /(?:^|[\s;&|({$])ls(?![-\w])/g },
    { name: 'cat', re: /(?:^|[\s;&|({$])cat(?![-\w])/g },
    { name: 'ps -o', re: /\bps -o\b/g },
    { name: 'glob .gone-*', re: /\.gone-\*/g },
    { name: 'owner field', re: /\block_owner_field\b/g },
  ],
  ts: [
    { name: 'process.kill', re: /\bprocess\.kill\(/g },
    { name: 'readdirSync', re: /\breaddirSync\(/g },
    { name: 'mkdirSync', re: /\bmkdirSync\(/g },
    { name: 'renameSync', re: /\brenameSync\(/g },
    { name: 'readFileSync', re: /\breadFileSync\(/g },
    { name: 'lstatSync', re: /\blstatSync\(/g },
    { name: 'readOwner', re: /\breadOwner\(/g },
  ],
  sync: [],
};
RAW_PRIMITIVES.sync = RAW_PRIMITIVES.ts;

const isComment = (impl: Impl, line: string): boolean =>
  impl === 'bash' ? /^\s*#/.test(line) : /^\s*(\*|\/\/|\/\*)/.test(line);

/** The function a line belongs to: bash `name() {` … `}`, TS / JS top-level `function name(` … `}`. */
function* linesWithFunction(impl: Impl, source: string): Generator<{ fn: string; line: string; n: number }> {
  let fn = '<top>';
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const def = impl === 'bash'
      ? /^([A-Za-z_][A-Za-z0-9_]*)\(\) \{/.exec(line)
      : /^(?:export )?(?:async )?function\*? ([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line);
    if (def) fn = def[1];
    if (!isComment(impl, line)) yield { fn, line, n: i + 1 };
    if (/^\}/.test(line)) fn = '<top>';
  }
}

/** `fn|primitive` → number of raw calls. */
export function scanRawCalls(impl: Impl, source: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const { fn, line } of linesWithFunction(impl, source)) {
    for (const { name, re } of RAW_PRIMITIVES[impl]) {
      const count = [...line.matchAll(re)].length;
      if (count > 0) found.set(`${fn}|${name}`, (found.get(`${fn}|${name}`) ?? 0) + count);
    }
  }
  return found;
}

/** The observation points an implementation names. */
export function scanObservationPoints(impl: Impl, source: string): Set<string> {
  const points = new Set<string>();
  const patterns = impl === 'bash'
    ? [/\block_obs_(?:kill0|list|lstat|owner|mkdir|mv|pgid) ([a-z][a-z0-9-]*)\b/g, /\block_gone_candidates ([a-z][a-z0-9-]*)\b/g]
    : [/\bobs\.(?:pid|group|list|lstat|owner|mkdir|rename)\('([a-z][a-z0-9-]*)'/g, /\bgoneCandidates\(ctx, '([a-z][a-z0-9-]*)'/g];
  for (const { line } of linesWithFunction(impl, source)) {
    for (const re of patterns) for (const m of line.matchAll(re)) points.add(m[1]);
  }
  return points;
}
