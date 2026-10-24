/**
 * The environment of an execution (Issue #3883 H-8, P6, and the files of 5-1).
 *
 *  - env-manifest.mjs: the inputs an execution depends on, and what changed;
 *  - dependency-links.mjs + consistency-review.mjs: a review that links one
 *    worktree's dependencies out of it is not a verdict;
 *  - execution-key.mjs allocate: the runbook's shell takes a file of its own.
 *
 * Everything is under os.tmpdir(); the CLI and git of consistency-review are fakes.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UNREADABLE, diffManifest, main as envCli, manifestHash, takeManifest } from '../../../../scripts/orchestrate/env-manifest.mjs';
import { defaultSpawnToLog } from '../../../../scripts/orchestrate/wait-verify.mjs';
import { addedLinks, foreignLinks, parseWorktreeList, snapshotForeignLinks } from '../../../../scripts/orchestrate/dependency-links.mjs';
import { main as review } from '../../../../scripts/orchestrate/consistency-review.mjs';
import { main as allocate } from '../../../../scripts/orchestrate/execution-key.mjs';
import { readRecords } from '../../../../scripts/orchestrate/run-log.mjs';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-env-isolation-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
/** A worktree with a package.json, a lockfile, settings and installed dependencies. */
function worktree(name: string): string {
  const wt = path.join(tmp, name);
  write(path.join(wt, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' }, devDependencies: { vitest: '4.1.2' } }));
  write(path.join(wt, 'package-lock.json'), '{"lockfileVersion":3}\n');
  write(path.join(wt, '.claude', 'settings.local.json'), '{"model":"opus[1m]"}\n');
  write(path.join(wt, 'node_modules', 'next', 'package.json'), '{"version":"15.0.0"}');
  write(path.join(wt, 'node_modules', 'vitest', 'package.json'), '{"version":"4.1.2"}');
  write(path.join(wt, 'src', 'index.ts'), 'export {};\n');
  return wt;
}

describe('env-manifest (H-8)', () => {
  it('reads the global model, the local settings, the lockfile, node_modules and the versions', () => {
    const wt = worktree('wt');
    const home = path.join(tmp, 'home');
    write(path.join(home, '.claude', 'settings.json'), '{"model":"fable","theme":"dark"}');
    const m = takeManifest({ worktree: wt, home });
    expect(m.globalModel).toBe('fable');
    expect(m.localSettings.model).toBe('opus[1m]');
    expect(m.lockfile).toMatch(/^[0-9a-f]{64}$/);
    expect(m.nodeModules).toEqual({ realpath: path.join(wt, 'node_modules'), symlink: false });
    expect(m.packages).toEqual({ next: '15.0.0', vitest: '4.1.2' });
  });

  it('names each kind of change, and nothing when nothing changed (negative control)', () => {
    const wt = worktree('wt');
    const home = path.join(tmp, 'home');
    write(path.join(home, '.claude', 'settings.json'), '{"model":"opus[1m]"}');
    const before = takeManifest({ worktree: wt, home });
    expect(diffManifest(before, takeManifest({ worktree: wt, home }))).toEqual([]);
    expect(manifestHash(before)).toBe(manifestHash(takeManifest({ worktree: wt, home })));

    // The global default changes (P3), another key of it does not count.
    write(path.join(home, '.claude', 'settings.json'), '{"model":"fable"}');
    expect(diffManifest(before, takeManifest({ worktree: wt, home }))).toEqual(['globalModel']);
    write(path.join(home, '.claude', 'settings.json'), '{"model":"opus[1m]","theme":"light"}');
    expect(diffManifest(before, takeManifest({ worktree: wt, home }))).toEqual([]);

    write(path.join(wt, '.claude', 'settings.local.json'), '{"model":"sonnet"}');
    write(path.join(wt, 'package-lock.json'), '{"lockfileVersion":3,"x":1}');
    write(path.join(wt, 'node_modules', 'vitest', 'package.json'), '{"version":"4.2.0"}');
    expect(diffManifest(before, takeManifest({ worktree: wt, home }))).toEqual(['localSettings', 'lockfile', 'packages.vitest']);
  });

  it('a node_modules swapped for a link to another tree is a change of its location', () => {
    const wt = worktree('wt');
    const other = worktree('other');
    const home = path.join(tmp, 'home');
    const before = takeManifest({ worktree: wt, home });
    fs.rmSync(path.join(wt, 'node_modules'), { recursive: true });
    fs.symlinkSync(path.join(other, 'node_modules'), path.join(wt, 'node_modules'));
    const after = takeManifest({ worktree: wt, home });
    expect(after.nodeModules).toEqual({ realpath: path.join(other, 'node_modules'), symlink: true });
    expect(diffManifest(before, after)).toEqual(['nodeModules']);
  });

  it('an unreadable global settings file is not the same as an absent one', () => {
    const wt = worktree('wt');
    const home = path.join(tmp, 'home');
    expect(takeManifest({ worktree: wt, home }).globalModel).toBeNull();
    write(path.join(home, '.claude', 'settings.json'), '{ broken');
    expect(takeManifest({ worktree: wt, home }).globalModel).toBe(UNREADABLE);
  });

  it('reads only the named files of HOME (no recursive walk)', () => {
    const wt = worktree('wt');
    const home = path.join(tmp, 'home');
    write(path.join(home, '.claude', 'settings.json'), '{"model":"opus"}');
    const before = takeManifest({ worktree: wt, home });
    write(path.join(home, '.claude', 'projects', 'x', 'memory.md'), 'noise');
    write(path.join(home, 'other.txt'), 'noise');
    expect(diffManifest(before, takeManifest({ worktree: wt, home }))).toEqual([]);
  });
});

describe('env-manifest.mjs start / end (5-1, #3883 N6)', () => {
  const cli = (argv: string[], home: string) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = envCli(argv, { home, out: (l: string) => out.push(l), error: (l: string) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('end prints env=<hash> of the end manifest; a change since start is exit 3 and named', () => {
    const wt = worktree('wt');
    const home = path.join(tmp, 'home');
    const file = path.join(tmp, 'runs', 'verify-3883.env.json');
    expect(cli(['start', '--worktree', wt, '--file', file, '--key', 'k:3883:-:a1'], home).code).toBe(0);
    const same = cli(['end', '--worktree', wt, '--file', file], home);
    expect(same).toMatchObject({ code: 0, out: `env=${manifestHash(takeManifest({ worktree: wt, home }))}` });
    expect(cli(['start', '--worktree', wt, '--file', file, '--key', 'k:3883:-:a2'], home).code).toBe(0);
    write(path.join(wt, 'package-lock.json'), '{"lockfileVersion":3,"x":1}\n');
    const moved = cli(['end', '--worktree', wt, '--file', file], home);
    expect(moved.code).toBe(3);
    expect(moved.out).toMatch(/^env=[0-9a-f]{12} env-changed-during-verify=lockfile$/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ key: 'k:3883:-:a2', changed: { duringVerify: ['lockfile'] } });
  });

  it('end without a start, a file not named *.env.json, or start without a key: exit 2', () => {
    const wt = worktree('wt');
    const home = path.join(tmp, 'home');
    expect(cli(['end', '--worktree', wt, '--file', path.join(tmp, 'none.env.json')], home).code).toBe(2);
    expect(cli(['start', '--worktree', wt, '--file', path.join(tmp, 'x.json'), '--key', 'k'], home).code).toBe(2);
    expect(cli(['start', '--worktree', wt, '--file', path.join(tmp, 'x.env.json')], home).code).toBe(2);
    expect(fs.existsSync(path.join(tmp, 'x.env.json'))).toBe(false);
  });
});

describe('wait-verify defaultSpawnToLog onOutput (#3883 N5)', () => {
  it('shows the log while the command runs, so a line is seen before the command ends', () => {
    const logFile = path.join(tmp, 'wait.log');
    const seen: { completed: boolean; done: boolean }[] = [];
    const code = defaultSpawnToLog('sh', ['-c', 'echo "Completed: wt-1 (basis=hook_stop)"; sleep 1; echo GATE-DONE; exit 20'], {
      cwd: tmp,
      logFile,
      onOutput: (text: string) => seen.push({ completed: /^Completed: /m.test(text), done: text.includes('GATE-DONE') }),
    });
    expect(code).toBe(20);
    // The turn end was seen while the rest had not been written yet, and the last call has all of it.
    expect(seen.some((s) => s.completed && !s.done)).toBe(true);
    expect(seen[seen.length - 1]).toEqual({ completed: true, done: true });
  });
});

describe('dependency-links (P6)', () => {
  it('reports a link out of the worktree, not one into its own tree or a plain package (negative control)', () => {
    const wt = worktree('wt');
    const other = worktree('other');
    fs.symlinkSync(path.join(wt, 'src'), path.join(wt, 'node_modules', 'own-workspace'));
    expect(foreignLinks(wt)).toEqual([]);
    fs.symlinkSync(path.join(other, 'src'), path.join(wt, 'node_modules', 'foreign'));
    fs.mkdirSync(path.join(wt, 'node_modules', '@scope'));
    fs.symlinkSync(path.join(other, 'node_modules', 'next'), path.join(wt, 'node_modules', '@scope', 'pkg'));
    expect(foreignLinks(wt).map((l) => path.relative(wt, l.link)).sort()).toEqual([
      path.join('node_modules', '@scope', 'pkg'),
      path.join('node_modules', 'foreign'),
    ]);
  });

  it('node_modules itself linked out of the worktree is a foreign link; linked inside it is not (#3883 N4)', () => {
    const wt = worktree('wt');
    const other = worktree('other');
    fs.rmSync(path.join(wt, 'node_modules'), { recursive: true });
    fs.symlinkSync(path.join(other, 'node_modules'), path.join(wt, 'node_modules'));
    expect(foreignLinks(wt)).toEqual([{ link: path.join(wt, 'node_modules'), target: path.join(other, 'node_modules') }]);
    // Negative control: a node_modules that links to a tree inside its own worktree.
    fs.unlinkSync(path.join(wt, 'node_modules'));
    fs.mkdirSync(path.join(wt, '.deps'));
    fs.renameSync(path.join(other, 'node_modules'), path.join(wt, '.deps', 'node_modules'));
    fs.symlinkSync(path.join(wt, '.deps', 'node_modules'), path.join(wt, 'node_modules'));
    expect(foreignLinks(wt)).toEqual([]);
  });

  it('counts only links that appeared or now point elsewhere', () => {
    const before = new Map([['/a', '/x'], ['/b', '/y']]);
    const after = new Map([['/a', '/x'], ['/b', '/z'], ['/c', '/w']]);
    expect(addedLinks(before, after)).toEqual([{ link: '/b', target: '/z' }, { link: '/c', target: '/w' }]);
    expect(addedLinks(after, after)).toEqual([]);
  });

  it('reads the worktrees of `git worktree list --porcelain`', () => {
    expect(parseWorktreeList('worktree /r/main\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/wt 2\nHEAD def\n')).toEqual(['/r/main', '/r/wt 2']);
    expect(snapshotForeignLinks([path.join(tmp, 'nowhere')]).size).toBe(0);
  });
});

describe('consistency-review: a review that links another worktree’s dependencies out is not a verdict (P6)', () => {
  const HEAD = 'c0ffee1' + '0'.repeat(33);

  function reviewWith(duringAsk: (wts: { wt: string; other: string }) => void, beforeReview?: (wts: { wt: string; other: string }) => void) {
    const wt = worktree('commandmate-issue-3883');
    const other = worktree('commandmate-issue-3884');
    beforeReview?.({ wt, other });
    const runDir = path.join(tmp, 'runs', '2026-10-25');
    write(path.join(tmp, 'brief.txt'), 'brief\n');
    const errors: string[] = [];
    const run = (command: string, args: string[]) => {
      if (command === 'git' && args.includes('worktree')) {
        return { status: 0, stdout: `worktree ${wt}\nHEAD ${HEAD}\n\nworktree ${other}\nHEAD ${HEAD}\n`, stderr: '' };
      }
      if (command === 'git') return { status: 0, stdout: args.includes('--abbrev-ref') ? 'feature/3883\n' : `${HEAD}\n`, stderr: '' };
      if (args[0] === 'capture') return { status: 0, stdout: JSON.stringify({ sessionStatus: 'ready' }), stderr: '' };
      if (args[0] === 'ask') {
        duringAsk({ wt, other });
        return { status: 0, stdout: JSON.stringify({ reply: '指摘なし\n\nDONE: 指摘なし' }), stderr: '' };
      }
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    };
    const code = review(
      ['--run-dir', runDir, '--issues', '3883', '--issue', '3883', '--head', HEAD, '--brief', path.join(tmp, 'brief.txt'), '--worktree', wt, '--lock', path.join(tmp, 'lock')],
      { run, sleep: () => {}, now: () => new Date(Date.UTC(2026, 9, 25)), cwd: tmp, log: () => {}, error: (l: string) => errors.push(l) }
    );
    const record = readRecords(runDir, '3883').records.find((r) => r.stage === 'review');
    return { code, record, errors, runDir };
  }

  it('a link created in another worktree’s node_modules that leads into the reviewed one fails the review', () => {
    const r = reviewWith(({ wt, other }) => fs.symlinkSync(path.join(wt, 'src'), path.join(other, 'node_modules', 'reviewed-src')));
    expect(r.code).toBe(1);
    expect(r.record).toMatchObject({ result: 'fail' });
    expect(r.record?.note).toMatch(/not a verdict — 1 dependency link\(s\) outside their worktree appeared during the review: .*reviewed-src ->/);
    expect(r.errors.join('\n')).toContain('commandmate-issue-3884');
    // The answer is kept for the person, but the table of verdicts is not written.
    expect(fs.existsSync(path.join(r.runDir, 'review-3883.json'))).toBe(true);
    expect(fs.existsSync(path.join(r.runDir, 'consistency-review.md'))).toBe(false);
  });

  it('a link in the reviewed worktree to another worktree fails it too', () => {
    const r = reviewWith(({ wt, other }) => fs.symlinkSync(path.join(other, 'node_modules', 'next'), path.join(wt, 'node_modules', 'next-other')));
    expect(r.code).toBe(1);
  });

  /** Replace a worktree's node_modules with a link to `target`. */
  const linkModules = (from: string, target: string) => {
    fs.rmSync(path.join(from, 'node_modules'), { recursive: true, force: true });
    fs.symlinkSync(target, path.join(from, 'node_modules'));
  };

  it('node_modules of the reviewed worktree turned into a link to another worktree’s during the review fails it (#3883 N4)', () => {
    // Only plain packages behind the link: the links inside it alone show nothing.
    const r = reviewWith(({ wt, other }) => linkModules(wt, path.join(other, 'node_modules')));
    expect(r.code).toBe(1);
    expect(r.record?.note).toMatch(/not a verdict — 1 dependency link\(s\) .*commandmate-issue-3883\/node_modules -> .*commandmate-issue-3884\/node_modules/);
  });

  it('a shared node_modules pointed at another tree during the review fails it; one shared before the review does not (#3883 N4)', () => {
    const shared = (name: string) => {
      const dir = path.join(tmp, name, 'node_modules');
      write(path.join(dir, 'next', 'package.json'), '{"version":"15.0.0"}');
      return dir;
    };
    const moved = reviewWith(({ wt }) => linkModules(wt, shared('elsewhere')), ({ wt }) => linkModules(wt, shared('main')));
    expect(moved.code).toBe(1);
    expect(moved.record?.note).toContain('elsewhere/node_modules');
    fs.rmSync(path.join(tmp, 'runs'), { recursive: true });
    fs.rmSync(path.join(tmp, 'commandmate-issue-3883'), { recursive: true });
    fs.rmSync(path.join(tmp, 'commandmate-issue-3884'), { recursive: true });
    const kept = reviewWith(() => {}, ({ wt }) => linkModules(wt, path.join(tmp, 'main', 'node_modules')));
    expect(kept.code).toBe(0);
    expect(kept.record).toMatchObject({ result: 'ok' });
  });

  it('negative controls: no new link, a link inside its own worktree, and a foreign link that was already there', () => {
    expect(reviewWith(() => {}).code).toBe(0);
    fs.rmSync(path.join(tmp, 'runs'), { recursive: true });
    expect(reviewWith(({ other }) => fs.symlinkSync(path.join(other, 'src'), path.join(other, 'node_modules', 'own'))).code).toBe(0);
    fs.rmSync(path.join(tmp, 'runs'), { recursive: true });
    fs.symlinkSync(path.join(tmp, 'commandmate-issue-3883', 'src'), path.join(tmp, 'commandmate-issue-3884', 'node_modules', 'earlier'));
    const r = reviewWith(() => {});
    expect(r.code).toBe(0);
    expect(r.record).toMatchObject({ result: 'ok' });
  });
});

describe('execution-key.mjs allocate (5-1, 3-1)', () => {
  it('takes a file of its own per call and prints the execution key', () => {
    const out: string[] = [];
    const go = (...extra: string[]) =>
      allocate(['allocate', '--dir', tmp, '--prefix', 'verify', '--issue', '3883', '--ext', '.json', ...extra], { log: (l: string) => out.push(l), error: () => {} });
    expect(go('--issues', '3883', '--task', '-')).toBe(0);
    expect(go('--issues', '3883', '--task', 't-1', '--item', 'd2')).toBe(0);
    expect(go()).toBe(0);
    expect(out).toEqual([
      path.join(tmp, 'verify-3883.json'), '3883:3883:-:a1',
      path.join(tmp, 'verify-3883-d2.json'), '3883:3883-d2:t-1:a1',
      path.join(tmp, 'verify-3883.a2.json'),
    ]);
  });

  it('rejects what cannot name a file', () => {
    const quiet = { log: () => {}, error: () => {} };
    expect(allocate(['allocate', '--dir', tmp, '--prefix', '../x', '--issue', '1'], quiet)).toBe(2);
    expect(allocate(['allocate', '--dir', tmp, '--prefix', 'verify', '--issue', '1', '--ext', 'json'], quiet)).toBe(2);
    expect(allocate(['allocate', '--dir', tmp, '--prefix', 'verify', '--issue', '1', '--item', 'a/b'], quiet)).toBe(2);
    expect(allocate(['other'], quiet)).toBe(2);
  });
});
