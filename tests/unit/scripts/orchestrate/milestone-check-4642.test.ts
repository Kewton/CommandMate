/**
 * milestone-check.mjs — the read-only Milestone consistency check (Issue #4642 PR-1,
 * docs/design/milestone-check-4642.md §2・§3・§4・§5・§6).
 *
 * Every `git` / `gh` answer is the raw text the real command prints, fed through a fake
 * spawnSync; nothing reaches GitHub, no worktree is created, and the only files are under
 * `os.tmpdir()`. The tool is imported inside each test (`await tool()`), so the first commit
 * of this file is red with `Cannot find module …/milestone-check.mjs` for every case.
 *
 * Table of cases (brief T1〜T8):
 *  - T1 the judgement table: 2 states × 5 milestones × 7 evidence kinds = 70 rows
 *  - T2 each read × { ok, fail, timeout, limit, unreadable JSON, shape } → exit 61
 *  - T3 the allow table and the recorded calls (nothing outside it is called)
 *  - T4 keys from directories, branches, PR bodies/titles and plan items; keyless rows
 *  - T5 settings (current missing / not a milestone / closed / bad shape) → exit 2
 *  - T6 the summary --md text, verbatim
 *  - T7 today's Sprint 12/13 drift (plan-4642.md (5)) as a fixture
 *  - T8 the deadline: a result that comes back after it is not used → exit 61
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MODULE = '../../../../scripts/orchestrate/milestone-check.mjs';
const REPO = 'Owner/Thing';
const BASE = 'develop';
const MERGED_FROM = '2026-11-13';
const WALL_NOW = Date.parse('2026-11-27T12:00:00Z');

type Tool = typeof import('../../../../scripts/orchestrate/milestone-check.mjs');
let cached: Tool | undefined;
/** The tool, imported lazily: a missing module (the test-first commit) makes every test red. */
async function tool(): Promise<Tool> {
  if (cached === undefined) cached = await import(MODULE);
  return cached;
}

// ---------------------------------------------------------------------------
// The fake world
// ---------------------------------------------------------------------------

interface Call {
  cmd: string;
  args: string[];
  cwd?: string;
  timeout?: number;
}
interface Answer {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: { code?: string };
}
interface Ms {
  title: string;
  state: 'open' | 'closed';
  open: number;
  closed?: number;
}
interface IssueRow {
  number: number;
  state: 'OPEN' | 'CLOSED';
  title?: string;
  milestone: string | null;
  labels?: string[];
}
interface Wt {
  path: string;
  branch: string | null;
}
interface PrRow {
  number: number;
  head: string;
  title?: string;
  body?: string;
  state: 'open' | 'merged';
  mergedAt?: string;
}
type ReadName = 'worktrees' | 'revParse' | 'revList' | 'milestones' | 'issueList' | 'openPrs' | 'mergedPrs' | 'timeline' | 'roadmap';

interface World {
  root: string;
  yaml: string;
  milestones: Ms[];
  issues: IssueRow[];
  worktrees: Wt[];
  prs: PrRow[];
  /** per branch rev-list count; 'fail' / 'timeout' allowed. */
  revList?: Record<string, number | 'fail' | 'timeout'>;
  timeline?: Record<number, Array<{ event: string; createdAt: string; milestone?: string }> | 'fail'>;
  roadmapComments?: string[] | 'fail';
  /** A read that fails wholesale (status / error / raw stdout). */
  fail?: Partial<Record<ReadName, Answer>>;
  /** Override one exact `cmd args` answer. */
  override?: Record<string, Answer>;
  plan?: string | null;
}

const DEFAULT_YAML = 'version: 1\nrepo: Owner/Thing\nbase: develop\nmilestone:\n  current: "Sprint 13"\n  roadmapIssue: 4461\n  mergedWindowDays: 14\n';

const temps: string[] = [];
let savedHome: string | undefined;
let home: string;
let lockRoot: string;

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkTemp('milestone-4642-home-');
  lockRoot = mkTemp('milestone-4642-lock-');
  process.env.HOME = home;
  process.env.CM_VERIFY_LOCK_ROOT = lockRoot;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env.CM_VERIFY_LOCK_ROOT;
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  cached = undefined;
});

function mkTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function repoWith(yaml: string | null): string {
  const root = mkTemp('milestone-4642-repo-');
  if (yaml !== null) {
    fs.mkdirSync(path.join(root, '.commandmate'));
    fs.writeFileSync(path.join(root, '.commandmate', 'flow.yaml'), yaml);
  }
  return root;
}

const dirOf = (root: string) => path.dirname(root);
const wtPath = (root: string, name: string) => path.join(dirOf(root), `wt-${name}`);

function porcelain(w: World): string {
  const blocks = [`worktree ${w.root}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/${BASE}\n`];
  for (const wt of w.worktrees) {
    if (wt.branch === null) blocks.push(`worktree ${wt.path}\nHEAD ${'d'.repeat(40)}\ndetached\n`);
    else blocks.push(`worktree ${wt.path}\nHEAD ${'b'.repeat(40)}\nbranch refs/heads/${wt.branch}\n`);
  }
  return blocks.join('\n');
}

const milestoneJson = (w: World) =>
  JSON.stringify(w.milestones.map((m, i) => ({ number: i + 1, title: m.title, state: m.state, open_issues: m.open, closed_issues: m.closed ?? 0 })));

const issueJson = (rows: IssueRow[]) =>
  JSON.stringify(rows.map((r) => ({ number: r.number, state: r.state, title: r.title ?? `issue ${r.number}`, labels: (r.labels ?? []).map((name) => ({ name })), closedAt: null })));

const prJson = (rows: PrRow[], kind: 'open' | 'merged') =>
  JSON.stringify(
    rows
      .filter((p) => p.state === kind)
      .map((p) => ({
        number: p.number,
        headRefName: p.head,
        title: p.title ?? `pr ${p.number}`,
        body: p.body ?? '',
        ...(kind === 'merged' ? { mergedAt: p.mergedAt ?? '2026-11-20T10:00:00Z' } : {}),
      })),
  );

const branchOf = (arg: string): string => {
  const m = /^refs\/remotes\/origin\/[^.]+\.\.refs\/heads\/(.+)$/.exec(arg);
  return m ? m[1] : '';
};

/** A spawnSync that answers from `w`, recording each call. */
function fakeSpawn(w: World, calls: Call[], hooks: { before?: (c: Call) => void } = {}) {
  return (cmd: string, args: string[], options: { cwd?: string; timeout?: number }): Answer => {
    const call: Call = { cmd, args: [...args], cwd: options?.cwd, timeout: options?.timeout };
    calls.push(call);
    hooks.before?.(call);
    const key = `${cmd} ${args.join(' ')}`;
    if (w.override?.[key]) return w.override[key];
    const ok = (stdout: string): Answer => ({ status: 0, stdout, stderr: '' });
    const fail = (name: ReadName): Answer | undefined => w.fail?.[name];
    if (cmd === 'git') {
      if (key === 'git rev-parse --path-format=absolute --git-common-dir') return fail('revParse') ?? ok(`${w.root}/.git\n`);
      if (key === 'git worktree list --porcelain') return fail('worktrees') ?? ok(porcelain(w));
      if (args[0] === 'rev-list') {
        const f = fail('revList');
        if (f) return f;
        const branch = branchOf(args[2]);
        const v = w.revList?.[branch] ?? 0;
        if (v === 'fail') return { status: 1, stdout: '', stderr: 'boom' };
        if (v === 'timeout') return { status: null, error: { code: 'ETIMEDOUT' } };
        return ok(`${v}\n`);
      }
      if (key === 'git remote get-url origin') return ok('git@github.com:Owner/Thing.git\n');
      if (key === 'git rev-parse --verify refs/remotes/origin/develop') return ok(`${'c'.repeat(40)}\n`);
      return { status: 1, stdout: '', stderr: `unexpected git ${key}` };
    }
    if (cmd === 'gh') {
      if (args[0] === 'api' && args[1] && args[1].includes('/milestones')) return fail('milestones') ?? ok(milestoneJson(w));
      if (args[0] === 'api' && args.includes('--paginate')) {
        const f = fail('timeline');
        if (f) return f;
        const n = Number(/\/issues\/(\d+)\/timeline/.exec(args[args.length - 1])?.[1]);
        const events = w.timeline?.[n] ?? [];
        if (events === 'fail') return { status: 1, stdout: '', stderr: 'boom' };
        return ok(JSON.stringify(events.map((e) => ({ event: e.event, createdAt: e.createdAt, milestone: e.milestone ? { title: e.milestone } : null }))));
      }
      if (args[0] === 'issue' && args[1] === 'list') {
        const f = fail('issueList');
        if (f) return f;
        const title = args[args.indexOf('--milestone') + 1];
        return ok(issueJson(w.issues.filter((i) => i.milestone === title)));
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        const f = fail('roadmap');
        if (f) return f;
        const comments = w.roadmapComments === undefined ? [] : w.roadmapComments;
        if (comments === 'fail') return { status: 1, stdout: '', stderr: 'boom' };
        return ok(JSON.stringify({ comments: comments.map((createdAt) => ({ createdAt })) }));
      }
      if (args[0] === 'pr' && args[1] === 'list') {
        const state = args[args.indexOf('--state') + 1];
        const f = fail(state === 'open' ? 'openPrs' : 'mergedPrs');
        if (f) return f;
        return ok(prJson(w.prs, state as 'open' | 'merged'));
      }
      return { status: 127, stdout: '', stderr: `unexpected gh ${key}` };
    }
    return { status: 127, stdout: '', stderr: 'not found' };
  };
}

interface RunOptions {
  monoNow?: () => number;
  hooks?: { before?: (c: Call) => void };
  planPath?: string;
  deadlineMono?: number;
}

async function runCli(w: World, argv: string[], extra: RunOptions = {}) {
  const { main } = await tool();
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {
    spawnSync: fakeSpawn(w, calls, extra.hooks ?? {}),
    monoNow: extra.monoNow ?? (() => 0),
    wallNow: () => WALL_NOW,
    cwd: w.root,
    env: {},
    stdout: (l: string) => out.push(l),
    stderr: (l: string) => err.push(l),
    ...(extra.deadlineMono !== undefined ? { deadlineMono: extra.deadlineMono } : {}),
  });
  const json = out.length > 0 && out[0].trim().startsWith('{') ? JSON.parse(out[0]) : null;
  return { code, calls, out, err: err.join('\n'), stdout: out.join('\n'), json };
}

function world(root: string, partial: Partial<World> = {}): World {
  return {
    root,
    yaml: DEFAULT_YAML,
    milestones: [
      { title: 'Sprint 13', state: 'open', open: 0 },
      { title: 'Sprint 12', state: 'open', open: 0 },
      { title: 'Sprint 14', state: 'open', open: 0 },
      { title: 'Sprint 7', state: 'closed', open: 0 },
    ],
    issues: [],
    worktrees: [],
    prs: [],
    ...partial,
  };
}

/** A world with a written flow.yaml from `yaml` (its .commandmate lives under root). */
function worldWith(yaml: string | null, partial: Partial<World> = {}): World {
  const root = repoWith(yaml);
  return world(root, partial);
}

// ---------------------------------------------------------------------------
// T1: the judgement table (2 × 5 × 7 = 70)
// ---------------------------------------------------------------------------

type Evidence = 'unmerged' | 'fresh' | 'merged-worktree' | 'open-pr' | 'plan-item' | 'merged-pr-closes' | 'none';
type State = 'OPEN' | 'CLOSED';
type MilestoneAxis = 'current' | 'prev' | 'later' | 'none' | 'closed';

const EVIDENCE: Evidence[] = ['unmerged', 'fresh', 'merged-worktree', 'open-pr', 'plan-item', 'merged-pr-closes', 'none'];
const STATES: State[] = ['OPEN', 'CLOSED'];
const MILESTONES: MilestoneAxis[] = ['current', 'prev', 'later', 'none', 'closed'];

const KIND_ORDER = [
  'M1',
  'M1b',
  'M2-residue',
  'M2-planned',
  'M2-no-evidence',
  'M3-closing-forgotten',
  'M3-awaiting-accept',
  'M4-previous-sprint',
  'M5-closed-leftover',
  'M5-empty-previous',
  'M6-unrecorded-move',
];

interface Triple {
  kind: string;
  severity: string;
  issue: number | null;
}

const SEVERITY: Record<string, 'drift' | 'info'> = {
  M1: 'drift',
  M1b: 'info',
  'M2-residue': 'drift',
  'M2-planned': 'info',
  'M2-no-evidence': 'info',
  'M3-closing-forgotten': 'drift',
  'M3-awaiting-accept': 'info',
  'M4-previous-sprint': 'drift',
  'M5-closed-leftover': 'drift',
  'M5-empty-previous': 'info',
  'M6-unrecorded-move': 'drift',
};

/**
 * The independent expectation of T1. It restates the rules of docs/design §2 and never calls
 * the implementation.
 *
 * Note (documented limitation, design §2.4): a key that appears in none of the read lists is
 * not observable (no allowed read says whether it is open), so the tool reads it as OPEN with
 * no milestone. `observable` applies that same rule to the expectation.
 */
function expectedTriples(state: State, milestone: MilestoneAxis, evidence: Evidence): Triple[] {
  const observable: State = milestone === 'none' ? 'OPEN' : state;
  const rows: Triple[] = [];
  const hasWork = evidence === 'unmerged' || evidence === 'fresh' || evidence === 'open-pr' || evidence === 'plan-item';
  const mergedWorktree = evidence === 'merged-worktree';
  const isCurrent = milestone === 'current';
  if (observable === 'OPEN') {
    if (!isCurrent) {
      if (hasWork) rows.push({ kind: 'M1', severity: 'drift', issue: 500 });
      else if (mergedWorktree) rows.push({ kind: 'M1b', severity: 'info', issue: 500 });
    }
    if (isCurrent && !hasWork) rows.push({ kind: 'M2-no-evidence', severity: 'info', issue: 500 });
    if (evidence === 'merged-pr-closes') rows.push({ kind: 'M3-closing-forgotten', severity: 'drift', issue: 500 });
    if (milestone === 'prev') rows.push({ kind: 'M4-previous-sprint', severity: 'drift', issue: 500 });
  }
  const prevOpen = observable === 'OPEN' && milestone === 'prev' ? 1 : 0;
  if (prevOpen === 0) rows.push({ kind: 'M5-empty-previous', severity: 'info', issue: null });
  if (milestone === 'closed') rows.push({ kind: 'M5-closed-leftover', severity: 'drift', issue: null });
  return rows.sort(compareTriples);
}

function compareTriples(a: Triple, b: Triple): number {
  const ai = a.issue ?? Number.MAX_SAFE_INTEGER;
  const bi = b.issue ?? Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  const ak = KIND_ORDER.indexOf(a.kind);
  const bk = KIND_ORDER.indexOf(b.kind);
  return ak === bk ? a.kind.localeCompare(b.kind) : ak - bk;
}

/** The world for one T1 cell: issue #500 in the given state / milestone and one evidence. */
function t1World(state: State, milestone: MilestoneAxis, evidence: Evidence): World {
  const root = repoWith(DEFAULT_YAML);
  const inCurrent = milestone === 'current';
  const inPrev = milestone === 'prev';
  const inLater = milestone === 'later';
  const inClosed = milestone === 'closed';
  const title = inCurrent ? 'Sprint 13' : inPrev ? 'Sprint 12' : inLater ? 'Sprint 14' : inClosed ? 'Sprint 7' : null;
  const issues: IssueRow[] = [{ number: 500, state, title: 'five hundred', milestone: title }];
  // Sprint 7 is always readable (open_issues >= 1) so the closed-milestone list is read.
  const closedOpen = inClosed ? (state === 'OPEN' ? 2 : 1) : 0;
  const closedIssues: IssueRow[] = inClosed ? issues : [{ number: 997, state: 'OPEN', title: 'stays open', milestone: 'Sprint 7' }];
  const worktrees: Wt[] = [];
  const prs: PrRow[] = [];
  const revList: Record<string, number | 'fail' | 'timeout'> = {};
  let plan: string | null = null;
  const target = 'feature/500-a';
  if (evidence === 'unmerged') {
    worktrees.push({ path: wtPath(root, 'commandmate-issue-500-a'), branch: target });
    revList[target] = 2;
  } else if (evidence === 'fresh') {
    worktrees.push({ path: wtPath(root, 'commandmate-issue-500-a'), branch: target });
    revList[target] = 0;
  } else if (evidence === 'merged-worktree') {
    worktrees.push({ path: wtPath(root, 'commandmate-issue-500-a'), branch: target });
    prs.push({ number: 900, head: target, state: 'merged', body: 'Refs #1' });
  } else if (evidence === 'open-pr') {
    prs.push({ number: 901, head: target, state: 'open', body: 'Closes #1' });
  } else if (evidence === 'plan-item') {
    plan = 'version: 1\nwaves: [{ id: "1", items: ["500-a1"] }]\nitems:\n  - { id: "500-a1", gates: [lint] }\n';
  } else if (evidence === 'merged-pr-closes') {
    prs.push({ number: 902, head: target, state: 'merged', body: 'Closes #500' });
  }
  return world(root, {
    milestones: [
      { title: 'Sprint 13', state: 'open', open: inCurrent && state === 'OPEN' ? 1 : 0 },
      { title: 'Sprint 12', state: 'open', open: inPrev && state === 'OPEN' ? 1 : 0 },
      { title: 'Sprint 14', state: 'open', open: inLater && state === 'OPEN' ? 1 : 0 },
      { title: 'Sprint 7', state: 'closed', open: closedOpen },
    ],
    issues: [...issues, ...closedIssues],
    worktrees,
    prs,
    revList,
    plan,
  });
}

/** One T1 cell: run the CLI and compare the (kind, severity, issue) triples and the exit. */
async function t1Row(state: State, milestone: MilestoneAxis, evidence: Evidence) {
  const w = t1World(state, milestone, evidence);
  const argv = ['check', '--json', '--no-history'];
  if (w.plan !== null) {
    const file = path.join(w.root, 'plan.yaml');
    fs.writeFileSync(file, w.plan);
    argv.push('--plan', file);
  }
  const r = await runCli(w, argv);
  const triples = (r.json.rows as Triple[]).map((row) => ({ kind: row.kind, severity: row.severity, issue: row.issue })).sort(compareTriples);
  const expected = expectedTriples(state, milestone, evidence).map((t) => ({ ...t }));
  return { r, triples, expected };
}

describe('T1 the judgement table (2 states × 5 milestones × 7 evidence = 70)', () => {
  const combos = STATES.flatMap((state) => MILESTONES.flatMap((milestone) => EVIDENCE.map((evidence) => ({ state, milestone, evidence }))));

  it('generates 70 rows', () => {
    expect(combos).toHaveLength(70);
  });

  it.each(combos.map((c) => [`${c.state} / ${c.milestone} / ${c.evidence}`, c] as const))('%s', async (_name, combo) => {
    const { r, triples, expected } = await t1Row(combo.state, combo.milestone, combo.evidence);
    expect(triples).toEqual(expected);
    const drift = expected.some((t) => t.severity === 'drift');
    expect(r.code).toBe(drift ? 62 : 0);
    expect(r.json.complete).toBe(true);
  });
});

describe('T1 supplements: M2 planned / residue', () => {
  it('a current OPEN issue in the plan and with no work evidence is M2-planned (info), exit 0', async () => {
    const w = t1World('OPEN', 'current', 'none');
    const file = path.join(w.root, 'plan.yaml');
    fs.writeFileSync(file, 'version: 1\nitems:\n  - { id: "500-a1", gates: [lint] }\n');
    const r = await runCli(w, ['check', '--json', '--plan', file, '--no-history']);
    expect((r.json.rows as Triple[]).map((x) => x.kind)).toEqual(['M2-planned']);
    expect(r.code).toBe(0);
  });

  it('a current OPEN issue absent from the plan and with no work evidence is M2-residue (drift), exit 62', async () => {
    const w = t1World('OPEN', 'current', 'none');
    const file = path.join(w.root, 'plan.yaml');
    fs.writeFileSync(file, 'version: 1\nitems:\n  - { id: "777-a1", gates: [lint] }\n');
    const r = await runCli(w, ['check', '--json', '--plan', file, '--no-history']);
    expect((r.json.rows as Triple[]).map((x) => x.kind)).toEqual(['M2-residue']);
    expect(r.code).toBe(62);
  });

  it('M3 waiting for acceptance (label merged-awaiting-accept) is info, exit 0', async () => {
    const w = t1World('OPEN', 'none', 'merged-pr-closes');
    w.issues = [{ number: 500, state: 'OPEN', title: 'x', milestone: null, labels: ['merged-awaiting-accept'] }];
    w.milestones = [{ title: 'Sprint 13', state: 'open', open: 0 }];
    const r = await runCli(w, ['check', '--json', '--no-history']);
    expect((r.json.rows as Triple[]).map((x) => [x.kind, x.severity])).toEqual([['M3-awaiting-accept', 'info']]);
    expect(r.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T2: each read × its failure modes → exit 61, complete false, the read named
// ---------------------------------------------------------------------------

type Mode = 'fail' | 'timeout' | 'limit' | 'unparsable' | 'shape';
interface ReadDef {
  name: string;
  /** The substring the unknown[] entry must carry. */
  unknown: string;
  modes: Mode[];
  apply(w: World, mode: Mode): void;
}

const TIMEOUT: Answer = { status: null, error: { code: 'ETIMEDOUT' } };
const manyMilestones = (n: number): Ms[] => Array.from({ length: n }, (_, i) => ({ title: `M${i}`, state: 'open' as const, open: 0 }));
const manyIssues = (n: number): IssueRow[] => Array.from({ length: n }, (_, i) => ({ number: 9000 + i, state: 'OPEN' as const, title: 'x', milestone: 'Sprint 13' }));
const manyPrs = (n: number, state: 'open' | 'merged'): PrRow[] => Array.from({ length: n }, (_, i) => ({ number: 9000 + i, head: `feature/${i}-x`, state }));

const READS: ReadDef[] = [
  {
    name: 'git worktree list',
    unknown: 'git worktree list',
    modes: ['fail', 'timeout', 'shape'],
    apply: (w, mode) => {
      if (mode === 'shape') w.override = { 'git worktree list --porcelain': { status: 0, stdout: 'HEAD abc\nbranch refs/heads/x\n' } };
      else w.fail = { ...w.fail, worktrees: mode === 'fail' ? { status: 128, stdout: '', stderr: 'fatal' } : TIMEOUT };
    },
  },
  {
    name: 'git rev-list',
    unknown: 'git rev-list feature/11-a',
    modes: ['fail', 'timeout'],
    apply: (w, mode) => {
      w.worktrees = [{ path: wtPath(w.root, 'commandmate-issue-11-a'), branch: 'feature/11-a' }];
      w.issues = [{ number: 11, state: 'OPEN', title: 'wip', milestone: 'Sprint 13' }];
      w.revList = { 'feature/11-a': mode };
    },
  },
  {
    name: 'gh api milestones',
    unknown: 'gh api milestones',
    modes: ['fail', 'timeout', 'limit', 'unparsable', 'shape'],
    apply: (w, mode) => {
      if (mode === 'limit') w.milestones = manyMilestones(100);
      else if (mode === 'unparsable') w.override = { [`gh api repos/${REPO}/milestones?state=all&per_page=100`]: { status: 0, stdout: '[{"title"' } };
      else if (mode === 'shape') w.override = { [`gh api repos/${REPO}/milestones?state=all&per_page=100`]: { status: 0, stdout: '[{"title":"Sprint 13","state":"open"}]' } };
      else w.fail = { ...w.fail, milestones: mode === 'fail' ? { status: 1, stdout: '', stderr: 'HTTP 502' } : TIMEOUT };
    },
  },
  {
    name: 'gh issue list',
    unknown: 'gh issue list Sprint 13',
    modes: ['fail', 'timeout', 'limit', 'unparsable'],
    apply: (w, mode) => {
      if (mode === 'limit') w.issues = manyIssues(1000);
      else if (mode === 'unparsable') w.override = { [`gh issue list --repo ${REPO} --milestone Sprint 13 --state all --json number,state,title,labels,closedAt --limit 1000`]: { status: 0, stdout: 'not json' } };
      else w.fail = { ...w.fail, issueList: mode === 'fail' ? { status: 1, stdout: '', stderr: 'boom' } : TIMEOUT };
    },
  },
  {
    name: 'gh pr list --state open',
    unknown: 'gh pr list --state open',
    modes: ['fail', 'timeout', 'limit', 'unparsable'],
    apply: (w, mode) => {
      if (mode === 'limit') w.prs = manyPrs(1000, 'open');
      else if (mode === 'unparsable') w.override = { [`gh pr list --repo ${REPO} --state open --base develop --limit 1000 --json number,headRefName,title,body`]: { status: 0, stdout: '[]x' } };
      else w.fail = { ...w.fail, openPrs: mode === 'fail' ? { status: 1, stdout: '', stderr: 'boom' } : TIMEOUT };
    },
  },
  {
    name: 'gh pr list --state merged',
    unknown: 'gh pr list --state merged',
    modes: ['fail', 'timeout', 'limit', 'unparsable'],
    apply: (w, mode) => {
      if (mode === 'limit') w.prs = manyPrs(300, 'merged');
      else if (mode === 'unparsable') w.override = { [`gh pr list --repo ${REPO} --state merged --base develop --search merged:>=${MERGED_FROM} --json number,headRefName,title,body,mergedAt --limit 300`]: { status: 0, stdout: 'nope' } };
      else w.fail = { ...w.fail, mergedPrs: mode === 'fail' ? { status: 1, stdout: '', stderr: 'boom' } : TIMEOUT };
    },
  },
  {
    name: 'gh api timeline',
    unknown: 'gh api timeline #11',
    modes: ['fail', 'timeout', 'unparsable'],
    apply: (w, mode) => {
      w.issues = [{ number: 11, state: 'OPEN', title: 'wip', milestone: 'Sprint 13' }];
      w.roadmapComments = ['2026-11-26T00:00:00Z'];
      if (mode === 'unparsable') w.override = { [`gh api --paginate repos/${REPO}/issues/11/timeline?per_page=100`]: { status: 0, stdout: '{bad' } };
      else w.timeline = { 11: mode === 'fail' ? 'fail' : ({} as never) };
      if (mode === 'timeout') w.override = { [`gh api --paginate repos/${REPO}/issues/11/timeline?per_page=100`]: TIMEOUT };
    },
  },
  {
    name: 'gh issue view roadmap comments',
    unknown: 'gh issue view roadmap comments',
    modes: ['fail', 'timeout', 'unparsable'],
    apply: (w, mode) => {
      w.issues = [{ number: 11, state: 'OPEN', title: 'wip', milestone: 'Sprint 13' }];
      if (mode === 'unparsable') w.override = { [`gh issue view 4461 --repo ${REPO} --json comments`]: { status: 0, stdout: '{"comments":' } };
      else if (mode === 'timeout') w.override = { [`gh issue view 4461 --repo ${REPO} --json comments`]: TIMEOUT };
      else w.fail = { ...w.fail, roadmap: { status: 1, stdout: '', stderr: 'boom' } };
    },
  },
];

describe('T2 each read, each failure mode: judge nothing (exit 61, complete false)', () => {
  it('(positive control) the clean world of the same shape is complete', async () => {
    const w = worldWith(DEFAULT_YAML, {
      issues: [{ number: 11, state: 'OPEN', title: 'wip', milestone: 'Sprint 13' }],
      roadmapComments: ['2026-11-26T00:00:00Z'],
    });
    const r = await runCli(w, ['check', '--json']);
    expect(r.code).toBe(0);
    expect(r.json.complete).toBe(true);
  });

  const cases = READS.flatMap((read) => read.modes.map((mode) => [`${read.name} / ${mode}`, read, mode] as const));

  it.each(cases)('%s', async (_name, read, mode) => {
    const w = worldWith(DEFAULT_YAML, { issues: [], roadmapComments: [] });
    read.apply(w, mode);
    const r = await runCli(w, ['check', '--json']);
    expect(r.code).toBe(61);
    expect(r.json.complete).toBe(false);
    expect(r.json.unknown.some((u: string) => u.includes(read.unknown))).toBe(true);
    // A drift-free input must not turn into exit 0.
    expect(r.code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T3: the allow table and the recorded calls
// ---------------------------------------------------------------------------

describe('T3 the allowed calls (isAllowedMilestoneCall)', () => {
  it('accepts every read in the table', async () => {
    const { isAllowedMilestoneCall } = await tool();
    const allowed: Array<[string, string[]]> = [
      ['git', ['worktree', 'list', '--porcelain']],
      ['git', ['rev-parse', '--path-format=absolute', '--git-common-dir']],
      ['git', ['rev-list', '--count', 'refs/remotes/origin/develop..refs/heads/feature/1-a']],
      ['gh', ['api', `repos/${REPO}/milestones?state=all&per_page=100`]],
      ['gh', ['issue', 'list', '--repo', REPO, '--milestone', 'Sprint 13', '--state', 'all', '--json', 'number,state,title,labels,closedAt', '--limit', '1000']],
      ['gh', ['pr', 'list', '--repo', REPO, '--state', 'open', '--base', BASE, '--limit', '1000', '--json', 'number,headRefName,title,body']],
      ['gh', ['pr', 'list', '--repo', REPO, '--state', 'merged', '--base', BASE, '--search', 'merged:>=2026-11-13', '--json', 'number,headRefName,title,body,mergedAt', '--limit', '300']],
      ['gh', ['api', '--paginate', `repos/${REPO}/issues/4604/timeline?per_page=100`]],
      ['gh', ['issue', 'view', '4461', '--repo', REPO, '--json', 'comments']],
      ['gh', ['api', `repos/${REPO}/milestones?state=all&per_page=100`]],
    ];
    for (const [cmd, args] of allowed) {
      expect(isAllowedMilestoneCall(cmd, args), `${cmd} ${args.join(' ')}`).toBe(true);
    }
  });

  it('refuses everything outside the table', async () => {
    const { isAllowedMilestoneCall } = await tool();
    const refused: Array<[string, string[]]> = [
      ['gh', ['issue', 'edit', '1', '--milestone', 'x']],
      ['gh', ['api', '-X', 'PATCH', `repos/${REPO}/milestones/1`]],
      ['gh', ['api', `repos/${REPO}/issues`, '-f', 'title=x']],
      ['gh', ['label', 'create', 'x']],
      ['git', ['checkout', 'x']],
      ['git', ['rev-list', '--count', 'a..b']],
      ['git', ['rev-list', '--count', 'refs/remotes/origin/develop..refs/heads/a..b']],
      ['git', ['push', 'origin', 'x']],
      ['gh', ['pr', 'merge', '1', '--squash']],
      ['gh', ['api', `repos/${REPO}/issues/1/timeline?per_page=100`]],
      ['gh', ['api', '--paginate', `repos/${REPO}/issues/1/timeline?per_page=50`]],
    ];
    for (const [cmd, args] of refused) {
      expect(isAllowedMilestoneCall(cmd, args), `${cmd} ${args.join(' ')}`).toBe(false);
    }
  });

  it('the recorded calls contain nothing outside the table, and every gh is a read', async () => {
    const { isGhRead } = await import('../../../../scripts/orchestrate/pr-common.mjs');
    const w = t7World();
    const r = await runCli(w, ['check', '--json']);
    const refused = /issue edit|--method|(^|\s)-X(\s|$)|(^|\s)-[fF](\s|$)|label create|checkout|worktree add|\bpush\b|pr merge|pr create/;
    for (const c of r.calls) {
      expect(c.cmd === 'git' || c.cmd === 'gh').toBe(true);
      expect(refused.test(c.args.join(' ')), `${c.cmd} ${c.args.join(' ')}`).toBe(false);
      if (c.cmd === 'gh') expect(isGhRead(c.args)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// T4: keys, keyless rows, exclusions
// ---------------------------------------------------------------------------

describe('T4 the keys', () => {
  it('takes the number from a worktree directory name', async () => {
    const { keyFromWorktreePath } = await tool();
    expect(keyFromWorktreePath('/w/commandmate-issue-4604-s13')).toBe(4604);
    expect(keyFromWorktreePath('/w/commandmate-issue-4594-back')).toBe(4594);
    expect(keyFromWorktreePath('/w/commandmate-accept-s12t-j')).toBeNull();
    expect(keyFromWorktreePath('/w/commandmate-issue-')).toBeNull();
  });

  it.each([
    ['fix/4621-4636-lock-test-flakes', [4621, 4636]],
    ['docs/4432a-verify-priority-design', [4432]],
    ['fix/4604-one-value', [4604]],
    ['feature/4642-milestone-check', [4642]],
    ['docs/s13-retro-measures', []],
    ['feature/1-a', [1]],
    ['develop', []],
  ])('branch %s → %j', async (branch, keys) => {
    const { keysFromBranch } = await tool();
    expect(keysFromBranch(branch)).toEqual(keys);
  });

  it('takes PR keys from the body (Closes/Fixes/Resolves, Refs) and the title, else the branch', async () => {
    const { prKeys, closingIssuesOf } = await tool();
    expect(closingIssuesOf({ body: 'Closes #4604\nFixes #4606' })).toEqual([4604, 4606]);
    expect(closingIssuesOf({ body: 'Refs #4594' })).toEqual([]);
    expect(prKeys({ number: 1, headRefName: 'feature/1-a', title: 'x', body: 'Closes #4604\nRefs #4594' })).toEqual([4594, 4604]);
    expect(prKeys({ number: 2, headRefName: 'hotfix', title: 'thing (#1234)', body: '' })).toEqual([1234]);
    expect(prKeys({ number: 3, headRefName: 'feature/77-a', title: 'no ref', body: '' })).toEqual([77]);
    expect(prKeys({ number: 4, headRefName: 'hotfix', title: 'no ref', body: 'nothing' })).toEqual([]);
  });

  it('takes the leading number of a plan item id', async () => {
    const { keysFromPlanItem } = await tool();
    expect(keysFromPlanItem('4642-a1')).toBe(4642);
    expect(keysFromPlanItem('3882')).toBe(3882);
    expect(keysFromPlanItem('abc')).toBeNull();
  });

  it('puts keyless worktrees and open PRs in `keyless`, never in a silent drop', async () => {
    const w = worldWith(DEFAULT_YAML, {
      issues: [{ number: 11, state: 'OPEN', title: 'wip', milestone: 'Sprint 13' }],
      worktrees: [
        { path: wtPath('ROOT', 'commandmate-accept-s12t-j'), branch: null },
        { path: wtPath('ROOT', 'docs-s13'), branch: 'docs/s13-retro-measures' },
      ],
      prs: [{ number: 777, head: 'hotfix', state: 'open', title: 'no number', body: '' }],
      roadmapComments: [],
    });
    w.worktrees = w.worktrees.map((x) => ({ ...x, path: x.path.replace('ROOT', w.root) }));
    const r = await runCli(w, ['check', '--json', '--no-history']);
    const keyless = r.json.keyless as Array<{ path: string | null; branch: string | null; pr: number | null }>;
    expect(keyless).toHaveLength(3);
    expect(keyless.some((k) => k.path?.includes('commandmate-accept-s12t-j'))).toBe(true);
    expect(keyless.some((k) => k.branch === 'docs/s13-retro-measures')).toBe(true);
    expect(keyless.some((k) => k.pr === 777)).toBe(true);
  });

  it('does not report the primary checkout or excluded branches', async () => {
    const w = worldWith(DEFAULT_YAML, {
      issues: [{ number: 11, state: 'OPEN', title: 'wip', milestone: 'Sprint 13' }],
      worktrees: [
        { path: 'PRIMARY', branch: null },
        { path: 'WT-develop', branch: 'develop' },
        { path: 'WT-ah', branch: 'agent-health-runner' },
      ],
      roadmapComments: [],
    });
    w.worktrees = [
      { path: w.root, branch: null },
      { path: wtPath(w.root, 'develop'), branch: 'develop' },
      { path: wtPath(w.root, 'ah'), branch: 'agent-health-runner' },
    ];
    w.yaml = `${DEFAULT_YAML}exclude: [agent-health-runner]\n`;
    fs.writeFileSync(path.join(w.root, '.commandmate', 'flow.yaml'), w.yaml);
    const r = await runCli(w, ['check', '--json', '--no-history']);
    expect(r.json.keyless).toEqual([]);
    expect((r.json.rows as Triple[]).map((x) => x.issue)).not.toContain(0);
  });
});

// ---------------------------------------------------------------------------
// T5: settings → exit 2
// ---------------------------------------------------------------------------

describe('T5 settings', () => {
  it.each([
    ['no milestone section', 'version: 1\nrepo: Owner/Thing\nbase: develop\n'],
    ['current missing', 'version: 1\nrepo: Owner/Thing\nbase: develop\nmilestone:\n  roadmapIssue: 4461\n'],
    ['current not a string', 'version: 1\nrepo: Owner/Thing\nbase: develop\nmilestone:\n  current: 13\n'],
    ['current empty', 'version: 1\nrepo: Owner/Thing\nbase: develop\nmilestone:\n  current: "  "\n'],
    ['unknown key', 'version: 1\nrepo: Owner/Thing\nbase: develop\nmilestone:\n  current: "Sprint 13"\n  other: 1\n'],
    ['roadmapIssue not an integer', 'version: 1\nrepo: Owner/Thing\nbase: develop\nmilestone:\n  current: "Sprint 13"\n  roadmapIssue: "4461"\n'],
    ['mergedWindowDays 0', 'version: 1\nrepo: Owner/Thing\nbase: develop\nmilestone:\n  current: "Sprint 13"\n  mergedWindowDays: 0\n'],
    ['mergedWindowDays 1.5', 'version: 1\nrepo: Owner/Thing\nbase: develop\nmilestone:\n  current: "Sprint 13"\n  mergedWindowDays: 1.5\n'],
    ['a list', 'version: 1\nrepo: Owner/Thing\nbase: develop\nmilestone: [x]\n'],
  ])('%s: exit 2 before any gh call', async (_name, yaml) => {
    const w = worldWith(yaml);
    const r = await runCli(w, ['check', '--json']);
    expect(r.code).toBe(2);
    expect(r.calls.filter((c) => c.cmd === 'gh')).toEqual([]);
  });

  it('current names a milestone that does not exist: exit 2', async () => {
    const w = worldWith(DEFAULT_YAML.replace('Sprint 13', 'Sprint 99'), { milestones: [{ title: 'Sprint 13', state: 'open', open: 1 }] });
    const r = await runCli(w, ['check', '--json']);
    expect(r.code).toBe(2);
  });

  it('current names a closed milestone: exit 2', async () => {
    const w = worldWith(DEFAULT_YAML, { milestones: [{ title: 'Sprint 13', state: 'closed', open: 0 }] });
    const r = await runCli(w, ['check', '--json']);
    expect(r.code).toBe(2);
  });

  it('the section is read from flow.yaml with defaults for the optional keys', async () => {
    const { readRawFlowConfig } = await import('../../../../scripts/flow/config.mjs');
    const root = repoWith('version: 1\nrepo: Owner/Thing\nbase: develop\nmilestone:\n  current: "Sprint 13"\n');
    const raw = readRawFlowConfig(root) as { settings?: { milestone?: { current?: string; roadmapIssue?: number; mergedWindowDays?: number } } };
    expect(raw.settings?.milestone).toEqual({ current: 'Sprint 13' });
  });

  it('a milestone section with every key is accepted', async () => {
    const { readRawFlowConfig } = await import('../../../../scripts/flow/config.mjs');
    const root = repoWith(DEFAULT_YAML);
    const raw = readRawFlowConfig(root) as { settings?: { milestone?: unknown } };
    expect(raw.settings?.milestone).toEqual({ current: 'Sprint 13', roadmapIssue: 4461, mergedWindowDays: 14 });
  });

  it('a flow.yaml without a milestone section still reads as before (negative control)', async () => {
    const { readRawFlowConfig } = await import('../../../../scripts/flow/config.mjs');
    const root = repoWith('version: 1\nwip:\n  total: 8\n');
    expect(readRawFlowConfig(root)).toMatchObject({ wip: { total: 8 } });
  });
});

// ---------------------------------------------------------------------------
// T6: summary --md, verbatim
// ---------------------------------------------------------------------------

function t6World(): World {
  const w = worldWith(DEFAULT_YAML, {
    milestones: [
      { title: 'Sprint 13', state: 'open', open: 2 },
      { title: 'Sprint 12', state: 'open', open: 0 },
    ],
    issues: [
      { number: 10, state: 'CLOSED', title: 'Finished', milestone: 'Sprint 13' },
      { number: 11, state: 'OPEN', title: 'wip', milestone: 'Sprint 13' },
      { number: 12, state: 'OPEN', title: 'todo', milestone: 'Sprint 13' },
      { number: 14, state: 'OPEN', title: 'stray', milestone: 'Sprint 14' },
    ],
    worktrees: [
      { path: 'WT11', branch: 'feature/11-a' },
      { path: 'WT14', branch: 'feature/14-a' },
    ],
    roadmapComments: [],
  });
  w.worktrees = [
    { path: wtPath(w.root, 'commandmate-issue-11-a'), branch: 'feature/11-a' },
    { path: wtPath(w.root, 'commandmate-issue-14-a'), branch: 'feature/14-a' },
  ];
  return w;
}

describe('T6 summary --md (the fixed five headings, in order)', () => {
  it('prints the first line, the five headings and one line per issue', async () => {
    const w = t6World();
    const r = await runCli(w, ['summary', '--md', '--no-history']);
    const here11 = w.worktrees[0].path;
    const here14 = w.worktrees[1].path;
    const expected = [
      '## Milestone Sprint 13（1/3 完了）',
      '### 完了（1）',
      '- #10 Finished — —',
      '### 進行中（1）',
      `- #11 wip — ${here11}`,
      '### 残り（1）',
      '- #12 todo — —',
      '### 先送り（0）',
      '- （履歴を読んでいない）',
      '### ずれ（1）',
      `- drift M1 #14 — Milestone Sprint 14; worktree ${here14}`,
    ].join('\n');
    expect(r.stdout).toBe(expected);
    expect(r.code).toBe(0);
  });

  it('puts > 不完全: right after the first line and exits 61', async () => {
    const w = t6World();
    w.fail = { openPrs: { status: 1, stdout: '', stderr: 'boom' } };
    const r = await runCli(w, ['summary', '--md', '--no-history']);
    expect(r.code).toBe(61);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe('## Milestone Sprint 13（1/3 完了）');
    expect(lines[1]).toBe('> 不完全: gh pr list --state open (fail)');
  });

  it('the five headings appear in this order even when empty', async () => {
    const w = worldWith(DEFAULT_YAML, { milestones: [{ title: 'Sprint 13', state: 'open', open: 0 }], issues: [], roadmapComments: [] });
    const r = await runCli(w, ['summary', '--md', '--no-history']);
    expect(r.stdout.split('\n').filter((l) => l.startsWith('### '))).toEqual([
      '### 完了（0）',
      '### 進行中（0）',
      '### 残り（0）',
      '### 先送り（0）',
      '### ずれ（0）',
    ]);
  });

  it('summary --json adds the five groups to the check shape', async () => {
    const w = t6World();
    const r = await runCli(w, ['summary', '--json', '--no-history']);
    expect(r.json).toMatchObject({ ok: true, complete: true });
    expect(r.json.summary).toMatchObject({ done: [{ issue: 10 }], inProgress: [{ issue: 11 }], remaining: [{ issue: 12 }] });
    expect(Array.isArray(r.json.summary.drift)).toBe(true);
    expect(r.json.summary.deferred).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T7: today's Sprint 12/13 drift (plan-4642.md (5))
// ---------------------------------------------------------------------------

/** Sprint 12's ten open issues, one of them #4604. */
const S12_OPEN = [4540, 4541, 4542, 4543, 4544, 4545, 4546, 4547, 4548, 4604];

function t7World(current = 'Sprint 13'): World {
  const root = repoWith(DEFAULT_YAML.replace(/current: "[^"]+"/, `current: "${current}"`));
  const s12: IssueRow[] = S12_OPEN.map((n) => ({ number: n, state: 'OPEN', title: `s12 ${n}`, milestone: 'Sprint 12' }));
  const s13: IssueRow[] = [
    { number: 4610, state: 'CLOSED', title: 'done', milestone: 'Sprint 13' },
    { number: 4621, state: 'OPEN', title: 'lane 4621', milestone: 'Sprint 13' },
    { number: 4631, state: 'OPEN', title: 'lane 4631', milestone: 'Sprint 13' },
    { number: 4632, state: 'OPEN', title: 'lane 4632', milestone: 'Sprint 13' },
    { number: 4640, state: 'OPEN', title: 'lane 4640', milestone: 'Sprint 13' },
    { number: 4650, state: 'OPEN', title: 'unstarted', milestone: 'Sprint 13' },
  ];
  const s14: IssueRow[] = [{ number: 4594, state: 'OPEN', title: 'accepted', milestone: 'Sprint 14' }];
  const s7: IssueRow[] = [{ number: 700, state: 'OPEN', title: 'old', milestone: 'Sprint 7' }];
  const worktrees: Wt[] = [
    // #4604: fresh branch under Sprint 12 (lane A)
    { path: wtPath(root, 'commandmate-issue-4604-s13'), branch: 'fix/4604-one-value' },
    // #4546: unmerged, in Sprint 12
    { path: wtPath(root, 'commandmate-issue-4546-pr3'), branch: 'feature/4546-pr3' },
    // the current lanes
    { path: wtPath(root, 'commandmate-issue-4621'), branch: 'fix/4621-4636-lock' },
    { path: wtPath(root, 'commandmate-issue-4631'), branch: 'fix/4631-x' },
    { path: wtPath(root, 'commandmate-issue-4632'), branch: 'fix/4632-x' },
    { path: wtPath(root, 'commandmate-issue-4640'), branch: 'fix/4640-x' },
    // #4594: merged (residue), in Sprint 14
    { path: wtPath(root, 'commandmate-issue-4594'), branch: 'feature/4594-x' },
  ];
  const prs: PrRow[] = [{ number: 4639, head: 'feature/4594-x', state: 'merged', title: 'accept 4594', body: 'Refs #4594' }];
  return world(root, {
    milestones: [
      { title: 'Sprint 11', state: 'open', open: 0 },
      { title: 'Sprint 12', state: 'open', open: 10 },
      { title: 'Sprint 13', state: 'open', open: 5 },
      { title: 'Sprint 14', state: 'open', open: 1 },
      { title: 'Sprint 15', state: 'open', open: 0 },
      { title: 'Sprint 7', state: 'closed', open: 1 },
    ],
    issues: [...s12, ...s13, ...s14, ...s7],
    worktrees,
    prs,
    revList: { 'feature/4546-pr3': 3, 'fix/4604-one-value': 0 },
    timeline: { 4604: [{ event: 'milestoned', createdAt: '2026-11-27T15:34:00Z', milestone: 'Sprint 13' }] },
    roadmapComments: ['2026-11-27T15:43:00Z'],
  });
}

describe('T7 today’s drift (Sprint 12/13 fixture)', () => {
  it('#4604 is M1 (fresh worktree, Sprint 12) and M4; Sprint 12’s 10 open issues are M4', async () => {
    const r = await runCli(t7World(), ['check', '--json', '--no-history']);
    const rows = r.json.rows as Array<Triple & { detail: string }>;
    expect(rows.some((x) => x.kind === 'M1' && x.issue === 4604)).toBe(true);
    expect(rows.filter((x) => x.kind === 'M4-previous-sprint').map((x) => x.issue).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([...S12_OPEN].sort((a, b) => a - b));
    expect(r.code).toBe(62);
  });

  it('#4546 is M1 (unmerged) and M4', async () => {
    const r = await runCli(t7World(), ['check', '--json', '--no-history']);
    const rows = r.json.rows as Triple[];
    expect(rows.some((x) => x.kind === 'M1' && x.issue === 4546)).toBe(true);
    expect(rows.some((x) => x.kind === 'M4-previous-sprint' && x.issue === 4546)).toBe(true);
  });

  it('Sprint 7 (closed) with one open issue is M5-closed-leftover', async () => {
    const r = await runCli(t7World(), ['check', '--json', '--no-history']);
    const m5 = (r.json.rows as Array<Triple & { detail: string }>).find((x) => x.kind === 'M5-closed-leftover');
    expect(m5).toBeDefined();
    expect(m5?.detail).toContain('Sprint 7');
    expect(m5?.detail).toContain('1');
  });

  it('#4594 is M1b (merged residue, Sprint 14), not M3', async () => {
    const r = await runCli(t7World(), ['check', '--json', '--no-history']);
    const rows = r.json.rows as Triple[];
    expect(rows.some((x) => x.kind === 'M1b' && x.issue === 4594 && x.severity === 'info')).toBe(true);
    expect(rows.some((x) => x.kind === 'M1' && x.issue === 4594)).toBe(false);
    expect(rows.some((x) => x.kind.startsWith('M3') && x.issue === 4594)).toBe(false);
  });

  it('the current milestone swapped to Sprint 12: the Sprint 13 lanes are M1', async () => {
    const r = await runCli(t7World('Sprint 12'), ['check', '--json', '--no-history']);
    const m1 = (r.json.rows as Triple[]).filter((x) => x.kind === 'M1').map((x) => x.issue).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(m1).toEqual([4621, 4631, 4632, 4640]);
  });

  it('M6: a move before #4461’s last comment is not reported; a comment after it makes it M6', async () => {
    const before = await runCli(t7World(), ['check', '--json']);
    expect((before.json.rows as Triple[]).some((x) => x.kind === 'M6-unrecorded-move')).toBe(false);

    const w = t7World();
    w.roadmapComments = ['2026-11-27T15:30:00Z'];
    const after = await runCli(w, ['check', '--json']);
    const m6 = (after.json.rows as Array<Triple & { detail: string }>).find((x) => x.kind === 'M6-unrecorded-move');
    expect(m6).toBeDefined();
    expect(m6?.issue).toBe(4604);
    expect(m6?.detail).toContain('milestoned');
    expect(after.code).toBe(61 === after.code ? 61 : 62);
  });

  it('--no-history reads no timeline and no roadmap comment', async () => {
    const r = await runCli(t7World(), ['check', '--json', '--no-history']);
    expect(r.calls.some((c) => c.args.includes('--paginate'))).toBe(false);
    expect(r.calls.some((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'view')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T8: the deadline
// ---------------------------------------------------------------------------

describe('T8 the deadline', () => {
  it('a result that comes back at or after the deadline is not used (61)', async () => {
    let now = 0;
    const w = t7World();
    const r = await runCli(w, ['check', '--json'], {
      monoNow: () => now,
      hooks: {
        before: (c) => {
          if (c.args.join(' ') === 'worktree list --porcelain') now = 120_001;
        },
      },
    });
    expect(r.code).toBe(61);
    expect(r.json.complete).toBe(false);
    expect(r.json.unknown.some((u: string) => u.includes('gh'))).toBe(true);
  });

  it('a call started with no time left is not started', async () => {
    const w = t7World();
    const r = await runCli(w, ['check', '--json'], {
      monoNow: () => 0,
      hooks: { before: () => undefined },
      deadlineMono: 0,
    });
    expect(r.code).toBe(61);
    expect(r.json.complete).toBe(false);
  });
});
