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
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

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

const TEST_PORT = 3457;

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

beforeAll(() => {
  fs.rmSync(DEMO_HOME, { recursive: true, force: true });
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

const stubEnv = {
  CM_DEMO_SERVER_CMD: `node ${STUB}`,
  CM_DEMO_PROC_MATCH: 'stub-server.js',
  CM_DEMO_READY_TIMEOUT: '30',
  CM_DEMO_PORT: String(TEST_PORT),
};

describe('env-up refuses configurations that could reach a live instance', () => {
  it('refuses port 3000', () => {
    const result = run(ENV_UP, [], { ...stubEnv, CM_DEMO_PORT: '3000' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must not be 3000');
    expect(fs.existsSync(STATE_FILE)).toBe(false);
  });

  it('refuses a state dir outside $HOME', () => {
    const result = run(ENV_UP, [], { ...stubEnv, CM_DEMO_HOME: '/tmp/commandmate-demo' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must live under $HOME');
  });

  it('refuses to start on top of an existing state file', () => {
    fs.writeFileSync(STATE_FILE, 'CM_DEMO_PID=1\n');
    const result = run(ENV_UP, [], stubEnv);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('run env-down.sh first');
    fs.rmSync(STATE_FILE);
  });
});

describe('env-up boots an isolated instance', () => {
  it('waits for the port to answer, records state and seeds three worktrees', async () => {
    const result = run(ENV_UP, [], stubEnv);
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

  it('fails and cleans up when the server never answers on the demo port', async () => {
    const result = run(ENV_UP, [], {
      ...stubEnv,
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
      ...stubEnv,
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
    expect(run(ENV_UP, [], stubEnv).status).toBe(0);
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
    expect(run(ENV_UP, [], stubEnv).status).toBe(0);
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
    expect(run(ENV_UP, [], stubEnv).status).toBe(0);
    const state = readState();

    const result = run(ENV_DOWN, []);
    expect(result.status).toBe(0);
    expect(alive(Number(state.CM_DEMO_PID))).toBe(false);
    expect(fs.existsSync(STATE_FILE)).toBe(false);
    expect(fs.existsSync(state.CM_DEMO_SEED_ROOT)).toBe(false);
    await expect(portListening(TEST_PORT)).resolves.toBe(false);
  }, 60_000);

  it('--purge removes the demo database together with its WAL sidecars', () => {
    expect(run(ENV_UP, [], stubEnv).status).toBe(0);
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

  it('reports there is nothing to stop when no state file exists', () => {
    const result = run(ENV_DOWN, []);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nothing to stop');
  });
});
