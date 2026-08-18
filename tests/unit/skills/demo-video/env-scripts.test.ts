/**
 * env-up.sh / env-down.sh isolation and teardown (Issue #1553).
 *
 * These run the real scripts against a stub HTTP server instead of
 * `tsx server.ts`, so the readiness loop, the PID bookkeeping and the refusal
 * paths are exercised for real without a Next.js compile. The refusal cases are
 * the point of the file: a demo run that reaches port 3000 or kills a recycled
 * PID would hit a developer's live instance.
 *
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCRIPTS = path.join(REPO_ROOT, '.claude/skills/demo-video/scripts');
const ENV_UP = path.join(SCRIPTS, 'env-up.sh');
const ENV_DOWN = path.join(SCRIPTS, 'env-down.sh');

// env-up refuses a state dir outside $HOME (validateDbPath rejects /tmp and
// /var as system directories), so the scratch dir has to live under $HOME.
const DEMO_HOME = path.join(os.homedir(), `.commandmate-demo-vitest-${process.pid}`);
const STATE_FILE = path.join(DEMO_HOME, 'state.env');
const STUB = path.join(DEMO_HOME, 'stub-server.js');
const STUB_WRONG_PORT = path.join(DEMO_HOME, 'stub-wrong-port.js');
const STUB_EXITS = path.join(DEMO_HOME, 'stub-exits.js');

/**
 * A fake `tmux`, so the teardown selection can be asserted without a real tmux
 * server anywhere near it.
 *
 * This is not squeamishness: on 2026-08-02 a live tmux test in this repository
 * killed every running `mcbd-*` session on the machine, and the developer's own
 * sessions live on the same default socket the demo scripts talk to. A stub
 * makes "which names would you have killed" observable and unkillable.
 */
const BIN_DIR = path.join(DEMO_HOME, 'bin');
const TMUX_STUB = path.join(BIN_DIR, 'tmux');
const TMUX_KILL_LOG = path.join(DEMO_HOME, 'tmux-kills.log');
const TMUX_SESSION_LIST = path.join(DEMO_HOME, 'tmux-sessions.txt');

/**
 * Live session names as seen on a developer machine mid-work.
 *
 * The last four are the developer's own — sampled from a real
 * `tmux list-sessions` — and the assertion that none of them is touched is the
 * point of the fixture.
 */
const LIVE_SESSIONS = [
  'mcbd-claude-wt-dark-mode',
  'mcbd-claude-cmdemo-app',
  'mcbd-codex-wt-api-cache-2',
  'mcbd-claude-commandmate-issue-1809',
  'mcbd-claude-mycodebranchdesk',
  'mcbd-codex-commandagent-develop',
  'mcbd-antigravity-zenn-content-develop',
];

/**
 * Port band this file allocates its demo port pair from.
 *
 * Chosen to sit clear of everything else the suite or the app binds (3000/3001,
 * 3011, 3100-3135, 3399+, 3999, 4000, 4200-4299, 4242, 4321, 5000, 6030, 8501)
 * and below the OS ephemeral range (49152+ on macOS), so a reservation here
 * cannot lose a race with a socket the kernel handed out.
 */
const PORT_BAND_START = 34000;
/** Pairs available in the band; the port and port+1 are both reserved. */
const PORT_BAND_PAIRS = 500;

/**
 * The demo port for THIS process, chosen in `beforeAll` (Issue #1791 follow-up).
 *
 * It used to be the constant 3457, which made this file isolated per process
 * for its filesystem (`DEMO_HOME` is keyed by `process.pid`) and *not* for its
 * port. Any second test process on the machine — `npm run test:unit` in another
 * worktree, a second full run started while one is in flight, or a stub leaked
 * by a run that was interrupted before `afterEach` — took 3457 first, and
 * env-up then died with `port 3457 is already in use`. That turns exactly 7 of
 * these 11 tests red (measured), and the red lands on whatever diff happened to
 * be under test rather than on the collision: the failure was reproduced here
 * by running two suites at once, which is precisely what comparing a branch
 * against `origin/develop` in a second checkout does.
 *
 * A pair, not a single port: the wrong-port stub deliberately binds CM_PORT + 1,
 * so that case only proves anything if both are free.
 */
let TEST_PORT = 0;

/** Whether 127.0.0.1:port can be bound right now. env-up binds loopback only. */
async function portBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/**
 * Reserve a free port pair, starting from a pid-derived offset.
 *
 * The pid start is what keeps two concurrent processes off each other: they do
 * not merely resolve a collision, they never probe the same pair first. The
 * bind probe is the second line of defence, against a port held by something
 * that is not a test process at all.
 */
async function reserveDemoPortPair(): Promise<number> {
  const start = process.pid % PORT_BAND_PAIRS;
  for (let offset = 0; offset < PORT_BAND_PAIRS; offset += 1) {
    const port = PORT_BAND_START + (((start + offset) % PORT_BAND_PAIRS) * 2);
    if ((await portBindable(port)) && (await portBindable(port + 1))) return port;
  }
  throw new Error(
    `no free port pair in ${PORT_BAND_START}..${PORT_BAND_START + PORT_BAND_PAIRS * 2 - 1}`,
  );
}

function run(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CM_DEMO_HOME: DEMO_HOME,
      CM_DEMO_REPO_ROOT: REPO_ROOT,
      ...env,
    },
  });
}

function readState(): Record<string, string> {
  const state: Record<string, string> = {};
  for (const line of fs.readFileSync(STATE_FILE, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) state[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return state;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

beforeAll(async () => {
  TEST_PORT = await reserveDemoPortPair();
  removeTempDir(DEMO_HOME);
  fs.mkdirSync(DEMO_HOME, { recursive: true });
  fs.writeFileSync(
    STUB,
    `require('http').createServer((_q, s) => { s.writeHead(200); s.end('demo-stub'); })
       .listen(Number(process.env.CM_PORT), '127.0.0.1');
     setInterval(() => {}, 1 << 30);\n`,
  );
  fs.writeFileSync(
    STUB_WRONG_PORT,
    `require('http').createServer((_q, s) => { s.writeHead(200); s.end('elsewhere'); })
       .listen(Number(process.env.CM_PORT) + 1, '127.0.0.1');
     setInterval(() => {}, 1 << 30);\n`,
  );
  fs.writeFileSync(STUB_EXITS, 'process.exit(3);\n');

  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(
    TMUX_STUB,
    [
      '#!/usr/bin/env bash',
      'case "$1" in',
      '  list-sessions) cat "$TMUX_STUB_SESSIONS" ;;',
      // `kill-session -t =NAME`: record the target verbatim, exact-match sigil
      // included, so a pattern-style target could not pass unnoticed.
      '  kill-session) printf \'%s\\n\' "$3" >>"$TMUX_STUB_LOG" ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
});

afterEach(() => {
  if (fs.existsSync(STATE_FILE)) {
    const state = readState();
    run(ENV_DOWN, []);
    if (state.CM_DEMO_PID && alive(Number(state.CM_DEMO_PID))) {
      process.kill(Number(state.CM_DEMO_PID), 'SIGKILL');
    }
    fs.rmSync(STATE_FILE, { force: true });
  }
});

// The scratch dir has to sit under $HOME (env-up refuses anything else, because
// validateDbPath rejects /tmp and /var), which makes leaving it behind a leak
// into a real user's home: one directory per `npm run test:unit`, never
// collected. afterAll still runs when a test — or beforeAll — fails, and the
// removal is force/recursive so it cannot throw and mask that failure.
// `no-home-leftovers.test.ts` runs this file in a child process and asserts the
// directory is gone afterwards, so deleting this hook turns that test red.
afterAll(() => {
  removeTempDir(DEMO_HOME);
});

/**
 * The env every passing-boot case runs env-up with.
 *
 * A function rather than a constant because `CM_DEMO_PORT` is only known once
 * `beforeAll` has reserved it; an object built at module scope would freeze the
 * placeholder 0.
 */
function stubEnv(): Record<string, string> {
  return {
    CM_DEMO_SERVER_CMD: `node ${STUB}`,
    CM_DEMO_PROC_MATCH: 'stub-server.js',
    CM_DEMO_READY_TIMEOUT: '30',
    CM_DEMO_PORT: String(TEST_PORT),
  };
}

describe('env-up refuses configurations that could reach a live instance', () => {
  it('refuses port 3000', () => {
    const result = run(ENV_UP, [], { ...stubEnv(), CM_DEMO_PORT: '3000' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must not be 3000');
    expect(fs.existsSync(STATE_FILE)).toBe(false);
  });

  it('refuses a state dir outside $HOME', () => {
    const result = run(ENV_UP, [], { ...stubEnv(), CM_DEMO_HOME: '/tmp/commandmate-demo' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must live under $HOME');
  });

  it('refuses to start on top of an existing state file', () => {
    fs.writeFileSync(STATE_FILE, 'CM_DEMO_PID=1\n');
    const result = run(ENV_UP, [], stubEnv());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('run env-down.sh first');
    fs.rmSync(STATE_FILE);
  });
});

describe('env-up boots an isolated instance', () => {
  it('waits for the port to answer, records state and seeds three worktrees', async () => {
    const result = run(ENV_UP, [], stubEnv());
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const state = readState();
    expect(state.CM_DEMO_PORT).toBe(String(TEST_PORT));
    expect(state.CM_DEMO_BASE_URL).toBe(`http://127.0.0.1:${TEST_PORT}`);
    expect(state.CM_DEMO_DB_PATH).toBe(path.join(DEMO_HOME, 'cm.db'));
    expect(alive(Number(state.CM_DEMO_PID))).toBe(true);
    // Readiness is a real HTTP round trip, not a log line.
    await expect(portListening(TEST_PORT)).resolves.toBe(true);

    const worktrees = spawnSync('git', ['-C', state.CM_DEMO_SEED_REPO, 'worktree', 'list'], {
      encoding: 'utf8',
    }).stdout;
    expect(worktrees).toContain('[main]');
    expect(worktrees).toContain('[feature/demo-dark-mode]');
    expect(worktrees).toContain('[fix/demo-login-error]');
  }, 60_000);

  it('records the worktree ids the server will mint, and the paths they came from', async () => {
    // Issue #1809. The ids are `sanitize(basename(path))` (deriveWorktreeId,
    // src/lib/git/worktree-id.ts) — a rule the harness must not restate as
    // constants, so env-up derives them from the directories it just created
    // and hands them on through state.env. record-scenes.test.ts runs the
    // product function over the same directory names.
    expect(run(ENV_UP, [], stubEnv()).status).toBe(0);
    const state = readState();

    expect(state.CM_DEMO_PRIMARY_WORKTREE_ID).toBe('cmdemo-app');
    expect(state.CM_DEMO_WORKTREE_ID).toBe('wt-dark-mode');
    expect(state.CM_DEMO_LOGIN_WORKTREE_ID).toBe('wt-login-error');
    expect(state.CM_DEMO_UNSYNCED_WORKTREE_ID).toBe('wt-api-cache');

    expect(state.CM_DEMO_WORKTREE_PATH).toBe(path.join(state.CM_DEMO_SEED_ROOT, 'wt-dark-mode'));
    expect(state.CM_DEMO_LOGIN_WORKTREE_PATH).toBe(
      path.join(state.CM_DEMO_SEED_ROOT, 'wt-login-error'),
    );
    expect(state.CM_DEMO_UNSYNCED_WORKTREE_PATH).toBe(
      path.join(state.CM_DEMO_SEED_ROOT, 'wt-api-cache'),
    );
    // Every recorded directory exists and its basename IS the recorded id, so a
    // renamed seed directory cannot leave an id behind that nothing answers to.
    for (const [id, dir] of [
      [state.CM_DEMO_PRIMARY_WORKTREE_ID, state.CM_DEMO_SEED_REPO],
      [state.CM_DEMO_WORKTREE_ID, state.CM_DEMO_WORKTREE_PATH],
      [state.CM_DEMO_LOGIN_WORKTREE_ID, state.CM_DEMO_LOGIN_WORKTREE_PATH],
      [state.CM_DEMO_UNSYNCED_WORKTREE_ID, state.CM_DEMO_UNSYNCED_WORKTREE_PATH],
    ]) {
      expect(fs.existsSync(dir)).toBe(true);
      expect(path.basename(dir)).toBe(id);
    }

    // The record fake-agent.sh appends to, created empty so teardown can read
    // it even when no scene ever started an agent.
    expect(state.CM_DEMO_SESSIONS_FILE).toBe(path.join(DEMO_HOME, 'sessions'));
    expect(fs.readFileSync(state.CM_DEMO_SESSIONS_FILE, 'utf8')).toBe('');
  }, 60_000);

  it('seeds the contract, the gate config and the work the gate judges', () => {
    // Issue #1810. The contract allows `src/**` and `test/**` only, and the
    // scope gate reconciles the whole `main..HEAD` diff — so verify.yaml, the
    // contract and the agent command files have to be committed on `main`,
    // before the branches exist. Committed on the feature branch they would be
    // changes outside the allow list, and the contract-verify take would film
    // its own harness failing the gate.
    expect(run(ENV_UP, [], stubEnv()).status).toBe(0);
    const state = readState();
    const onMain = (relative: string) =>
      spawnSync('git', ['-C', state.CM_DEMO_SEED_REPO, 'ls-tree', '--name-only', 'main', relative], {
        encoding: 'utf8',
      }).stdout.trim();

    for (const tracked of [
      '.commandmate/verify.yaml',
      '.commandmate/tasks/dark-mode.yaml',
      'test/theme.test.mjs',
      '.claude/commands/work-plan.md',
      '.claude/skills/cmate-verify/SKILL.md',
      '.agents/skills/cmate-verify/SKILL.md',
    ]) {
      expect(onMain(tracked), `${tracked} is not committed on main`).toBe(tracked);
    }

    // The only difference between the worktree and its base: the work the
    // gate is there to judge, left uncommitted so review-diff has something to
    // click and work-evidence has something to count.
    const dirty = spawnSync('git', ['-C', state.CM_DEMO_WORKTREE_PATH, 'status', '--porcelain'], {
      encoding: 'utf8',
    }).stdout.trim();
    // `trim()` has eaten the leading space of ` M`, so match on the rest: one
    // entry, modified, and it is the file the contract's scope allows.
    expect(dirty).toBe('M src/theme.ts');
  }, 60_000);

  it('proves the seed gate green, and would fail if it were not', () => {
    // The self-check is the reason the take cannot film `GATE unit FAIL`: the
    // gate command is run here, in the worktree, before a server exists. This
    // runs the seed's own gate a second time to show it really passes, and
    // then breaks the work it judges to show the gate is not vacuous.
    expect(run(ENV_UP, [], stubEnv()).status).toBe(0);
    const state = readState();
    const gate = () =>
      spawnSync('node', ['--test'], { cwd: state.CM_DEMO_WORKTREE_PATH, encoding: 'utf8' });

    expect(gate().status).toBe(0);

    const theme = path.join(state.CM_DEMO_WORKTREE_PATH, 'src/theme.ts');
    const original = fs.readFileSync(theme, 'utf8');
    try {
      // Back to what `main` carries: no resolveTheme. The test asserts on the
      // uncommitted work specifically, so this must turn it red.
      fs.writeFileSync(theme, 'export const THEME_STORAGE_KEY = "cmdemo.theme";\n');
      expect(gate().status).not.toBe(0);
    } finally {
      fs.writeFileSync(theme, original);
    }
    expect(gate().status).toBe(0);
  }, 60_000);

  it('fails and cleans up when the server never answers on the demo port', async () => {
    const result = run(ENV_UP, [], {
      ...stubEnv(),
      CM_DEMO_SERVER_CMD: `node ${STUB_WRONG_PORT}`,
      CM_DEMO_PROC_MATCH: 'stub-wrong-port.js',
      CM_DEMO_READY_TIMEOUT: '3',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('did not answer');
    expect(fs.existsSync(STATE_FILE)).toBe(false);
    // The stub bound TEST_PORT+1; if boot cleanup had not run it would still be
    // listening there.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(portListening(TEST_PORT + 1)).resolves.toBe(false);
  }, 60_000);

  it('fails fast when the server exits before becoming ready', () => {
    const result = run(ENV_UP, [], {
      ...stubEnv(),
      CM_DEMO_SERVER_CMD: `node ${STUB_EXITS}`,
      CM_DEMO_PROC_MATCH: 'stub-exits.js',
      CM_DEMO_READY_TIMEOUT: '30',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exited before becoming ready');
    expect(fs.existsSync(STATE_FILE)).toBe(false);
  }, 60_000);
});

describe('env-down stops exactly what env-up started', () => {
  it('refuses a pid whose command line no longer matches', () => {
    expect(run(ENV_UP, [], stubEnv()).status).toBe(0);
    const state = readState();

    const rewritten = fs
      .readFileSync(STATE_FILE, 'utf8')
      .replace(/^CM_DEMO_PROC_MATCH=.*$/m, 'CM_DEMO_PROC_MATCH=some-other-binary');
    fs.writeFileSync(STATE_FILE, rewritten);

    const result = run(ENV_DOWN, []);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to kill it');
    expect(alive(Number(state.CM_DEMO_PID))).toBe(true);
  }, 60_000);

  it('refuses a state file that records port 3000', () => {
    expect(run(ENV_UP, [], stubEnv()).status).toBe(0);
    const state = readState();
    fs.writeFileSync(
      STATE_FILE,
      fs.readFileSync(STATE_FILE, 'utf8').replace(/^CM_DEMO_PORT=.*$/m, 'CM_DEMO_PORT=3000'),
    );

    const result = run(ENV_DOWN, []);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to touch a live CommandMate instance');
    expect(alive(Number(state.CM_DEMO_PID))).toBe(true);
  }, 60_000);

  it('kills the server, frees the port and removes the state file and seed', async () => {
    expect(run(ENV_UP, [], stubEnv()).status).toBe(0);
    const state = readState();

    const result = run(ENV_DOWN, []);
    expect(result.status).toBe(0);
    expect(alive(Number(state.CM_DEMO_PID))).toBe(false);
    expect(fs.existsSync(STATE_FILE)).toBe(false);
    expect(fs.existsSync(state.CM_DEMO_SEED_ROOT)).toBe(false);
    await expect(portListening(TEST_PORT)).resolves.toBe(false);
  }, 60_000);

  it('--purge removes the demo database together with its WAL sidecars', () => {
    expect(run(ENV_UP, [], stubEnv()).status).toBe(0);
    const state = readState();
    // The stub never opens SQLite, so stand the sidecars up explicitly: what is
    // being fixed is that `rm cm.db` alone left megabytes of -wal behind.
    for (const suffix of ['', '-wal', '-shm']) {
      fs.writeFileSync(`${state.CM_DEMO_DB_PATH}${suffix}`, 'x');
    }

    expect(run(ENV_DOWN, ['--purge']).status).toBe(0);
    for (const suffix of ['', '-wal', '-shm']) {
      expect(fs.existsSync(`${state.CM_DEMO_DB_PATH}${suffix}`)).toBe(false);
    }
    expect(fs.existsSync(state.CM_DEMO_VIDEO_DIR)).toBe(false);
  }, 60_000);

  it('kills the sessions this run accounts for and leaves the developer\'s alone', () => {
    expect(run(ENV_UP, [], stubEnv()).status).toBe(0);
    const state = readState();

    // What fake-agent.sh --record-to would have written.
    fs.writeFileSync(state.CM_DEMO_SESSIONS_FILE, 'mcbd-claude-wt-dark-mode\n');
    fs.writeFileSync(TMUX_SESSION_LIST, `${LIVE_SESSIONS.join('\n')}\n`);
    fs.rmSync(TMUX_KILL_LOG, { force: true });

    const result = run(ENV_DOWN, [], {
      PATH: `${BIN_DIR}:${process.env.PATH ?? ''}`,
      TMUX_STUB_LOG: TMUX_KILL_LOG,
      TMUX_STUB_SESSIONS: TMUX_SESSION_LIST,
    });
    expect(result.status).toBe(0);

    const killed = fs.readFileSync(TMUX_KILL_LOG, 'utf8').split('\n').filter(Boolean);
    expect(killed).toEqual([
      // pass 1: the recorded name
      '=mcbd-claude-wt-dark-mode',
      // pass 2: derived from the ids in state.env — a session the demo server
      // started itself, and an extra agent instance
      '=mcbd-claude-cmdemo-app',
      '=mcbd-codex-wt-api-cache-2',
    ]);
    // The record is consumed, so the next teardown cannot chase dead names.
    expect(fs.existsSync(state.CM_DEMO_SESSIONS_FILE)).toBe(false);
  }, 60_000);

  it('would have missed the demo session under the pre-#1809 substring match', () => {
    // Non-vacuity for the test above: the id no longer contains the repository
    // name, so `grep -- '-cmdemo-app-'` — what env-down used to select on —
    // matches none of the sessions this demo now creates, and teardown left the
    // fake agent running.
    expect(LIVE_SESSIONS.filter((name) => name.includes('-cmdemo-app-'))).toEqual([]);
    expect('mcbd-claude-wt-dark-mode').not.toContain('-cmdemo-app-');
  });

  it('reports there is nothing to stop when no state file exists', () => {
    const result = run(ENV_DOWN, []);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nothing to stop');
  });
});
