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
 *     `obs.mkdir('mkdir-lock', …)`, and the rmdir whose result decides a take: `lock_rmdir_errno
 *     reclaim-rmdir …`, `obs.rmdir('reclaim-rmdir', …)`), to be compared with the table, and
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
    // Widened after the review of the first implementation (#4288 Codex 5-2b P1 / PM review P2-2): a
    // second read of a record through the JSON helpers, a test operator or a redirection bypassed
    // the observers unseen — lock_record_state read the pgid again and took a failed read as "no group".
    { name: 'json field', re: /\block_json_field\b/g },
    { name: 'json text field', re: /\block_json_text_field\b/g },
    { name: 'awk', re: /(?:^|[\s;&|({$])awk(?![-\w])/g },
    { name: 'test -d/-e/-f/-r/-x', re: /\[ (?:! )?-[defrx] /g },
    { name: 'read <', re: /\bread\b[^<\n]*<(?!<)|\$\(<\s/g },
    { name: 'rmdir', re: /(?:^|[\s;&|({$])rmdir(?![-\w])/g },
  ],
  ts: [
    { name: 'process.kill', re: /\bprocess\.kill\(/g },
    { name: 'readdirSync', re: /\breaddirSync\(/g },
    { name: 'mkdirSync', re: /\bmkdirSync\(/g },
    { name: 'renameSync', re: /\brenameSync\(/g },
    { name: 'readFileSync', re: /\breadFileSync\(/g },
    { name: 'lstatSync', re: /\blstatSync\(/g },
    { name: 'readOwner', re: /\breadOwner\(/g },
    // Widened with the bash list (#4288 PM review P2-2).
    { name: 'existsSync', re: /\bexistsSync\(/g },
    { name: 'statSync', re: /\bstatSync\(/g },
    { name: 'readJson', re: /\breadJson\(/g },
    { name: 'rmdirSync', re: /\brmdirSync\(/g },
    { name: 'rmSync', re: /\brmSync\(/g },
    { name: 'readdir (async)', re: /\breaddir\(/g },
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

/**
 * The observation points an implementation names. The errno-keeping rmdir (bash `lock_rmdir_errno`,
 * TS / sync JS `obs.rmdir`) is one too: its failure keeps a poll from the mkdir (#4288 Codex 2nd
 * re-review P2), so a new rmdir point must be in the table and get its injected failure. So are the
 * owner's exclusive create (bash `lock_obs_create`, TS / sync JS `obs.create`) and the age of an
 * owner-less lock (bash `lock_obs_mtime`) the options of #4288 PR1a added (D3).
 */
export function scanObservationPoints(impl: Impl, source: string): Set<string> {
  const points = new Set<string>();
  const patterns = impl === 'bash'
    ? [/\block_(?:obs_(?:kill0|list|lstat|owner|mkdir|mv|pgid|create|mtime)|rmdir_errno) ([a-z][a-z0-9-]*)\b/g, /\block_gone_candidates ([a-z][a-z0-9-]*)\b/g]
    : [/\bobs\.(?:pid|group|list|lstat|owner|mkdir|rename|rmdir|create)\('([a-z][a-z0-9-]*)'/g, /\bgoneCandidates\(ctx, '([a-z][a-z0-9-]*)'/g];
  for (const { line } of linesWithFunction(impl, source)) {
    for (const re of patterns) for (const m of line.matchAll(re)) points.add(m[1]);
  }
  return points;
}

/**
 * The functions that make an observation themselves (#4288 Codex re-review P1): every step inside
 * them — the read, each field's extraction, the number check — is three-valued too. The first
 * implementation checked the read (`cat`) and not the extraction (`awk`) after it, and an extraction
 * that failed came back empty — "no pgid", "no group" — and a live gate's lock was recovered.
 */
export const OBSERVER_FUNCTIONS: Record<Impl, (fn: string) => boolean> = {
  bash: (fn) =>
    /^lock_obs_/.test(fn) ||
    ['lock_kill0_raw', 'lock_rmdir_errno', 'lock_pgid_field_ok', 'lock_ticket_retirable', 'lock_pid_start_ms'].includes(fn),
  ts: (fn) => fn === 'makeObserver',
  sync: (fn) => fn === 'makeObserver',
};

/** Pure classifiers (no I/O, no process): their command substitution cannot fail. */
const BASH_PURE = /^\s*(?:lock_errno_text|lock_errno_of)\b/;

/** Calls inside the TS / sync observers whose failure must be caught: each sits in a `try` block. */
const TS_THROWING = /\b(?:process\.kill|(?:fs\.)?readdirSync|(?:fs\.)?lstatSync|(?:fs\.)?readFileSync|(?:fs\.)?mkdirSync|(?:fs\.)?renameSync|(?:fs\.)?rmdirSync|JSON\.parse)\(/g;

/**
 * The calls inside an observer whose failure is not looked at: `<fn>:<line>: <text>`, one per call.
 *
 *   - bash: a command substitution `$(…)` (other than a pure classifier, and `$((…))`) whose exit
 *     code nothing reads — it is not the condition of an `if` / `elif` / `while`, not followed by
 *     `||` or `; <var>=$?`, and the next line is not `<var>=$?`.
 *   - TS / sync JS: a throwing call outside every `try { … }` of the observer.
 */
export function scanUncheckedCalls(impl: Impl, source: string): string[] {
  const lines = source.split('\n');
  const owner: string[] = [];
  for (const { fn, n } of linesWithFunction(impl, source)) owner[n - 1] = fn;
  const found: string[] = [];
  if (impl === 'bash') {
    for (let i = 0; i < lines.length; i++) {
      const fn = owner[i];
      if (!fn || !OBSERVER_FUNCTIONS.bash(fn)) continue;
      const line = lines[i];
      for (const m of line.matchAll(/\$\((?!\()/g)) {
        const start = (m.index ?? 0) + 2;
        if (BASH_PURE.test(line.slice(start))) continue;
        // Walk to the closing parenthesis, across lines (an awk program spans several).
        let depth = 1;
        let li = i;
        let ci = start;
        while (li < lines.length && depth > 0) {
          const text = lines[li];
          for (; ci < text.length; ci++) {
            if (text[ci] === '(') depth++;
            else if (text[ci] === ')' && --depth === 0) break;
          }
          if (depth > 0) {
            li++;
            ci = 0;
          }
        }
        const before = line.slice(0, m.index).trim();
        const after = (lines[li] ?? '').slice(ci + 1);
        const next = lines.slice(li + 1).find((l) => l.trim() !== '') ?? '';
        const checked =
          /^(?:if|elif|while|until)\b/.test(before) ||
          /^\s*"?\s*(?:\|\||;\s*[A-Za-z_][A-Za-z0-9_]*=\$\?)/.test(after) ||
          /^\s*[A-Za-z_][A-Za-z0-9_]*=\$\?\s*$/.test(next);
        if (!checked) found.push(`${fn}:${i + 1}: ${line.trim()}`);
      }
    }
    return found;
  }
  const stack: boolean[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fn = owner[i];
    const line = lines[i];
    const calls = new Set([...line.matchAll(TS_THROWING)].map((m) => m.index ?? 0));
    for (let ci = 0; ci < line.length; ci++) {
      if (calls.has(ci) && fn && OBSERVER_FUNCTIONS[impl](fn) && !stack.includes(true)) {
        found.push(`${fn}:${i + 1}: ${line.trim()}`);
      }
      if (line[ci] === '{') stack.push(/\btry\s*$/.test(line.slice(0, ci)));
      else if (line[ci] === '}') stack.pop();
    }
  }
  return found;
}
