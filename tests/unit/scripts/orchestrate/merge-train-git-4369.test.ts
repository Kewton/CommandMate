/**
 * scripts/orchestrate/merge-train.mjs with real git (Issue #4369, docs/design/merge-train-4369.md §10
 * T-T and T-P P1-P7・P9): the squash replay chain against `git merge --squash`, the shapes it refuses,
 * the dependency rule, and the real precheck.mjs `main` on the train's shared clone (its `node` / `npx`
 * / `npm` steps are recorded, not run). Every repository is under os.tmpdir() and removed after each test.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main as precheck } from '../../../../scripts/orchestrate/precheck.mjs';
import { readRecords } from '../../../../scripts/orchestrate/run-log.mjs';
import { TrainStop, buildTrain, depsState, precheckArgs } from '../../../../scripts/orchestrate/merge-train.mjs';

const GIT_ENV = { GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const ID = '20261114T000000000Z-1-000001';

let tmp: string;
let repo: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-merge-train-git-4369-'));
  repo = path.join(tmp, 'repo');
  g(tmp, 'init', '-q', '-b', 'develop', repo);
  g(repo, 'config', 'user.name', 'fixture');
  g(repo, 'config', 'user.email', 'fixture@localhost');
  g(repo, 'config', 'commit.gpgsign', 'false');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function g(cwd: string, ...args: string[]): string {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${out.stderr}`);
  return out.stdout.trim();
}
const calls: { command: string; args: string[] }[] = [];
const run = (command: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) => {
  calls.push({ command, args });
  if (command !== 'git') return { status: 0, stdout: `${command} ok\n`, stderr: '' };
  const out = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...(opts.env ?? {}) } });
  return { status: out.status ?? 1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
};
beforeEach(() => {
  calls.length = 0;
});

function write(file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}
function commit(message: string, files: Record<string, string | Buffer | null>): string {
  for (const [file, content] of Object.entries(files)) {
    if (content === null) fs.rmSync(path.join(repo, file));
    else write(file, content);
  }
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return g(repo, 'rev-parse', 'HEAD');
}
const branchFrom = (start: string, name: string) => g(repo, 'checkout', '-q', '-B', name, start);
const tree = (sha: string) => g(repo, 'rev-parse', `${sha}^{tree}`);
const cand = (pr: number, h: string, extra: Record<string, unknown> = {}) => ({ text: String(pr), issue: pr, item: null, pr, h, worktree: repo, ...extra });

/** What GitHub's squash merges would leave: `git merge --squash` of each head in turn on B0. */
function squashAll(B0: string, heads: string[]): string {
  g(repo, 'checkout', '-q', '--detach', B0);
  for (const h of heads) {
    g(repo, 'merge', '--squash', '-q', h);
    g(repo, 'commit', '-q', '--allow-empty', '-m', `squash ${h.slice(0, 7)}`);
  }
  return tree('HEAD');
}

function base(): string {
  return commit('base', { 'a.txt': 'a1\na2\na3\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'package.json': '{}\n', 'package-lock.json': '{"v":1}\n', '.gitignore': '/node_modules\n' });
}

describe('T-T the squash replay (real git) — R02・R03', () => {
  it('T1 (negative control): three PRs on other files make a single-parent chain whose tree is the three squashes in turn', () => {
    const B0 = base();
    const heads = ['a.txt', 'b.txt', 'c.txt'].map((file, i) => {
      branchFrom(B0, `p${i}`);
      return commit(`p${i}`, { [file]: `${file} changed\n` });
    });
    const built = buildTrain(run, repo, { B0, candidates: heads.map((h, i) => cand(101 + i, h)), id: ID });
    expect(built.dropped).toEqual([]);
    expect(built.chain).toHaveLength(3);
    let parent = B0;
    for (const link of built.chain) {
      expect(g(repo, 'rev-list', '--parents', '-n', '1', link.T).split(' ')).toEqual([link.T, parent]);
      parent = link.T;
    }
    expect(tree(built.T)).toBe(squashAll(B0, heads));
    expect(built.chain[2].tree).toBe(tree(built.T));
  });

  it('T2: the second conflicts with the first on one line: dropped conflict, T_2 is the first and the third', () => {
    const B0 = base();
    branchFrom(B0, 'p1');
    const h1 = commit('p1', { 'a.txt': 'a1\nONE\na3\n' });
    branchFrom(B0, 'p2');
    const h2 = commit('p2', { 'a.txt': 'a1\nTWO\na3\n' });
    branchFrom(B0, 'p3');
    const h3 = commit('p3', { 'c.txt': 'c3\n' });
    const built = buildTrain(run, repo, { B0, candidates: [cand(1, h1), cand(2, h2), cand(3, h3)], id: ID });
    expect(built.dropped).toEqual([{ entry: '2', pr: 2, reason: 'conflict files=a.txt' }]);
    expect(built.chain.map((c) => c.pr)).toEqual([1, 3]);
    expect(tree(built.T)).toBe(squashAll(B0, [h1, h3]));
  });

  it('T3 (R02): a PR stacked on another is replayed as two squashes; a two-parent merge chain gives another tree', () => {
    const B0 = base();
    branchFrom(B0, 'p1');
    const h1 = commit('p1 adds X', { 'b.txt': 'b\nX\n' });
    // p2 is built on p1 and takes X back out.
    const h2 = commit('p2 removes X', { 'b.txt': 'b\n', 'c.txt': 'c2\n' });
    const built = buildTrain(run, repo, { B0, candidates: [cand(1, h1), cand(2, h2)], id: ID });
    expect(tree(built.T)).toBe(squashAll(B0, [h1, h2]));
    // The control: the merge chain (merge-base = h1 for the second) removes X; the squashes keep it.
    g(repo, 'checkout', '-q', '--detach', B0);
    g(repo, 'merge', '-q', '--no-ff', '--no-edit', h1);
    g(repo, 'merge', '-q', '--no-ff', '--no-edit', h2);
    expect(tree('HEAD')).not.toBe(tree(built.T));
    expect(g(repo, 'show', `${built.T}:b.txt`)).toBe('b\nX');
  });

  it('T6 (R02): a PR branched from an older base gives the tree git merge --squash gives', () => {
    const old = base();
    const B0 = commit('base moves', { 'c.txt': 'c moved\n' });
    branchFrom(old, 'p1');
    const h1 = commit('p1', { 'a.txt': 'a1\na2\nA3\n' });
    const built = buildTrain(run, repo, { B0, candidates: [cand(1, h1)], id: ID });
    expect(tree(built.T)).toBe(squashAll(B0, [h1]));
  });

  it('T7 (R03 positive): a criss-cross (two merge-bases) is dropped merge-base-count=2; one base given would not be git\'s squash', () => {
    base();
    const O = g(repo, 'rev-parse', 'HEAD');
    branchFrom(O, 'A');
    const A = commit('A', { 'b.txt': 'from A\n' });
    branchFrom(O, 'B');
    const Bc = commit('B', { 'b.txt': 'from B\n' });
    // A1 = merge(A, B) resolved "from A"; B1 = merge(B, A) resolved "from B".
    branchFrom(A, 'A1');
    spawnSync('git', ['merge', '-q', '--no-edit', Bc], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    const A1 = commit('A1', { 'b.txt': 'from A\n' });
    branchFrom(Bc, 'B1');
    spawnSync('git', ['merge', '-q', '--no-edit', A], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    const B1 = commit('B1', { 'b.txt': 'from B\n' });
    expect(g(repo, 'merge-base', '--all', A1, B1).split('\n')).toHaveLength(2);
    const built = buildTrain(run, repo, { B0: A1, candidates: [cand(1, B1)], id: ID });
    expect(built.dropped).toEqual([{ entry: '1', pr: 1, reason: 'merge-base-count=2' }]);
    expect(built.chain).toEqual([]);
    // What G1 prevents: with one of the bases given, merge-tree is clean, while git's own squash conflicts.
    const first = g(repo, 'merge-base', '--all', A1, B1).split('\n')[0];
    const oneBase = spawnSync('git', ['merge-tree', '--write-tree', `--merge-base=${first}`, A1, B1], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    g(repo, 'checkout', '-q', '--detach', A1);
    const squash = spawnSync('git', ['merge', '--squash', B1], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    expect(oneBase.status).toBe(0);
    expect(squash.status).not.toBe(0);
    g(repo, 'reset', '-q', '--hard');
  });

  it('T8: unrelated history (no merge-base) is dropped merge-base-count=0', () => {
    const B0 = base();
    g(repo, 'checkout', '-q', '--orphan', 'lonely');
    g(repo, 'rm', '-q', '-rf', '.');
    const h = commit('lonely', { 'z.txt': 'z\n' });
    const built = buildTrain(run, repo, { B0, candidates: [cand(1, h)], id: ID });
    expect(built.dropped).toEqual([{ entry: '1', pr: 1, reason: 'merge-base-count=0' }]);
  });

  it('T9: a merge= attribute stops the whole train with exit 2 unsupported=merge-attribute', () => {
    base();
    const B0 = commit('attrs', { 'sub/.gitattributes': '*.lock merge=ours\n' });
    branchFrom(B0, 'p1');
    const h1 = commit('p1', { 'a.txt': 'x\n' });
    let stop: unknown = null;
    try {
      buildTrain(run, repo, { B0, candidates: [cand(1, h1)], id: ID });
    } catch (err) {
      stop = err;
    }
    expect(stop).toBeInstanceOf(TrainStop);
    expect((stop as TrainStop).exit).toBe(2);
    expect((stop as TrainStop).message).toContain('unsupported=merge-attribute');
    expect(calls.some((c) => c.args.includes('commit-tree'))).toBe(false);
  });

  it('T9 (negative control): text / eol attributes alone are not refused', () => {
    base();
    const B0 = commit('attrs', { '.gitattributes': '*.sh text eol=lf\n' });
    branchFrom(B0, 'p1');
    const h1 = commit('p1', { 'a.txt': 'x\n' });
    expect(buildTrain(run, repo, { B0, candidates: [cand(1, h1)], id: ID }).chain).toHaveLength(1);
  });

  it('T10: a PR changing a gitlink is dropped gitlink', () => {
    const B0 = base();
    branchFrom(B0, 'p1');
    g(repo, 'update-index', '--add', '--cacheinfo', `160000,${B0},vendor/sub`);
    g(repo, 'commit', '-q', '-m', 'gitlink');
    const h1 = g(repo, 'rev-parse', 'HEAD');
    const built = buildTrain(run, repo, { B0, candidates: [cand(1, h1)], id: ID });
    expect(built.dropped).toEqual([{ entry: '1', pr: 1, reason: 'gitlink' }]);
  });

  it('T11 (R03 negative): rename, mode change and binary give the tree git merge --squash gives', () => {
    const B0 = base();
    branchFrom(B0, 'p1');
    g(repo, 'mv', 'c.txt', 'c-renamed.txt');
    g(repo, 'commit', '-q', '-m', 'rename');
    const h1 = g(repo, 'rev-parse', 'HEAD');
    branchFrom(B0, 'p2');
    fs.chmodSync(path.join(repo, 'b.txt'), 0o755);
    g(repo, 'add', 'b.txt');
    g(repo, 'commit', '-q', '-m', 'mode');
    const h2 = g(repo, 'rev-parse', 'HEAD');
    branchFrom(B0, 'p3');
    const h3 = commit('binary', { 'img.bin': Buffer.from([0, 1, 2, 255, 0, 7]) });
    const built = buildTrain(run, repo, { B0, candidates: [cand(1, h1), cand(2, h2), cand(3, h3)], id: ID });
    expect(built.dropped).toEqual([]);
    expect(tree(built.T)).toBe(squashAll(B0, [h1, h2, h3]));
  });

  it('C9 (F05): a candidate that changes package-lock.json or package.json is dropped deps-changed before the chain', () => {
    const B0 = base();
    branchFrom(B0, 'p1');
    const h1 = commit('deps', { 'package-lock.json': '{"v":2}\n' });
    branchFrom(B0, 'p2');
    const h2 = commit('ok', { 'a.txt': 'x\n' });
    const built = buildTrain(run, repo, { B0, candidates: [cand(1, h1), cand(2, h2)], id: ID });
    expect(built.dropped).toEqual([{ entry: '1', pr: 1, reason: 'deps-changed' }]);
    expect(built.chain.map((c) => c.pr)).toEqual([2]);
  });
});

/** A train on B0 from `heads`, its shared clone, and node_modules borrowed from `source`. */
function trainClone(B0: string, heads: string[], candidates: Record<string, unknown>[] = []) {
  const built = buildTrain(run, repo, { B0, candidates: heads.map((h, i) => cand(4401 + i, h, candidates[i] ?? {})), id: ID });
  const dir = path.join(tmp, `cm-train-x-${ID}`);
  g(tmp, 'clone', '-q', '--shared', '--no-checkout', repo, dir);
  g(dir, 'checkout', '-q', '--detach', built.T);
  return { built, dir };
}
const precheckOf = (dir: string, args: string[]) => {
  const runDir = path.join(tmp, 'runs');
  const code = precheck(args, { run, home: path.join(tmp, 'home'), findTestsNaming: () => [], estimateRelatedTests: () => 0, log: () => {}, error: () => {} });
  const records = readRecords(path.join(runDir, 'train'), '4401-4409').records;
  return { code, record: records.at(-1), dir };
};

describe('T-P the combination check — R15・R16・R17', () => {
  it('P1 (R15 positive): one refactor candidate makes the train\'s precheck run suppressions over the whole train', () => {
    const B0 = base();
    branchFrom(B0, 'p1');
    const h1 = commit('p1', { 'src/x.ts': 'export const x = 1;\n' });
    branchFrom(B0, 'p2');
    const h2 = commit('p2', { 'src/y.ts': 'export const y = 1;\n' });
    const cands = [{ kind: 'refactor' }, { kind: 'bug' }];
    const { built, dir } = trainClone(B0, [h1, h2], cands);
    const args = precheckArgs({ runDir: path.join(tmp, 'runs'), issues: '4401-4409', worktree: dir, B0, candidates: built.adopted.map((a, i) => ({ ...a, ...cands[i] })) });
    expect(args).toContain('--kind');
    const r = precheckOf(dir, args);
    expect(r.code).toBe(0);
    expect(r.record.note).toContain('suppressions=ok');
    expect(calls.some((c) => c.command === 'node' && c.args[0] === 'scripts/count-suppressions.mjs' && c.args.includes(B0))).toBe(true);
  });

  it('P2 (negative control): all bug — suppressions does not run', () => {
    const B0 = base();
    branchFrom(B0, 'p1');
    const h1 = commit('p1', { 'src/x.ts': 'export const x = 1;\n' });
    const { built, dir } = trainClone(B0, [h1], [{ kind: 'bug' }]);
    const args = precheckArgs({ runDir: path.join(tmp, 'runs'), issues: '4401-4409', worktree: dir, B0, candidates: built.adopted.map((a) => ({ ...a, kind: 'bug' })) });
    expect(args).not.toContain('--kind');
    expect(precheckOf(dir, args).record.note).toContain('suppressions=skip');
  });

  it('P3: one build candidate → --build and the three build steps', () => {
    const B0 = base();
    branchFrom(B0, 'p1');
    const h1 = commit('p1', { 'a.txt': 'x\n' });
    const { built, dir } = trainClone(B0, [h1]);
    const args = precheckArgs({ runDir: path.join(tmp, 'runs'), issues: '4401-4409', worktree: dir, B0, candidates: built.adopted.map((a) => ({ ...a, build: true })) });
    expect(args).toContain('--build');
    const note = precheckOf(dir, args).record.note;
    expect(note).toMatch(/build=ok build-cli=ok build-server=ok/);
  });

  it('P4 (R16 positive): a train removing a test fails removed-tests (exit 1); --allow-removed-tests is never passed', () => {
    const B0 = commit('base with a test', { 'tests/unit/a.test.ts': "it('keeps', () => {});\n", 'package-lock.json': '{}\n', '.gitignore': '/node_modules\n' });
    branchFrom(B0, 'p1');
    const h1 = commit('removes the test', { 'tests/unit/a.test.ts': '// gone\n' });
    const { built, dir } = trainClone(B0, [h1]);
    const args = precheckArgs({ runDir: path.join(tmp, 'runs'), issues: '4401-4409', worktree: dir, B0, candidates: built.adopted });
    expect(args).not.toContain('--allow-removed-tests');
    const r = precheckOf(dir, args);
    expect(r.code).toBe(1);
    expect(r.record.note).toContain('removed-tests=fail');
  });

  it('P5 (R17 negative): the lockfile is the same at B0, T_N and the source, node_modules is there → same; the source is untouched', () => {
    const B0 = base();
    branchFrom(B0, 'p1');
    const h1 = commit('p1', { 'a.txt': 'x\n' });
    const { built } = trainClone(B0, [h1]);
    g(repo, 'checkout', '-q', 'develop');
    fs.mkdirSync(path.join(repo, 'node_modules'));
    const before = g(repo, 'status', '--porcelain');
    expect(depsState(run, { repoDir: repo, B0, T: built.T, source: repo }).state).toBe('same');
    expect(g(repo, 'status', '--porcelain')).toBe(before);
  });

  it('P6 (R17 positive): a train whose lockfile differs from B0 is changed (merge-train stops with exit 2 before npm or the precheck)', () => {
    const B0 = base();
    // The train's T (a commit made by hand here) changes the lockfile.
    branchFrom(B0, 'p1');
    const T = commit('lock', { 'package-lock.json': '{"v":9}\n' });
    fs.mkdirSync(path.join(repo, 'node_modules'));
    expect(depsState(run, { repoDir: repo, B0, T, source: repo }).state).toBe('changed');
    expect(calls.some((c) => c.command === 'npm' || c.command === 'npx')).toBe(false);
  });

  it('P7: no node_modules in the source → unknown; the source\'s lockfile differs → changed; a dirty source → unknown', () => {
    const B0 = base();
    branchFrom(B0, 'p1');
    const h1 = commit('p1', { 'a.txt': 'x\n' });
    const { built } = trainClone(B0, [h1]);
    const source = path.join(tmp, 'source');
    g(tmp, 'clone', '-q', repo, source);
    g(source, 'checkout', '-q', B0);
    expect(depsState(run, { repoDir: repo, B0, T: built.T, source }).state).toBe('unknown');
    fs.mkdirSync(path.join(source, 'node_modules'));
    expect(depsState(run, { repoDir: repo, B0, T: built.T, source }).state).toBe('same');
    fs.writeFileSync(path.join(source, 'stray.txt'), 'x');
    expect(depsState(run, { repoDir: repo, B0, T: built.T, source }).state).toBe('unknown');
    fs.rmSync(path.join(source, 'stray.txt'));
    g(source, '-c', 'user.name=x', '-c', 'user.email=x@x', 'checkout', '-q', '-b', 'other');
    fs.writeFileSync(path.join(source, 'package-lock.json'), '{"v":3}\n');
    g(source, 'add', '-A');
    g(source, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'lock');
    expect(depsState(run, { repoDir: repo, B0, T: built.T, source }).state).toBe('changed');
  });

  it('P9: --base is B0\'s SHA, so a later fetch that moves origin/develop does not change the precheck\'s input', () => {
    const B0 = base();
    branchFrom(B0, 'p1');
    const h1 = commit('p1', { 'src/x.ts': 'export const x = 1;\n' });
    const { built, dir } = trainClone(B0, [h1]);
    const args = precheckArgs({ runDir: path.join(tmp, 'runs'), issues: '4401-4409', worktree: dir, B0, candidates: built.adopted });
    expect(args[args.indexOf('--base') + 1]).toBe(B0);
    // origin/develop of the clone moves to the train itself: by name the diff would be empty.
    g(dir, 'update-ref', 'refs/remotes/origin/develop', built.T);
    const r = precheckOf(dir, args);
    expect(r.code).toBe(0);
    expect(r.record.note).toContain('eslint=ok');
    expect(calls.some((c) => c.command === 'npx' && c.args[0] === 'eslint' && c.args.includes('src/x.ts'))).toBe(true);
  });
});
