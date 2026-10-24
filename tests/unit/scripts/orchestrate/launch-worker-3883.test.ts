/**
 * scripts/orchestrate/launch-worker.mjs — the contract's model is pinned and
 * checked (Issue #3883 P3), and each send has files of its own (3-1).
 *
 * The CLI is a fake; git is real where it decides (check-ignore), with a
 * private HOME and an empty global git config. Everything is under os.tmpdir().
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT_MODEL_MISMATCH,
  EXIT_MODEL_UNKNOWN,
  MODEL_READS,
  MODEL_SETTINGS,
  classifyModel,
  main,
  parseArgs,
  setModel,
} from '../../../../scripts/orchestrate/launch-worker.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

let tmp: string;
let home: string;
let worktree: string;
let runDir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-launch-worker-'));
  home = path.join(tmp, 'home');
  worktree = path.join(tmp, 'wt');
  runDir = path.join(tmp, 'runs', '2026-10-25');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `${JSON.stringify({ model: 'fable' }, null, 2)}\n`);
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '');
  fs.mkdirSync(worktree, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Real git with a private HOME and an empty global config, so only the worktree's .gitignore decides. */
const realGit = (command: string, args: string[]) => {
  const r = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const initRepo = (ignoreSettings: boolean) => {
  realGit('git', ['init', '-q', worktree]);
  if (ignoreSettings) fs.writeFileSync(path.join(worktree, '.gitignore'), '.claude/settings.local.json\n');
};
const localSettings = () => JSON.parse(fs.readFileSync(path.join(worktree, '.claude', 'settings.local.json'), 'utf8'));
const globalSettings = () => fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');

/** The model a Claude session starts on: the worktree's local setting, else the global default. */
const effectiveModel = () => {
  const file = path.join(worktree, '.claude', 'settings.local.json');
  const local = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).model : undefined;
  return local ?? JSON.parse(globalSettings()).model;
};

describe('setModel writes the contract model explicitly (P3)', () => {
  it('opus is written (not inherited), so a global default of fable does not decide it', () => {
    initRepo(true);
    const before = globalSettings();
    expect(setModel(realGit, worktree, 'opus')).toMatchObject({ value: 'opus[1m]' });
    expect(localSettings()).toEqual({ model: 'opus[1m]' });
    expect(classifyModel(effectiveModel(), 'opus')).toBe('ok');
    // The operator's global settings are neither read into nor written.
    expect(globalSettings()).toBe(before);
  });

  it.skipIf(spawnSync('jq', ['--version']).status !== 0)(
    'positive control: the pre-#3883 rule (del(.model) for opus) inherits the global fable',
    () => {
      initRepo(true);
      fs.mkdirSync(path.join(worktree, '.claude'));
      fs.writeFileSync(path.join(worktree, '.claude', 'settings.local.json'), '{"model":"sonnet"}\n');
      // The function the runbook's 3-1 had until #3883, verbatim.
      const old = [
        'set_claude_model() {',
        '  f="$1/.claude/settings.local.json"',
        '  git -C "$1" check-ignore -q .claude/settings.local.json || { echo "NOT ignored: $f" >&2; return 1; }',
        `  mkdir -p "$1/.claude"; [ -s "$f" ] || echo '{}' > "$f"`,
        `  if [ "$2" = sonnet ]; then jq '.model = "sonnet"' "$f" > "$f.tmp"; else jq 'del(.model)' "$f" > "$f.tmp"; fi`,
        '  mv "$f.tmp" "$f"',
        '}',
        'set_claude_model "$WT" opus',
      ].join('\n');
      const r = spawnSync('bash', ['-c', old], {
        encoding: 'utf8',
        env: { ...process.env, WT: worktree, HOME: home, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig') },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(effectiveModel()).toBe('fable');
      expect(classifyModel(effectiveModel(), 'opus')).toBe('mismatch');
      // The helper on the same file: the contract's model again.
      setModel(realGit, worktree, 'opus');
      expect(classifyModel(effectiveModel(), 'opus')).toBe('ok');
    }
  );

  it('a change of the global default does not change what is written (negative control)', () => {
    initRepo(true);
    setModel(realGit, worktree, 'sonnet');
    const first = localSettings();
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"model":"opus"}\n');
    setModel(realGit, worktree, 'sonnet');
    expect(localSettings()).toEqual(first);
    expect(first).toEqual({ model: MODEL_SETTINGS.sonnet });
  });

  it('keeps the other keys of the local settings', () => {
    initRepo(true);
    fs.mkdirSync(path.join(worktree, '.claude'));
    fs.writeFileSync(path.join(worktree, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(ls)"]}}');
    setModel(realGit, worktree, 'opus');
    expect(localSettings()).toEqual({ permissions: { allow: ['Bash(ls)'] }, model: 'opus[1m]' });
  });

  it('refuses a settings file git does not ignore, and writes nothing', () => {
    initRepo(false);
    expect(() => setModel(realGit, worktree, 'opus')).toThrow(/NOT ignored/);
    expect(fs.existsSync(path.join(worktree, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('refuses a local settings file that is not a JSON object (does not clobber it)', () => {
    initRepo(true);
    fs.mkdirSync(path.join(worktree, '.claude'));
    fs.writeFileSync(path.join(worktree, '.claude', 'settings.local.json'), '{ broken');
    expect(() => setModel(realGit, worktree, 'opus')).toThrow(/not a JSON object/);
    expect(fs.readFileSync(path.join(worktree, '.claude', 'settings.local.json'), 'utf8')).toBe('{ broken');
  });

  it('never reaches for the global settings (source)', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts/orchestrate/launch-worker.mjs'), 'utf8');
    expect(source).not.toMatch(/homedir|process\.env\.HOME/);
    expect(source).not.toMatch(/del\(\.model\)/);
  });
});

describe('classifyModel', () => {
  it.each([
    ['claude-opus-5-5', 'opus', 'ok'],
    ['Opus 5.5 (1M context)', 'opus', 'ok'],
    ['claude-sonnet-5-5', 'sonnet', 'ok'],
    ['claude-fable-5-1', 'opus', 'mismatch'],
    ['claude-sonnet-5-5', 'opus', 'mismatch'],
    ['', 'opus', 'unknown'],
    [null, 'sonnet', 'unknown'],
  ])('%s for %s is %s', (got, want, verdict) => {
    expect(classifyModel(got, want)).toBe(verdict);
  });
});

/** A fake commandmatedev: send answers with task ids, capture --json with the models in turn. */
function fakeCli({ models = [] as (string | null)[], sendExit = 0, running = true, ignored = true } = {}) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  let sends = 0;
  let captures = 0;
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === 'git') return { status: ignored ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'instances' && args[2] === '--json') {
      return { status: 0, stdout: JSON.stringify([{ instanceId: 'claude', running }]), stderr: '' };
    }
    if (args[0] === 'instances' && args[2] === 'kill') return { status: 0, stdout: '', stderr: 'Session killed: claude' };
    if (args[0] === 'send') {
      sends += 1;
      return sendExit === 0
        ? { status: 0, stdout: `task-${sends}\n`, stderr: `Task created: task-${sends}\n` }
        : { status: sendExit, stdout: '', stderr: 'prompt not ready' };
    }
    if (args[0] === 'capture') {
      const model = models[Math.min(captures, models.length - 1)] ?? null;
      captures += 1;
      return { status: 0, stdout: JSON.stringify(model === null ? { sessionStatus: 'running' } : { model }), stderr: '' };
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
  return { run, calls, sleeps, sleep: (ms: number) => sleeps.push(ms) };
}

const sendArgv = (...extra: string[]) => [
  'send', '--run-dir', runDir, '--issue', '3883', '--wt', 'wt-1', '--worktree', worktree,
  '--instance', 'claude', '--contract', '.commandmate/tasks/issue-3883.yaml', ...extra,
];
function go(fake: ReturnType<typeof fakeCli>, argv: string[]) {
  const out: string[] = [];
  const log: string[] = [];
  const code = main(argv, { run: fake.run, sleep: fake.sleep, out: (l: string) => out.push(l), log: (l: string) => log.push(l), error: (l: string) => log.push(l) });
  return { code, out, log };
}
const verbs = (fake: ReturnType<typeof fakeCli>) =>
  fake.calls.map((c) => (c[0] === 'git' ? 'git' : c[1] === 'instances' ? `instances ${c[3]}` : c[1]));

describe('send: model pinned, sent, checked (P3)', () => {
  it('stops a running session, writes the model, sends, then reads the model back', () => {
    const fake = fakeCli({ models: ['claude-opus-5-5'] });
    const r = go(fake, sendArgv('--model', 'opus'));
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['task-1']);
    expect(verbs(fake)).toEqual(['instances --json', 'instances kill', 'git', 'send', 'capture']);
    expect(localSettings()).toEqual({ model: 'opus[1m]' });
    expect(fake.calls.find((c) => c[1] === 'send')).toEqual([
      'commandmatedev', 'send', 'wt-1', '--contract', '.commandmate/tasks/issue-3883.yaml', '--instance', 'claude', '--auto-yes', '--duration', '3h',
    ]);
    expect(r.log.join('\n')).toContain('model ok issue=3883 want=opus got=claude-opus-5-5');
  });

  it('a mismatch restarts once (kill, write, send again) and goes on when the second matches', () => {
    const fake = fakeCli({ models: ['claude-fable-5-1', 'claude-opus-5-5'] });
    const r = go(fake, sendArgv('--model', 'opus'));
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['task-2']);
    expect(verbs(fake)).toEqual([
      'instances --json', 'instances kill', 'git', 'send', 'capture', 'instances kill',
      'instances --json', 'instances kill', 'git', 'send', 'capture',
    ]);
    expect(r.log.join('\n')).toContain('model MISMATCH issue=3883 want=opus got=claude-fable-5-1 attempt=1');
  });

  it('a mismatch that stays stops the session and fails (does not go on with the wrong model)', () => {
    const fake = fakeCli({ models: ['claude-fable-5-1'] });
    const r = go(fake, sendArgv('--model', 'opus'));
    expect(r.code).toBe(EXIT_MODEL_MISMATCH);
    expect(r.out).toEqual(['task-2']);
    expect(verbs(fake).slice(-1)).toEqual(['instances kill']);
    expect(fake.calls.filter((c) => c[1] === 'send')).toHaveLength(2);
  });

  it('an unknown model is read again, restarts once, and fails as unknown', () => {
    const fake = fakeCli({ models: [null] });
    const r = go(fake, sendArgv('--model', 'sonnet'));
    expect(r.code).toBe(EXIT_MODEL_UNKNOWN);
    expect(fake.calls.filter((c) => c[1] === 'capture')).toHaveLength(MODEL_READS * 2);
    expect(fake.sleeps.length).toBe((MODEL_READS - 1) * 2);
    expect(verbs(fake).slice(-1)).toEqual(['instances kill']);
    expect(r.log.join('\n')).toContain('model UNKNOWN issue=3883 want=sonnet got=- attempt=2');
  });

  it('a model that shows up on a later read is taken (no restart)', () => {
    const fake = fakeCli({ models: [null, 'claude-sonnet-5-5'] });
    expect(go(fake, sendArgv('--model', 'sonnet')).code).toBe(0);
    expect(fake.calls.filter((c) => c[1] === 'send')).toHaveLength(1);
  });

  it('a settings file git does not ignore: nothing is sent (exit 2)', () => {
    const fake = fakeCli({ models: ['claude-opus-5-5'], ignored: false });
    expect(go(fake, sendArgv('--model', 'opus')).code).toBe(2);
    expect(fake.calls.some((c) => c[1] === 'send')).toBe(false);
  });

  it('without a model (Antigravity) it only sends: no kill, no settings, no capture (negative control)', () => {
    const fake = fakeCli({ running: true });
    const r = go(fake, [...sendArgv('--model', '-').map((a) => (a === 'claude' ? 'antigravity' : a))]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['task-1']);
    expect(verbs(fake)).toEqual(['send']);
    expect(fs.existsSync(path.join(worktree, '.claude'))).toBe(false);
  });

  it('a send that fails keeps its exit code and is not checked (3-1 cold start)', () => {
    const fake = fakeCli({ sendExit: 99 });
    const r = go(fake, sendArgv('--model', 'opus'));
    expect(r.code).toBe(99);
    expect(r.out).toEqual([]);
    expect(fake.calls.some((c) => c[1] === 'capture')).toBe(false);
  });
});

describe('send: files of its own per send (#3883 send-<issue>.out)', () => {
  it('two sends of one Issue do not share .out / .err, and a work item names its own', () => {
    const fake = fakeCli({ models: ['claude-opus-5-5'] });
    go(fake, sendArgv('--model', 'opus'));
    go(fake, sendArgv('--model', 'opus'));
    go(fake, sendArgv('--model', 'opus', '--item', 'd2'));
    expect(fs.readdirSync(runDir).sort()).toEqual([
      'send-3883-d2.err', 'send-3883-d2.out', 'send-3883.a2.err', 'send-3883.a2.out', 'send-3883.err', 'send-3883.out',
    ]);
    expect(fs.readFileSync(path.join(runDir, 'send-3883.out'), 'utf8')).toBe('task-1\n');
    expect(fs.readFileSync(path.join(runDir, 'send-3883.a2.out'), 'utf8')).toBe('task-2\n');
  });

  it('a restart takes the next files too (the first send stays readable)', () => {
    const fake = fakeCli({ models: ['claude-fable-5-1', 'claude-opus-5-5'] });
    go(fake, sendArgv('--model', 'opus'));
    expect(fs.readFileSync(path.join(runDir, 'send-3883.out'), 'utf8')).toBe('task-1\n');
    expect(fs.readFileSync(path.join(runDir, 'send-3883.a2.out'), 'utf8')).toBe('task-2\n');
  });
});

describe('parseArgs / set-model / check-model', () => {
  it('rejects unknown models, a missing model for set-model, a bad duration and a bad item', () => {
    expect(parseArgs(['set-model', '--worktree', worktree]).error).toMatch(/--model is required/);
    expect(parseArgs(['set-model', '--worktree', worktree, '--model', 'fable']).error).toMatch(/--model must be/);
    expect(parseArgs([...sendArgv('--model', 'opus'), '--duration', '2h']).error).toMatch(/--duration/);
    expect(parseArgs([...sendArgv(), '--item', '../x']).error).toMatch(/--item/);
    expect(parseArgs(sendArgv()).options).toMatchObject({ model: '-', duration: '3h', cli: 'commandmatedev' });
  });

  it('check-model exits 0 / 40 / 41 and prints the model', () => {
    for (const [models, code] of [[['claude-opus-5-5'], 0], [['claude-fable-5-1'], EXIT_MODEL_MISMATCH], [[null], EXIT_MODEL_UNKNOWN]] as const) {
      const fake = fakeCli({ models: [...models] });
      expect(go(fake, ['check-model', '--wt', 'wt-1', '--model', 'opus']).code).toBe(code);
    }
  });

  it('set-model through main writes the file', () => {
    const fake = fakeCli();
    expect(go(fake, ['set-model', '--worktree', worktree, '--model', 'sonnet']).code).toBe(0);
    expect(localSettings()).toEqual({ model: 'sonnet' });
  });
});
