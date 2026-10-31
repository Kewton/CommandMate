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
  EXIT_AUTO_YES_UNCONFIRMED,
  EXIT_STOP_UNCONFIRMED,
  DISARM_ATTEMPTS,
  INIT_MESSAGE,
  MODEL_READS,
  READY_MAX_POLLS,
  STOP_READS,
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

/**
 * A fake commandmatedev: the starting message starts the session, a contract
 * send answers with a task id, capture --json reports the models in turn (and
 * `ready`), kill stops the session unless told not to.
 */
function fakeCli({
  models = [] as (string | null)[],
  sendExit = 0,
  initExit = 0,
  running = true,
  ignored = true,
  killExit = 0,
  killStops = true,
  listExit = 0,
  ready = true,
  armed = false,
  disableExit = 0,
  disableSticks = false,
} = {}) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  /** Whether the Auto-Yes grant was on at each starting message (it must never be, #3883 N7). */
  const armedAtInit: boolean[] = [];
  let tasks = 0;
  let inits = 0;
  let captures = 0;
  let alive = running;
  // The grant is the worktree × instance's, kept whether or not a session runs (as the state store keeps it).
  let grant = armed;
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === 'git') return { status: ignored ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'instances' && args[2] === '--json') {
      return listExit === 0
        ? { status: 0, stdout: JSON.stringify([{ instanceId: 'claude', running: alive, autoYes: grant }]), stderr: '' }
        : { status: listExit, stdout: '', stderr: 'ECONNREFUSED' };
    }
    if (args[0] === 'auto-yes' && args.includes('--disable')) {
      if (disableExit !== 0) return { status: disableExit, stdout: '', stderr: 'Error: server down' };
      if (!disableSticks) grant = false;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'instances' && args[2] === 'kill') {
      if (killExit !== 0) return { status: killExit, stdout: '', stderr: 'Error: Failed to kill session' };
      if (killStops) alive = false;
      return { status: 0, stdout: '', stderr: 'Session killed: claude' };
    }
    if (args[0] === 'send') {
      if (sendExit !== 0) return { status: sendExit, stdout: '', stderr: 'prompt not ready' };
      alive = true;
      if (args.includes('--auto-yes')) grant = true;
      if (!args.includes('--contract') && initExit !== 0) return { status: initExit, stdout: '', stderr: 'initialization timeout' };
      if (!args.includes('--contract')) {
        armedAtInit.push(grant);
        inits += 1;
        return { status: 0, stdout: '', stderr: `Message sent. init-${inits}\n` };
      }
      tasks += 1;
      return { status: 0, stdout: `task-${tasks}\n`, stderr: `Task created: task-${tasks}\n` };
    }
    if (args[0] === 'capture') {
      const model = models[Math.min(captures, models.length - 1)] ?? null;
      captures += 1;
      const sessionStatus = ready ? 'ready' : 'running';
      return { status: 0, stdout: JSON.stringify(model === null ? { sessionStatus } : { model, sessionStatus }), stderr: '' };
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`);
  };
  return { run, calls, sleeps, armedAtInit, sleep: (ms: number) => sleeps.push(ms) };
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
  fake.calls.map((c) =>
    c[0] === 'git' ? 'git' : c[1] === 'instances' ? `instances ${c[3]}` : c[1] === 'send' ? (c.includes('--contract') ? 'send contract' : 'send init') : c[1]
  );
const contractSends = (fake: ReturnType<typeof fakeCli>) => fake.calls.filter((c) => c[1] === 'send' && c.includes('--contract'));
const autoYes = (fake: ReturnType<typeof fakeCli>) => fake.calls.filter((c) => c.includes('--auto-yes'));
/** A stop that was asked for and then read back as stopped. */
const STOP = ['instances --json', 'instances kill', 'instances --json'];
/** Auto-Yes turned off and read back off (#3883 N7). */
const DISARM = ['auto-yes', 'instances --json'];

describe('send: model pinned, sent, checked (P3)', () => {
  it('stops a running session, writes the model, sends, then reads the model back', () => {
    const fake = fakeCli({ models: ['claude-opus-5-5'] });
    const r = go(fake, sendArgv('--model', 'opus'));
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['task-1']);
    expect(verbs(fake)).toEqual([...STOP, ...DISARM, 'git', 'send init', 'capture', 'capture', 'capture', 'send contract']);
    expect(localSettings()).toEqual({ model: 'opus[1m]' });
    expect(fake.calls.find((c) => c[1] === 'send')).toEqual(['commandmatedev', 'send', 'wt-1', INIT_MESSAGE, '--instance', 'claude']);
    expect(contractSends(fake)[0]).toEqual([
      'commandmatedev', 'send', 'wt-1', '--contract', '.commandmate/tasks/issue-3883.yaml', '--instance', 'claude', '--auto-yes', '--duration', '3h',
    ]);
    expect(r.log.join('\n')).toContain('model ok issue=3883 want=opus got=claude-opus-5-5');
  });

  it('a mismatch restarts once (kill, write, send again) and goes on when the second matches', () => {
    const fake = fakeCli({ models: ['claude-fable-5-1', 'claude-opus-5-5'] });
    const r = go(fake, sendArgv('--model', 'opus'));
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['task-1']);
    expect(verbs(fake)).toEqual([
      ...STOP, ...DISARM, 'git', 'send init', 'capture', ...STOP,
      'instances --json', ...DISARM, 'git', 'send init', 'capture', 'capture', 'capture', 'send contract',
    ]);
    expect(r.log.join('\n')).toContain('model MISMATCH issue=3883 want=opus got=claude-fable-5-1 attempt=1');
  });

  it('a mismatch that stays stops the session and fails (does not go on with the wrong model)', () => {
    const fake = fakeCli({ models: ['claude-fable-5-1'] });
    const r = go(fake, sendArgv('--model', 'opus'));
    expect(r.code).toBe(EXIT_MODEL_MISMATCH);
    expect(r.out).toEqual([]);
    expect(verbs(fake).slice(-3)).toEqual(STOP);
    expect(fake.calls.filter((c) => c[1] === 'send')).toHaveLength(2);
    // The contract and Auto-Yes never reached a session on the wrong model.
    expect(contractSends(fake)).toEqual([]);
    expect(autoYes(fake)).toEqual([]);
  });

  it('an unknown model is read again, restarts once, and fails as unknown', () => {
    const fake = fakeCli({ models: [null] });
    const r = go(fake, sendArgv('--model', 'sonnet'));
    expect(r.code).toBe(EXIT_MODEL_UNKNOWN);
    expect(fake.calls.filter((c) => c[1] === 'capture')).toHaveLength(MODEL_READS * 2);
    expect(fake.sleeps.length).toBe((MODEL_READS - 1) * 2);
    expect(verbs(fake).slice(-3)).toEqual(STOP);
    expect(contractSends(fake)).toEqual([]);
    expect(r.log.join('\n')).toContain('model UNKNOWN issue=3883 want=sonnet got=- attempt=2');
  });

  it('a model that shows up on a later read is taken (no restart)', () => {
    const fake = fakeCli({ models: [null, 'claude-sonnet-5-5'] });
    expect(go(fake, sendArgv('--model', 'sonnet')).code).toBe(0);
    expect(verbs(fake).filter((v) => v === 'send init')).toHaveLength(1);
    expect(contractSends(fake)).toHaveLength(1);
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
    expect(verbs(fake)).toEqual(['send contract']);
    expect(fs.existsSync(path.join(worktree, '.claude'))).toBe(false);
  });

  it('a send that fails keeps its exit code and is not checked (3-1 cold start)', () => {
    const fake = fakeCli({ sendExit: 99 });
    const r = go(fake, sendArgv('--model', 'opus'));
    // #3904: 99 is now followed by a read of the screen; nothing readable means the usual restart, then 41.
    expect(r.code).toBe(EXIT_MODEL_UNKNOWN);
    expect(r.out).toEqual([]);
    expect(contractSends(fake)).toEqual([]);
  });

  it('a send that fails with another exit code keeps it and is not checked', () => {
    const fake = fakeCli({ sendExit: 7 });
    const r = go(fake, sendArgv('--model', 'opus'));
    expect(r.code).toBe(7);
    expect(fake.calls.some((c) => c[1] === 'capture')).toBe(false);
  });

  it('#3904: exit 99 on the starting message but the model reads: the contract is sent once and the .err says so', () => {
    const fake = fakeCli({ models: ['claude-sonnet-5-5'], initExit: 99 });
    const r = go(fake, sendArgv('--model', 'sonnet'));
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['task-1']);
    expect(contractSends(fake)).toHaveLength(1);
    expect(fake.calls.filter((c) => c[1] === 'send' && !c.includes('--contract'))).toHaveLength(1);
    expect(fs.readFileSync(path.join(runDir, 'send-init-3883.err'), 'utf8')).toContain('prompt was reached');
  });

  it('#3904: exit 99 and the model never reads: restarted once, then 41, no contract', () => {
    const fake = fakeCli({ models: [null], initExit: 99 });
    const r = go(fake, sendArgv('--model', 'sonnet'));
    expect(r.code).toBe(EXIT_MODEL_UNKNOWN);
    expect(fake.calls.filter((c) => c[1] === 'send' && !c.includes('--contract'))).toHaveLength(2);
    expect(contractSends(fake)).toEqual([]);
  });
});

describe('send: the contract and Auto-Yes go out only after the model is confirmed (#3883 N1)', () => {
  it('the starting message carries no contract and no Auto-Yes, and the contract follows the model check', () => {
    const fake = fakeCli({ models: ['claude-opus-5-5'] });
    expect(go(fake, sendArgv('--model', 'opus')).code).toBe(0);
    const v = verbs(fake);
    const firstCapture = v.indexOf('capture');
    expect(v.indexOf('send init')).toBeLessThan(firstCapture);
    expect(v.indexOf('send contract')).toBeGreaterThan(firstCapture);
    expect(autoYes(fake)).toEqual(contractSends(fake));
    const init = fake.calls.find((c) => c[1] === 'send')!;
    expect(init).not.toContain('--contract');
    expect(init).not.toContain('--auto-yes');
  });

  it('a session that does not come back ready after the starting message is stopped and the contract is not sent', () => {
    const fake = fakeCli({ models: ['claude-opus-5-5'], ready: false });
    const r = go(fake, sendArgv('--model', 'opus'));
    expect(r.code).toBe(1);
    expect(contractSends(fake)).toEqual([]);
    expect(fake.calls.filter((c) => c[1] === 'capture')).toHaveLength(1 + READY_MAX_POLLS);
    expect(verbs(fake).slice(-3)).toEqual(STOP);
    expect(r.log.join('\n')).toMatch(/not ready: .*contract not sent/);
  });
});

describe('send: Auto-Yes is off before the session starts, with or without a session (#3883 N7)', () => {
  it('a grant left on with no session running is turned off and read back off before the starting message', () => {
    const fake = fakeCli({ models: ['claude-opus-5-5'], running: false, armed: true });
    expect(go(fake, sendArgv('--model', 'opus')).code).toBe(0);
    expect(fake.calls.some((c) => c[3] === 'kill')).toBe(false);
    expect(fake.calls.find((c) => c[1] === 'auto-yes')).toEqual(['commandmatedev', 'auto-yes', 'wt-1', '--disable', '--instance', 'claude']);
    expect(fake.armedAtInit).toEqual([false]);
    // Auto-Yes comes back only with the contract.
    expect(autoYes(fake)).toEqual(contractSends(fake));
  });

  it('every start of a restart is preceded by the disable too', () => {
    const fake = fakeCli({ models: ['claude-fable-5-1', 'claude-opus-5-5'], armed: true });
    expect(go(fake, sendArgv('--model', 'opus')).code).toBe(0);
    expect(fake.armedAtInit).toEqual([false, false]);
    expect(fake.calls.filter((c) => c[1] === 'auto-yes')).toHaveLength(2);
  });

  it('a disable that fails, or a grant still on after it: nothing is written or sent, exit 43', () => {
    for (const opts of [{ disableExit: 1 }, { disableSticks: true }]) {
      const fake = fakeCli({ models: ['claude-opus-5-5'], running: false, armed: true, ...opts });
      const r = go(fake, sendArgv('--model', 'opus'));
      expect(r.code).toBe(EXIT_AUTO_YES_UNCONFIRMED);
      expect(fake.calls.some((c) => c[1] === 'send')).toBe(false);
      expect(fake.calls.filter((c) => c[1] === 'auto-yes')).toHaveLength(DISARM_ATTEMPTS);
      expect(r.log.join('\n')).toMatch(/auto-yes UNCONFIRMED claude of wt-1: .*\(after 3 attempts\)/);
    }
    expect(fs.existsSync(path.join(worktree, '.claude'))).toBe(false);
  });

  it('a grant that was off is still confirmed off (negative control: the start goes on)', () => {
    const fake = fakeCli({ models: ['claude-opus-5-5'], running: false, armed: false });
    expect(go(fake, sendArgv('--model', 'opus')).code).toBe(0);
    expect(fake.armedAtInit).toEqual([false]);
  });
});

describe('send: a stop is confirmed before anything more is sent (#3883 N2)', () => {
  it('a kill that fails: nothing is written or sent, exit 42 and the fact is said', () => {
    const fake = fakeCli({ models: ['claude-opus-5-5'], killExit: 1 });
    const r = go(fake, sendArgv('--model', 'opus'));
    expect(r.code).toBe(EXIT_STOP_UNCONFIRMED);
    expect(verbs(fake)).toEqual(['instances --json', 'instances kill']);
    expect(fs.existsSync(path.join(worktree, '.claude'))).toBe(false);
    expect(r.log.join('\n')).toMatch(/stop UNCONFIRMED claude of wt-1: .*kill exit=1 Error: Failed to kill session/);
  });

  it('a kill that exits 0 but leaves the session running is not a stop', () => {
    const fake = fakeCli({ models: ['claude-opus-5-5'], killStops: false });
    const r = go(fake, sendArgv('--model', 'opus'));
    expect(r.code).toBe(EXIT_STOP_UNCONFIRMED);
    expect(fake.calls.filter((c) => c[1] === 'instances' && c[3] === '--json')).toHaveLength(1 + STOP_READS);
    expect(fake.calls.some((c) => c[1] === 'send')).toBe(false);
    expect(r.log.join('\n')).toMatch(/still running after 3 reads/);
  });

  it('an instance list that cannot be read is not a stop', () => {
    const fake = fakeCli({ models: ['claude-opus-5-5'], listExit: 1 });
    expect(go(fake, sendArgv('--model', 'opus')).code).toBe(EXIT_STOP_UNCONFIRMED);
    expect(fake.calls.some((c) => c[1] === 'send')).toBe(false);
  });

  it('a mismatch whose stop fails is not restarted: the old session gets no second start and no contract', () => {
    const fake = fakeCli({ models: ['claude-fable-5-1'], running: false, killExit: 1 });
    const r = go(fake, sendArgv('--model', 'opus'));
    expect(r.code).toBe(EXIT_STOP_UNCONFIRMED);
    expect(fake.calls.filter((c) => c[1] === 'send')).toHaveLength(1);
    expect(contractSends(fake)).toEqual([]);
    expect(verbs(fake).slice(-2)).toEqual(['instances --json', 'instances kill']);
  });

  it('a session that is not running is not killed (negative control)', () => {
    const fake = fakeCli({ models: ['claude-opus-5-5'], running: false, killExit: 1 });
    expect(go(fake, sendArgv('--model', 'opus')).code).toBe(0);
    expect(fake.calls.some((c) => c[3] === 'kill')).toBe(false);
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
      'send-init-3883-d2.err', 'send-init-3883-d2.out', 'send-init-3883.a2.err', 'send-init-3883.a2.out', 'send-init-3883.err', 'send-init-3883.out',
    ]);
    expect(fs.readFileSync(path.join(runDir, 'send-3883.out'), 'utf8')).toBe('task-1\n');
    expect(fs.readFileSync(path.join(runDir, 'send-3883.a2.out'), 'utf8')).toBe('task-2\n');
  });

  it('a restart takes the next files too (the first send stays readable)', () => {
    const fake = fakeCli({ models: ['claude-fable-5-1', 'claude-opus-5-5'] });
    go(fake, sendArgv('--model', 'opus'));
    expect(fs.readFileSync(path.join(runDir, 'send-init-3883.err'), 'utf8')).toBe('Message sent. init-1\n');
    expect(fs.readFileSync(path.join(runDir, 'send-init-3883.a2.err'), 'utf8')).toBe('Message sent. init-2\n');
    // The contract went out once, after the restart's model matched.
    expect(fs.readFileSync(path.join(runDir, 'send-3883.out'), 'utf8')).toBe('task-1\n');
    expect(fs.existsSync(path.join(runDir, 'send-3883.a2.out'))).toBe(false);
  });
});

describe('parseArgs / set-model / check-model', () => {
  it('rejects unknown models, a missing model for set-model, a bad duration and a bad item', () => {
    expect(parseArgs(['set-model', '--worktree', worktree]).error).toMatch(/--model is required/);
    expect(parseArgs(['set-model', '--worktree', worktree, '--model', 'fable']).error).toMatch(/--model must be/);
    // Issue #3913: 1h-24h is valid now; the bad duration moved from 2h to 25h.
    expect(parseArgs([...sendArgv('--model', 'opus'), '--duration', '25h']).error).toMatch(/--duration/);
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
