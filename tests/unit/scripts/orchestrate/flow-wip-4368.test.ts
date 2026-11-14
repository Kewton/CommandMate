/**
 * flow-wip.mjs: count and the advisory check (Issue #4368 PR1, docs/design/flow-wip-4368.md
 * §11.1〜§11.5). Every git / gh answer is the raw text the real command prints
 * (`git worktree list --porcelain`, `gh pr list --json …`), fed through a fake spawnSync;
 * nothing reaches GitHub, no worktree is created, and the only files are under os.tmpdir().
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT_WIP_FULL,
  EXIT_WIP_UNKNOWN,
  countWip,
  decideCheck,
  isAllowedWipCall,
  main,
  makeRunner,
  parseArgs,
  parseWorktreePorcelain,
} from '../../../../scripts/orchestrate/flow-wip.mjs';
import { isGhRead } from '../../../../scripts/orchestrate/pr-common.mjs';

const REPO = 'Owner/Thing';
const ORIGIN = 'git@github.com:Owner/Thing.git';
const sha = (c: string) => c.repeat(40).slice(0, 40);
const BASE_SHA = sha('b');

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
interface Branch {
  name: string;
  /** tips read in order (the before / after reads); one value = stable. */
  tips: string[];
}
interface PrJson {
  number: number;
  headRefName: string;
  headRefOid: string;
  baseRefName?: string;
  isCrossRepository?: boolean;
  headRepositoryOwner?: { login: string } | null;
  mergedAt?: string;
}
interface World {
  root: string;
  branches: Branch[];
  detached?: number;
  openPrs: PrJson[];
  mergedWindow: PrJson[];
  /** per-branch merged search answers; default = []. */
  mergedByBranch?: Record<string, Answer>;
  /** origin/<base> local sha; null = missing. */
  localBase?: string | null;
  /** GitHub's base sha answer. */
  githubBase?: Answer;
  /** merge-base --is-ancestor exit per tip; default 1. */
  ancestor?: Record<string, number>;
  /** override any answer (by "cmd args" key). */
  override?: Record<string, Answer>;
}

const temps: string[] = [];
let savedHome: string | undefined;
let savedLockRoot: string | undefined;
let home: string;
let lockRoot: string;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedLockRoot = process.env.CM_VERIFY_LOCK_ROOT;
  home = mkTemp('wip-4368-home-');
  lockRoot = mkTemp('wip-4368-lock-');
  process.env.HOME = home;
  process.env.CM_VERIFY_LOCK_ROOT = lockRoot;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedLockRoot === undefined) delete process.env.CM_VERIFY_LOCK_ROOT;
  else process.env.CM_VERIFY_LOCK_ROOT = savedLockRoot;
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function mkTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function repoWith(yaml: string | null): string {
  const root = mkTemp('wip-4368-repo-');
  if (yaml !== null) {
    fs.mkdirSync(path.join(root, '.commandmate'));
    fs.writeFileSync(path.join(root, '.commandmate', 'flow.yaml'), yaml);
  }
  return root;
}

const wtPath = (root: string, name: string) => path.join(path.dirname(root), `wt-${name.replace(/\//g, '-')}`);

function porcelain(world: World): string {
  const blocks = [`worktree ${world.root}\nHEAD ${BASE_SHA}\nbranch refs/heads/develop\n`];
  for (const b of world.branches) blocks.push(`worktree ${wtPath(world.root, b.name)}\nHEAD ${b.tips[0]}\nbranch refs/heads/${b.name}\n`);
  for (let i = 0; i < (world.detached ?? 0); i++) blocks.push(`worktree /tmp/detached-${i}\nHEAD ${sha('d')}\ndetached\n`);
  return blocks.join('\n');
}

const json = (rows: PrJson[]) =>
  JSON.stringify(rows.map((r) => ({ baseRefName: 'develop', isCrossRepository: false, ...r })));
const merged = (headRefName: string, headRefOid: string, extra: Partial<PrJson> = {}): PrJson => ({
  number: 100 + headRefName.length,
  headRefName,
  headRefOid,
  mergedAt: '2026-11-13T10:00:00Z',
  ...extra,
});
const openPr = (headRefName: string, extra: Partial<PrJson> = {}): PrJson => ({
  number: 200 + headRefName.length,
  headRefName,
  headRefOid: sha('e'),
  headRepositoryOwner: { login: 'Owner' },
  ...extra,
});

/** A spawnSync that answers from `world`, recording each call. */
function fakeSpawn(world: World, calls: Call[], hooks: { before?: (c: Call) => void } = {}) {
  const tipReads: Record<string, number> = {};
  return (cmd: string, args: string[], options: { cwd?: string; timeout?: number }): Answer => {
    const call = { cmd, args: [...args], cwd: options.cwd, timeout: options.timeout };
    calls.push(call);
    hooks.before?.(call);
    const key = `${cmd} ${args.join(' ')}`;
    if (world.override?.[key]) return world.override[key];
    const ok = (stdout: string): Answer => ({ status: 0, stdout, stderr: '' });
    if (cmd === 'git') {
      if (key === 'git rev-parse --path-format=absolute --git-common-dir') return ok(`${world.root}/.git\n`);
      if (key === 'git remote get-url origin') return ok(`${ORIGIN}\n`);
      if (key === 'git rev-parse --verify refs/remotes/origin/develop') {
        if (world.localBase === null) return { status: 128, stdout: '', stderr: 'fatal' };
        return ok(`${world.localBase ?? BASE_SHA}\n`);
      }
      if (key === 'git worktree list --porcelain') return ok(porcelain(world));
      if (key === 'git rev-parse HEAD') {
        const branch = world.branches.find((b) => wtPath(world.root, b.name) === options.cwd);
        if (!branch) return { status: 128, stdout: '', stderr: 'fatal' };
        const n = tipReads[branch.name] ?? 0;
        tipReads[branch.name] = n + 1;
        return ok(`${branch.tips[Math.min(n, branch.tips.length - 1)]}\n`);
      }
      if (args[0] === 'merge-base') return { status: world.ancestor?.[args[2]] ?? 1, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: `unexpected ${key}` };
    }
    if (cmd === 'gh') {
      if (args[0] === 'api') return world.githubBase ?? ok(`${BASE_SHA}\n`);
      const state = args[args.indexOf('--state') + 1];
      if (state === 'open') return ok(json(world.openPrs));
      if (args.includes('--head')) {
        const head = args[args.indexOf('--head') + 1];
        return world.mergedByBranch?.[head] ?? ok('[]');
      }
      return ok(json(world.mergedWindow));
    }
    return { status: 127, stdout: '', stderr: 'not found' };
  };
}

function world(root: string, partial: Partial<World> = {}): World {
  return { root, branches: [], openPrs: [], mergedWindow: [], ...partial };
}

const branch = (name: string, ...tips: string[]): Branch => ({ name, tips: tips.length ? tips : [sha('1')] });

function runCli(w: World, argv: string[], extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, {
    spawnSync: fakeSpawn(w, calls, (extra.hooks as { before?: (c: Call) => void }) ?? {}),
    monoNow: (extra.monoNow as () => number) ?? (() => 0),
    wallNow: () => Date.parse('2026-11-14T00:00:00Z'),
    cwd: w.root,
    env: {},
    stdout: (l: string) => out.push(l),
    stderr: (l: string) => err.push(l),
    ...(extra.deadlineMono !== undefined ? { deadlineMono: extra.deadlineMono } : {}),
  });
  const parsed = out.length ? JSON.parse(out[0]) : null;
  return { code, calls, out, err: err.join('\n'), json: parsed };
}

const LIMIT3 = 'wip:\n  total: 3\n';
const threeBranches = () => [branch('feature/1-a', sha('1')), branch('feature/2-b', sha('2')), branch('feature/3-c', sha('3'))];

describe('11.1 count and check (countWip・decideCheck・main)', () => {
  it('N1 complete, C 2 of 3: room / 0', () => {
    const r = runCli(world(repoWith(LIMIT3), { branches: threeBranches().slice(0, 2) }), ['check', '--json']);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ verdict: 'room', total: 3, complete: true });
    expect(r.json.unmerged).toHaveLength(2);
  });

  it('N2 complete, C 3 of 3 (exactly the limit): full / 60', () => {
    const r = runCli(world(repoWith(LIMIT3), { branches: threeBranches() }), ['check', '--json']);
    expect(r.code).toBe(EXIT_WIP_FULL);
    expect(r.json.verdict).toBe('full');
    expect(r.err).toContain('WIP full for Owner/Thing (base develop): 3/3');
  });

  it('N3 complete, C 5 (over): full / 60, an open PR without a worktree counts too', () => {
    const w = world(repoWith(LIMIT3), { branches: threeBranches(), openPrs: [openPr('feature/4-d'), openPr('feature/5-e')] });
    const r = runCli(w, ['check', '--json']);
    expect(r.code).toBe(60);
    expect(r.json.unmerged).toHaveLength(5);
  });

  it('N4 3 → one squash-merged (headRefOid = tip, same base, same repo): 2, room / 0', () => {
    const w = world(repoWith(LIMIT3), { branches: threeBranches(), mergedWindow: [merged('feature/2-b', sha('2'))] });
    const r = runCli(w, ['check', '--json']);
    expect(r.code).toBe(0);
    expect(r.json.unmerged).toEqual(['feature/1-a', 'feature/3-c']);
  });

  it('N5 one unknown, upper bound 2 < 3: unknown / 61 (not room)', () => {
    const w = world(repoWith(LIMIT3), {
      branches: threeBranches().slice(0, 2),
      mergedByBranch: { 'feature/1-a': { status: 1, stdout: '', stderr: 'HTTP 502' } },
    });
    const r = runCli(w, ['check', '--json']);
    expect(r.code).toBe(EXIT_WIP_UNKNOWN);
    expect(r.json).toMatchObject({ verdict: 'unknown', complete: false, unknown: ['feature/1-a'] });
  });

  it('N6 one unknown, upper bound 3: unknown / 61 (not full)', () => {
    const w = world(repoWith(LIMIT3), {
      branches: threeBranches(),
      mergedByBranch: { 'feature/1-a': { status: 1, stdout: '', stderr: 'HTTP 502' } },
    });
    expect(runCli(w, ['check', '--json']).code).toBe(61);
  });

  it('N7 off (no flow.yaml, or no wip section): 0, says off', () => {
    for (const yaml of [null, 'base: develop\n']) {
      const r = runCli(world(repoWith(yaml), { branches: threeBranches() }), ['check', '--json']);
      expect(r.code).toBe(0);
      expect(r.json.verdict).toBe('off');
      expect(r.err).toContain('wip: off');
    }
  });

  it('N8 an excluded branch (agent-health-runner) and the base are not counted', () => {
    const w = world(repoWith(`exclude: [agent-health-runner]\n${LIMIT3}`), {
      branches: [...threeBranches().slice(0, 2), branch('agent-health-runner', sha('4'))],
    });
    const r = runCli(w, ['check', '--json']);
    expect(r.code).toBe(0);
    expect(r.json.excluded).toEqual(expect.arrayContaining(['develop', 'agent-health-runner']));
    expect(r.json.unmerged).not.toContain('agent-health-runner');
  });

  it('N9 room says advisory, not a permit or reservation, and the observation window', () => {
    const r = runCli(world(repoWith(LIMIT3), { branches: threeBranches().slice(0, 1) }), ['check', '--json']);
    expect(r.json).toMatchObject({ advisory: true, observedFrom: '2026-11-14T00:00:00.000Z', observedTo: '2026-11-14T00:00:00.000Z' });
    expect(r.err).toContain('not a permit or reservation');
    expect(r.err).toContain('observed 2026-11-14T00:00:00.000Z–');
  });

  it('N10 count works with the limit off and returns the counted shape', () => {
    const r = runCli(world(repoWith(null), { branches: threeBranches() }), ['count', '--json']);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, repo: REPO, base: 'develop', active: null, complete: true, unknown: [] });
    expect(r.json.unmerged).toHaveLength(3);
  });

  it('decideCheck: >= total is full (mutation `>` would make 3/3 room)', () => {
    const count = { unmerged: ['a', 'b', 'c'], active: null, unknown: [], excluded: [], complete: true };
    expect(decideCheck({ count, total: 3 })).toEqual({ verdict: 'full', exit: 60 });
    expect(decideCheck({ count, total: 4 })).toEqual({ verdict: 'room', exit: 0 });
    expect(decideCheck({ count: { ...count, unknown: ['a'], complete: false }, total: 10 })).toEqual({ verdict: 'unknown', exit: 61 });
  });

  it('countWip: a worktree branch with an open PR is counted once; a fork PR is its own key', () => {
    const input = {
      repo: REPO,
      base: 'develop',
      exclude: ['develop'],
      worktrees: [{ path: '/w', branch: 'feature/x', head: null }],
      openPrs: [
        { number: 1, headRefName: 'feature/x', headOwner: 'Owner', isCrossRepository: false, baseRefName: 'develop', headRefOid: sha('1') },
        { number: 2, headRefName: 'feature/x', headOwner: 'fork', isCrossRepository: true, baseRefName: 'develop', headRefOid: sha('2') },
      ],
      merged: {},
      observedFrom: '',
      observedTo: '',
    };
    expect(countWip(input).unmerged).toEqual(['feature/x', 'fork:feature/x']);
  });
});

describe('11.2 merge proof from raw gh / git output', () => {
  const one = (partial: Partial<World>, tips: string[] = [sha('1')]) =>
    runCli(world(repoWith(LIMIT3), { branches: [branch('c', ...tips)], ...partial }), ['count', '--json']).json;

  it('E1 MERGED with head c, base develop, tip X, same repo; not an ancestor: not counted', () => {
    expect(one({ mergedWindow: [merged('c', sha('1'))] }).unmerged).toEqual([]);
  });

  it('E2 the tip moved after the merge (Y ≠ X): counted', () => {
    expect(one({ mergedWindow: [merged('c', sha('9'))] }).unmerged).toEqual(['c']);
  });

  it('E3 two MERGED: the newer to main, the older to develop; the develop one proves it', () => {
    const rows = [merged('c', sha('1'), { baseRefName: 'main', number: 9 }), merged('c', sha('1'), { number: 3 })];
    expect(one({ mergedWindow: rows }).unmerged).toEqual([]);
  });

  it('E4 only a MERGED to main: counted', () => {
    expect(one({ mergedWindow: [merged('c', sha('1'), { baseRefName: 'main' })] }).unmerged).toEqual(['c']);
  });

  it('E5 a fork PR with the same name and tip: counted', () => {
    expect(one({ mergedWindow: [merged('c', sha('1'), { isCrossRepository: true })] }).unmerged).toEqual(['c']);
  });

  it('E6 not in the window, found by the per-branch search: not counted', () => {
    expect(one({ mergedByBranch: { c: { status: 0, stdout: json([merged('c', sha('1'))]) } } }).unmerged).toEqual([]);
  });

  it('E7 the per-branch search hit its limit: counted and unknown', () => {
    const many = Array.from({ length: 100 }, (_, i) => merged('c', sha('9'), { number: i + 1 }));
    const r = one({ mergedByBranch: { c: { status: 0, stdout: json(many) } } });
    expect(r).toMatchObject({ unmerged: ['c'], unknown: ['c'], complete: false });
  });

  it('E8 an ancestor of origin/develop that equals GitHub: not counted', () => {
    expect(one({ ancestor: { [sha('1')]: 0 } }).unmerged).toEqual([]);
  });

  it('E9 an ancestor, but origin/develop ≠ GitHub: counted (and merge-base not asked)', () => {
    const r = runCli(world(repoWith(LIMIT3), { branches: [branch('c')], ancestor: { [sha('1')]: 0 }, githubBase: { status: 0, stdout: `${sha('f')}\n` } }), ['count', '--json']);
    expect(r.json.unmerged).toEqual(['c']);
    expect(r.json.complete).toBe(true);
    expect(r.calls.some((c) => c.args[0] === 'merge-base')).toBe(false);
  });

  it('E10 an ancestor, GitHub sha unreadable: counted', () => {
    expect(one({ ancestor: { [sha('1')]: 0 }, githubBase: { status: 1, stdout: '', stderr: 'HTTP 502' } }).unmerged).toEqual(['c']);
  });

  it('E11 the tip differs before and after the proofs: unknown and counted', () => {
    const r = one({ mergedWindow: [merged('c', sha('1'))] }, [sha('1'), sha('2')]);
    expect(r).toMatchObject({ unmerged: ['c'], unknown: ['c'], complete: false });
  });
});

describe('11.3 completeness of the input (readWipInput)', () => {
  const check = (partial: Partial<World>) => runCli(world(repoWith(LIMIT3), { branches: threeBranches().slice(0, 1), ...partial }), ['check', '--json']);

  it('R1 git worktree list fails: 61, source git worktree list (not an empty W)', () => {
    const r = check({ override: { 'git worktree list --porcelain': { status: 128, stdout: '', stderr: 'fatal' } } });
    expect(r.code).toBe(61);
    expect(r.json).toMatchObject({ verdict: 'unknown', source: 'git worktree list' });
  });

  it('R2 the open-PR read fails: 61, asked once (no retry)', () => {
    const key = `gh pr list --repo ${REPO} --state open --base develop --limit 1000 --json number,headRefName,headRefOid,headRepositoryOwner,isCrossRepository,baseRefName`;
    const r = check({ override: { [key]: { status: 1, stdout: '', stderr: 'HTTP 502' } } });
    expect(r.code).toBe(61);
    expect(r.calls.filter((c) => c.cmd === 'gh' && c.args.includes('open'))).toHaveLength(1);
  });

  it('R3 open PRs = --limit: 61 truncated', () => {
    const many = Array.from({ length: 1000 }, (_, i) => openPr(`f/${i}`, { number: i + 1 }));
    expect(check({ openPrs: many }).json).toMatchObject({ reason: 'truncated' });
  });

  it('R4 an open PR row without headRefName: 61 shape', () => {
    const bad = [{ number: 1, headRefOid: sha('1'), headRepositoryOwner: { login: 'Owner' } } as unknown as PrJson];
    expect(check({ openPrs: bad }).json).toMatchObject({ reason: 'shape' });
  });

  it('R5 the open-PR JSON cut half way: 61 shape', () => {
    const key = `gh pr list --repo ${REPO} --state open --base develop --limit 1000 --json number,headRefName,headRefOid,headRepositoryOwner,isCrossRepository,baseRefName`;
    expect(check({ override: { [key]: { status: 0, stdout: '[{"number":1,"headRef' } } }).json).toMatchObject({ reason: 'shape' });
  });

  it('R6 a porcelain block without a worktree line: 61 shape; a detached block is skipped', () => {
    expect(parseWorktreePorcelain('HEAD abc\nbranch refs/heads/x\n')).toBeNull();
    expect(parseWorktreePorcelain(`worktree /a\nHEAD ${sha('1')}\ndetached\n`)).toEqual([{ path: '/a', branch: null, head: sha('1') }]);
    const r = check({ override: { 'git worktree list --porcelain': { status: 0, stdout: 'HEAD abc\nbranch refs/heads/x\n' } } });
    expect(r.json).toMatchObject({ source: 'git worktree list', reason: 'shape' });
    expect(runCli(world(repoWith(LIMIT3), { branches: [], detached: 3 }), ['check', '--json']).json.unmerged).toEqual([]);
  });

  it('R7 merge-base fails for one branch only: ok, that branch unknown', () => {
    const w = world(repoWith(LIMIT3), { branches: [branch('a', sha('1')), branch('b', sha('2'))], ancestor: { [sha('1')]: 128 } });
    const r = runCli(w, ['count', '--json']);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, unknown: ['a'], unmerged: ['a', 'b'], complete: false });
  });

  it('R8 off check: no gh, no remote get-url, no symbolic-ref', () => {
    const r = runCli(world(repoWith(null), { branches: threeBranches() }), ['check']);
    expect(r.code).toBe(0);
    expect(r.calls.filter((c) => c.cmd === 'gh')).toEqual([]);
    expect(r.calls.some((c) => c.args.join(' ') === 'remote get-url origin' || c.args[0] === 'symbolic-ref')).toBe(false);
    expect(r.calls.map((c) => c.args.join(' '))).toEqual(['rev-parse --path-format=absolute --git-common-dir']);
  });

  it('R9 the call list: flow-wip git is rev-parse / worktree list / merge-base, gh only reads', () => {
    const w = world(repoWith(LIMIT3), { branches: threeBranches(), ancestor: {} });
    const r = runCli(w, ['check']);
    const identification = new Set(['remote get-url origin', 'rev-parse --verify refs/remotes/origin/develop', 'symbolic-ref refs/remotes/origin/HEAD']);
    const own = r.calls.filter((c) => c.cmd === 'git' && !identification.has(c.args.join(' ')));
    expect(new Set(own.map((c) => c.args[0] === 'worktree' ? 'worktree list' : c.args[0]))).toEqual(new Set(['rev-parse', 'worktree list', 'merge-base']));
    expect(r.calls.filter((c) => c.cmd === 'gh').every((c) => isGhRead(c.args))).toBe(true);
    expect(r.calls.every((c) => c.cmd === 'git' || c.cmd === 'gh')).toBe(true);
    // A writing call is refused without a child.
    expect(isAllowedWipCall('git', ['worktree', 'add', '/x'])).toBe(false);
    expect(isAllowedWipCall('git', ['push', 'origin', 'x'])).toBe(false);
    expect(isAllowedWipCall('gh', ['pr', 'create', '--repo', REPO, '--base', 'develop', '--json', 'x', '--limit', '1'])).toBe(false);
    expect(isAllowedWipCall('gh', ['api', `repos/${REPO}/branches/develop`, '-X', 'POST'])).toBe(false);
  });

  it('R10 a linked worktree reads the main root flow.yaml, never its own', () => {
    const root = repoWith(LIMIT3);
    const linked = mkTemp('wip-4368-linked-');
    fs.mkdirSync(path.join(linked, '.commandmate'));
    fs.writeFileSync(path.join(linked, '.commandmate', 'flow.yaml'), 'wip:\n  total: 1000\n');
    const w = world(root, { branches: threeBranches() });
    const calls: Call[] = [];
    const err: string[] = [];
    const out: string[] = [];
    const code = main(['check', '--worktree', linked, '--json'], {
      spawnSync: fakeSpawn(w, calls),
      monoNow: () => 0,
      cwd: linked,
      env: {},
      stdout: (l: string) => out.push(l),
      stderr: (l: string) => err.push(l),
    });
    expect(code).toBe(60);
    expect(JSON.parse(out[0]).total).toBe(3);
    expect(calls[0].cwd).toBe(linked);
  });

  it('settings: wip.active is 2 and names PR2a; a bad total is 2', () => {
    const a = runCli(world(repoWith('wip:\n  total: 3\n  active: 2\n')), ['check']);
    expect(a.code).toBe(2);
    expect(a.err).toContain('PR2a');
    expect(runCli(world(repoWith('wip:\n  total: 0\n')), ['check']).code).toBe(2);
    expect(runCli(world(repoWith('wip:\n  total: 0\n')), ['count']).code).toBe(2);
  });
});

describe('11.4 the deadline', () => {
  function runner(nowValues: number[]) {
    const calls: Call[] = [];
    let i = 0;
    const monoNow = () => nowValues[Math.min(i++, nowValues.length - 1)];
    const run = makeRunner({
      spawnSync: (cmd: string, args: string[], o: { timeout?: number }) => {
        calls.push({ cmd, args, timeout: o.timeout });
        return { status: 0, stdout: '', stderr: '' };
      },
      monoNow,
    });
    return { run, calls };
  }
  const call = (run: ReturnType<typeof makeRunner>) => run('git', ['worktree', 'list', '--porcelain'], { capMs: 10_000, deadlineMono: 100 });

  it.each([
    ['D1 −1 ms', 101],
    ['D2 0 ms exactly', 100],
    ['D3 0.6 ms (floors to 0)', 99.4],
  ])('%s left: no child (no timeout: 0)', (_name, now) => {
    const { run, calls } = runner([now]);
    expect(call(run)).toMatchObject({ status: 'timeout', skipped: true, called: false });
    expect(calls).toEqual([]);
  });

  it('D4 1 ms left: one child with timeout 1', () => {
    const { run, calls } = runner([99, 99.5]);
    expect(call(run).status).toBe('ok');
    expect(calls).toEqual([expect.objectContaining({ timeout: 1 })]);
  });

  it('D1 (in the CLI) the per-branch search right at the deadline: the branch is unknown, no child for it', () => {
    let now = 0;
    const w = world(repoWith(LIMIT3), { branches: [branch('c')] });
    const r = runCli(w, ['count', '--json'], {
      monoNow: () => now,
      hooks: { before: (c: Call) => { if (c.args.join(' ') === 'rev-parse HEAD') now = 120_001; } },
    });
    expect(r.json).toMatchObject({ unknown: ['c'], complete: false });
    expect(r.calls.some((c) => c.args.includes('--head'))).toBe(false);
  });

  it('D5 gh does not return (ETIMEDOUT): 61 with the source and timeout', () => {
    const key = `gh pr list --repo ${REPO} --state open --base develop --limit 1000 --json number,headRefName,headRefOid,headRepositoryOwner,isCrossRepository,baseRefName`;
    const r = runCli(world(repoWith(LIMIT3), { override: { [key]: { status: null, error: { code: 'ETIMEDOUT' } } } }), ['check', '--json']);
    expect(r.code).toBe(61);
    expect(r.json).toMatchObject({ source: 'gh pr list --state open', reason: 'timeout' });
  });

  it('D6 a success that came back after the deadline is dropped: 61, not room', () => {
    let now = 0;
    const r = runCli(world(repoWith(LIMIT3)), ['check', '--json'], {
      monoNow: () => now,
      hooks: { before: (c: Call) => { if (c.args.includes('open')) now = 120_000; } },
    });
    expect(r.code).toBe(61);
    expect(r.json.reason).toBe('timeout');
  });

  it('D7 a shorter caller deadline wins over --deadline-sec', () => {
    const r = runCli(world(repoWith(LIMIT3)), ['check', '--deadline-sec', '120'], { deadlineMono: 5_000 });
    expect(Math.max(...r.calls.map((c) => c.timeout ?? 0))).toBeLessThanOrEqual(5_000);
  });

  it('D8 after a 61 nothing is asked again', () => {
    const key = `gh pr list --repo ${REPO} --state open --base develop --limit 1000 --json number,headRefName,headRefOid,headRepositoryOwner,isCrossRepository,baseRefName`;
    const r = runCli(world(repoWith(LIMIT3), { override: { [key]: { status: 1, stdout: '', stderr: 'boom' } } }), ['check']);
    expect(r.code).toBe(61);
    expect(r.calls.filter((c) => c.cmd === 'gh')).toHaveLength(1);
    expect(r.calls.at(-1)?.cmd).toBe('gh');
  });

  it('every call carries SIGKILL-bounded positive timeout ≤ its cap', () => {
    const r = runCli(world(repoWith(LIMIT3), { branches: threeBranches() }), ['check']);
    for (const c of r.calls) {
      expect(c.timeout).toBeGreaterThanOrEqual(1);
      expect(c.timeout).toBeLessThanOrEqual(c.cmd === 'gh' ? 30_000 : 10_000);
    }
  });
});

describe('11.5 read only, and the limit of concurrency', () => {
  it('T10 two checks on the same observation (C 2, total 3) both say room — the limit this PR does not guard', () => {
    const w = world(repoWith(LIMIT3), { branches: threeBranches().slice(0, 2) });
    expect(runCli(w, ['check']).code).toBe(0);
    expect(runCli(w, ['check']).code).toBe(0);
  });

  it('T10b count and check write nothing under HOME or the lock root and call no writing operation', () => {
    const w = world(repoWith(LIMIT3), { branches: threeBranches() });
    const all = [...runCli(w, ['count']).calls, ...runCli(w, ['check']).calls];
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.readdirSync(lockRoot)).toEqual([]);
    const joined = all.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(joined.filter((s) => /worktree add|\bpush\b|pr create|\bsend\b/.test(s))).toEqual([]);
    expect(fs.readdirSync(w.root)).toEqual(['.commandmate']);
  });
});

describe('arguments', () => {
  it.each([
    [['check', '--gate', 'send']],
    [['check', '--branch', 'x']],
    [['check', '--wt', 'x']],
    [['check', '--add', '1']],
    [['check', '--deadline-sec', '0']],
    [['check', '--deadline-sec', '1.5']],
    [['check', '--deadline-sec', 'abc']],
    [['admit']],
    [[]],
  ])('%j is a usage error', (argv) => {
    expect(parseArgs(argv)).toHaveProperty('error');
  });

  it('accepts the documented forms', () => {
    expect(parseArgs(['check', '--worktree', '.', '--json'])).toEqual({ options: { command: 'check', worktree: '.', deadlineSec: 120, json: true } });
    expect(parseArgs(['count', '--deadline-sec', '30'])).toEqual({ options: { command: 'count', worktree: null, deadlineSec: 30, json: false } });
  });

  it('a usage error exits 2 before any call', () => {
    const r = runCli(world(repoWith(LIMIT3)), ['check', '--gate', 'send']);
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
  });

  it('flow-wip.mjs carries no repository-specific value', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../../scripts/orchestrate/flow-wip.mjs'), 'utf8');
    expect(source).not.toContain('Kewton/CommandMate');
    expect(source).not.toMatch(/develop/);
  });
});
