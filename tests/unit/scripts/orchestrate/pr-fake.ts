/**
 * A fake `git` / `gh` / `npx` for publish-pr.mjs and merge-pr.mjs (Issue #3477).
 * Nothing is pushed, opened or merged: every call is recorded and answered
 * from `state`, which a test changes between runs to play GitHub.
 */

export const HEAD_A = 'a'.repeat(40);
export const HEAD_B = 'b'.repeat(40);
export const HEAD_M = 'c'.repeat(40);
export const DEVELOP = 'd'.repeat(40);
/** The tree `git merge-tree --write-tree` answers (#4076). */
export const MERGE_TREE = '9'.repeat(40);

export type Pr = { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefOid: string; url: string; title: string; headRefName: string; baseRefName: string };
export type Check = { name: string; bucket: string; link?: string };
export type Call = { command: string; args: string[]; env?: Record<string, string> };

export interface FakeState {
  head: string;
  branch: string;
  status: string;
  /** `git log --first-parent --format=%H %P` from HEAD. */
  firstParent: string[];
  /**
   * Files a single-parent commit touches (`git diff-tree <sha>`). For a merge, the files it
   * changed itself: what `git diff-tree <merge-tree> <sha>` answers (#4076); none when absent.
   */
  commitFiles: Record<string, string[]>;
  changelogStatus: string;
  changed: string[];
  /** origin/develop is not in HEAD; `git merge` makes HEAD_M (or conflicts). */
  behind: boolean;
  mergeConflict: string[];
  markers: string;
  failCommands: string[];
  prs: Pr[];
  otherOpen: { number: number; title: string; headRefName: string; body?: string }[];
  /** One answer per `gh pr checks` call; the last repeats. */
  checks: Check[][];
  issueState: 'OPEN' | 'CLOSED';
  createdNumber: number;
  pushFails: boolean;
  /** `%s` of a commit by sha; others get the default subject. */
  subjects: Record<string, string>;
  /** `gh api repos/<repo>/issues/<N> --jq .title` (#4076 B); null answers like an Issue gh could not read. */
  issueTitle: string | null;
  /** `gh run view <id> --json status` by run id; `completed` when absent. `gh run rerun` sets `queued`. */
  runStatus: Record<string, string>;
  /** `gh run view <id> --json attempt` by run id; 1 when absent. `gh run rerun` adds 1. */
  runAttempt: Record<string, number>;
}

export function fakeGit(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    head: HEAD_A,
    branch: 'feature/3477-worktree',
    status: '',
    firstParent: [`${HEAD_A} ${DEVELOP}`],
    commitFiles: { [HEAD_A]: ['scripts/orchestrate/merge-pr.mjs', 'changelog.d/3477.md'] },
    changelogStatus: 'A\tchangelog.d/3477.md',
    changed: ['scripts/orchestrate/merge-pr.mjs', 'tests/unit/scripts/orchestrate/merge-pr.test.ts', 'changelog.d/3477.md'],
    behind: false,
    mergeConflict: [],
    markers: '',
    failCommands: [],
    prs: [],
    otherOpen: [],
    checks: [[]],
    issueState: 'OPEN',
    createdNumber: 9001,
    pushFails: false,
    subjects: {},
    issueTitle: 'feat(orchestrate): publish and merge',
    runStatus: {},
    runAttempt: {},
    ...overrides,
  };
  const calls: Call[] = [];
  let checksIndex = 0;
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const failed = (stderr: string, status = 1) => ({ status, stdout: '', stderr });

  const run = (command: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
    calls.push({ command, args, env: opts.env });
    if (command === 'git') {
      const sub = args.slice(2);
      const [verb] = sub;
      if (verb === 'rev-parse') return ok(sub.includes('--abbrev-ref') ? `${state.branch}\n` : `${state.head}\n`);
      if (verb === 'status') return ok(state.status);
      if (verb === 'log' && sub.includes('--first-parent')) return ok(state.firstParent.join('\n'));
      if (verb === 'log') return ok(sub.includes('--format=%s') ? `${state.subjects[sub[sub.length - 1]] ?? 'feat(orchestrate): publish and merge (#3477)'}\n` : 'body line\n');
      // The automatic merge of a merge's parents (#4076): diff-tree of it against the merge answers commitFiles[merge].
      if (verb === 'merge-tree') return ok(`${MERGE_TREE}\n`);
      if (verb === 'diff-tree') return ok((state.commitFiles[sub[sub.length - 1]] ?? []).join('\n'));
      if (verb === 'diff' && sub.includes('--name-status')) return ok(state.changelogStatus);
      if (verb === 'diff' && sub.includes('--diff-filter=U')) return ok(state.mergeConflict.join('\n'));
      if (verb === 'diff' && sub.includes('--diff-filter=ACMR')) return ok(state.changed.join('\n'));
      if (verb === 'diff' && sub.includes('--diff-filter=D')) return ok('');
      if (verb === 'diff' && sub.includes('--unified=0')) return ok('');
      if (verb === 'fetch') return ok();
      if (verb === 'merge-base') return state.behind ? failed('', 1) : ok();
      if (verb === 'merge' && sub.includes('--abort')) return ok();
      if (verb === 'merge') {
        if (state.mergeConflict.length > 0) return failed('CONFLICT');
        state.head = HEAD_M;
        state.behind = false;
        state.firstParent = [`${HEAD_M} ${HEAD_A} ${DEVELOP}`, ...state.firstParent];
        return ok();
      }
      if (verb === 'grep') return state.markers ? ok(state.markers) : failed('', 1);
      if (verb === 'push') {
        if (state.pushFails) return failed('rejected');
        for (const pr of state.prs) if (pr.state === 'OPEN' && pr.headRefName === state.branch) pr.headRefOid = state.head;
        return ok();
      }
      throw new Error(`unexpected git ${sub.join(' ')}`);
    }
    if (command === 'gh') {
      const key = args.slice(0, 2).join(' ');
      if (key === 'pr list' && args.includes('--head')) {
        const branch = args[args.indexOf('--head') + 1];
        return ok(JSON.stringify(state.prs.filter((pr) => pr.headRefName === branch)));
      }
      if (key === 'pr list') return ok(JSON.stringify(state.otherOpen));
      if (key === 'pr create') {
        const pr: Pr = {
          number: state.createdNumber,
          state: 'OPEN',
          headRefOid: state.head,
          url: `https://github.com/Kewton/CommandMate/pull/${state.createdNumber}`,
          title: args[args.indexOf('--title') + 1],
          headRefName: args[args.indexOf('--head') + 1],
          baseRefName: args[args.indexOf('--base') + 1],
        };
        state.prs.push(pr);
        return ok(`${pr.url}\n`);
      }
      if (key === 'pr view') {
        const pr = state.prs.find((p) => String(p.number) === args[2]);
        if (!pr) return failed('no pull requests found');
        // Only the fields that were asked for, like gh.
        const asked = (args[args.indexOf('--json') + 1] ?? '').split(',').filter(Boolean);
        const picked = asked.length ? Object.fromEntries(asked.map((k) => [k, (pr as Record<string, unknown>)[k]])) : pr;
        return ok(JSON.stringify(picked));
      }
      if (key === 'pr checks') {
        const answer = state.checks[Math.min(checksIndex++, state.checks.length - 1)];
        const pending = answer.some((c) => c.bucket === 'pending');
        return { status: pending ? 8 : 0, stdout: JSON.stringify(answer), stderr: '' };
      }
      if (key === 'run rerun') {
        state.runStatus[args[2]] = 'queued';
        state.runAttempt[args[2]] = (state.runAttempt[args[2]] ?? 1) + 1;
        return ok();
      }
      if (key === 'run view') {
        return ok(JSON.stringify({ status: state.runStatus[args[2]] ?? 'completed', attempt: state.runAttempt[args[2]] ?? 1 }));
      }
      if (key === 'pr merge') {
        if (state.failCommands.includes('gh pr merge')) return failed('merge refused');
        const pr = state.prs.find((p) => String(p.number) === args[2]);
        if (pr) pr.state = 'MERGED';
        return ok();
      }
      if (args[0] === 'api' && /^repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(args[1] ?? '') && args.includes('.title')) {
        return state.issueTitle === null ? failed('gh: Not Found (HTTP 404)') : ok(`${state.issueTitle}\n`);
      }
      if (key === 'issue view') return ok(JSON.stringify({ state: state.issueState }));
      if (key === 'issue close') {
        state.issueState = 'CLOSED';
        return ok();
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    }
    const name = `${command} ${args.slice(0, 2).join(' ')}`;
    return state.failCommands.some((f) => name.includes(f)) ? failed(`${name} failed`) : ok(`${name} ok\n`);
  };

  const ghCalls = (prefix: string) => calls.filter((c) => c.command === 'gh' && c.args.join(' ').startsWith(prefix));
  const gitCalls = (verb: string) => calls.filter((c) => c.command === 'git' && c.args[2] === verb);
  return { state, calls, run, ghCalls, gitCalls };
}

export function openPr(overrides: Partial<Pr> = {}): Pr {
  return {
    number: 4242,
    state: 'OPEN',
    headRefOid: HEAD_A,
    url: 'https://github.com/Kewton/CommandMate/pull/4242',
    title: 'feat(orchestrate): publish and merge (#3477)',
    headRefName: 'feature/3477-worktree',
    baseRefName: 'develop',
    ...overrides,
  };
}
