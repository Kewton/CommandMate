/**
 * env-up.sh readiness asks who listens on the port, not only whether it answers
 * (Issue #3463).
 *
 * pick_port's probe is not a hold: another process can take the demo port
 * between the probe and the server's bind. The server then dies of EADDRINUSE,
 * and for the moment before it does, `curl $BASE_URL/` gets the other
 * process's 200. Readiness used to be `kill -0 $SERVER_PID` + that 200, so the
 * other process became the demo's server.
 *
 * The race is staged deterministically: the server stub never listens (it is
 * "about to fail"), and the test binds the port itself once the stub is up —
 * after pick_port has already called the port free. The stub writes its pid to
 * a file so the test knows the moment.
 *
 * Like env-scripts.test.ts this runs the real script against node stubs. Unlike
 * it, HOME is a private dir under os.tmpdir(): nothing here starts a real
 * server, so validateDbPath's refusal of /tmp and /var never comes into play,
 * and env-up's own guard only needs the state dir under $HOME.
 *
 * @vitest-environment node
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ENV_UP = path.join(REPO_ROOT, '.claude/skills/demo-video/scripts/env-up.sh');

/**
 * Same band and same pid-derived start as env-scripts.test.ts (Issue #3462):
 * below every platform's ephemeral range, clear of every port the suite or the
 * app binds. A pair is reserved so the two files pick from the same grid.
 */
const PORT_BAND_START = 24000;
const EPHEMERAL_PORT_FLOOR = 32768;
const PORT_BAND_PAIRS = 500;

const has = (cmd: string) =>
  spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
/** What env-up names a listener with: lsof anywhere, fuser's `<port>/tcp` on Linux. */
const CAN_NAME_LISTENER = has('lsof') || (process.platform === 'linux' && has('fuser'));

let SCRATCH_HOME = '';
let DEMO_HOME = '';
let STATE_FILE = '';
let STARTED_FILE = '';
let STUB_SERVER = '';
let STUB_FORKS = '';
let STUB_SILENT = '';
let TEST_PORT = 0;

/** Processes this file started directly; afterEach stops exactly these. */
const started: ChildProcess[] = [];

async function portBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

function readState(): Record<string, string> {
  const state: Record<string, string> = {};
  for (const line of fs.readFileSync(STATE_FILE, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) state[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return state;
}

function envUpEnv(serverCmd: string, procMatch: string): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: SCRATCH_HOME,
    CODEX_HOME: undefined,
    CM_DEMO_HOME: DEMO_HOME,
    CM_DEMO_REPO_ROOT: REPO_ROOT,
    CM_DEMO_SERVER_CMD: serverCmd,
    CM_DEMO_PROC_MATCH: procMatch,
    CM_DEMO_READY_TIMEOUT: '30',
    CM_DEMO_PORT: String(TEST_PORT),
    STUB_STARTED: STARTED_FILE,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env as NodeJS.ProcessEnv;
}

/** Run a copy of env-up asynchronously, so the test can act while it waits for readiness. */
function runEnvUp(script: string, env: NodeJS.ProcessEnv) {
  const child = spawn('bash', [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  started.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk) => { stdout += chunk; });
  child.stderr!.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  return { child, done };
}

/** Another process taking the port: answers 200 like any HTTP server would. */
async function startForeignListener(port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('http').createServer((_q, s) => { s.writeHead(200); s.end('someone-else'); })
         .listen(${port}, '127.0.0.1', () => console.log('listening'));`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  started.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`foreign listener exited (${code})`)));
  });
  return child;
}

/** The pid the server stub wrote once it was up, or 0. */
function stubPid(): number {
  if (!fs.existsSync(STARTED_FILE)) return 0;
  return Number(fs.readFileSync(STARTED_FILE, 'utf8').trim()) || 0;
}

beforeAll(async () => {
  TEST_PORT = await reserveDemoPortPair();
  SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-video-owner-'));
  DEMO_HOME = path.join(SCRATCH_HOME, '.commandmate-demo');
  STATE_FILE = path.join(DEMO_HOME, 'state.env');
  STARTED_FILE = path.join(SCRATCH_HOME, 'stub-started');
  STUB_SERVER = path.join(SCRATCH_HOME, 'stub-owner-server.js');
  STUB_FORKS = path.join(SCRATCH_HOME, 'stub-owner-forks.js');
  STUB_SILENT = path.join(SCRATCH_HOME, 'stub-owner-silent.js');
  fs.mkdirSync(DEMO_HOME, { recursive: true });

  const announce = `require('fs').writeFileSync(process.env.STUB_STARTED, String(process.pid));`;
  const listen = `require('http').createServer((_q, s) => { s.writeHead(200); s.end('demo-stub'); })
       .listen(Number(process.env.CM_PORT), '127.0.0.1');`;
  // The listener is the server process itself (what env-up sees for `node`).
  fs.writeFileSync(STUB_SERVER, `${announce}\n${listen}\nsetInterval(() => {}, 1 << 30);\n`);
  // The listener is a child of the server process, as under `tsx server.ts`,
  // which forks the node process that binds.
  fs.writeFileSync(
    STUB_FORKS,
    `${announce}
     const child = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
       `${listen}\nsetInterval(() => {}, 1 << 30);`,
     )}], { stdio: 'inherit' });
     process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });
     setInterval(() => {}, 1 << 30);\n`,
  );
  // The server that is about to die of EADDRINUSE: alive, never listening.
  fs.writeFileSync(STUB_SILENT, `${announce}\nsetInterval(() => {}, 1 << 30);\n`);
});

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  // A boot that succeeded left its server running in its own process group,
  // which env-up started for this test.
  if (fs.existsSync(STATE_FILE)) {
    const state = readState();
    const pid = Number(state.CM_DEMO_PID);
    if (pid > 1 && alive(pid)) {
      if (state.CM_DEMO_PGID === state.CM_DEMO_PID) process.kill(-pid, 'SIGKILL');
      else process.kill(pid, 'SIGKILL');
    }
    fs.rmSync(STATE_FILE, { force: true });
  }
  const pid = stubPid();
  if (pid > 1 && alive(pid)) process.kill(pid, 'SIGKILL');
  fs.rmSync(STARTED_FILE, { force: true });
  // Each env-up seeds afresh and refuses nothing over an existing seed, but
  // the git worktrees are cheaper to drop than to reason about.
  fs.rmSync(path.join(DEMO_HOME, 'seed'), { recursive: true, force: true });
});

afterAll(() => {
  if (SCRATCH_HOME) removeTempDir(SCRATCH_HOME);
});

describe('env-up listener ownership (Issue #3463)', () => {
  it('uses the env-scripts port band, below every ephemeral range', () => {
    expect(PORT_BAND_START + PORT_BAND_PAIRS * 2 - 1).toBeLessThan(EPHEMERAL_PORT_FLOOR);
    expect(TEST_PORT).toBeGreaterThanOrEqual(PORT_BAND_START);
  });

  it.skipIf(!CAN_NAME_LISTENER)(
    'fails the boot when another process answers on the port, and leaves that process alone',
    async () => {
      const { done } = runEnvUp(ENV_UP, envUpEnv(`node ${STUB_SILENT}`, 'stub-owner-silent.js'));
      // pick_port has called the port free and the server is up: take the port now.
      expect(await until(() => stubPid() > 0, 30_000)).toBe(true);
      const serverPid = stubPid();
      const foreign = await startForeignListener(TEST_PORT);

      const result = await done;
      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain('not by the server env-up started');
      expect(result.stderr).toContain(`pid ${foreign.pid}`);
      expect(fs.existsSync(STATE_FILE)).toBe(false);
      // The failed boot stopped its own server…
      expect(await until(() => !alive(serverPid), 5_000)).toBe(true);
      // …and only its own: the other process still holds the port.
      expect(alive(foreign.pid!)).toBe(true);
    },
    60_000,
  );

  it.skipIf(!CAN_NAME_LISTENER)(
    'is not vacuous: without the owner check the same race reads as ready',
    async () => {
      const original = fs.readFileSync(ENV_UP, 'utf8');
      const needle = 'foreign="$(check_listener_owner)"';
      expect(original).toContain(needle);
      const mutated = path.join(SCRATCH_HOME, 'env-up-no-owner-check.sh');
      fs.writeFileSync(mutated, original.replace(needle, 'foreign=""; true'));

      const { done } = runEnvUp(mutated, envUpEnv(`node ${STUB_SILENT}`, 'stub-owner-silent.js'));
      expect(await until(() => stubPid() > 0, 30_000)).toBe(true);
      await startForeignListener(TEST_PORT);

      const result = await done;
      expect(result.status, result.stderr).toBe(0);
      expect(readState().CM_DEMO_PID).toBe(String(stubPid()));
    },
    60_000,
  );

  it('boots when the server it started is the listener', async () => {
    const { done } = runEnvUp(ENV_UP, envUpEnv(`node ${STUB_SERVER}`, 'stub-owner-server.js'));
    const result = await done;
    expect(result.stderr).toBe('');
    expect(result.status, result.stderr).toBe(0);
    expect(readState().CM_DEMO_PID).toBe(String(stubPid()));
  }, 60_000);

  it('boots when a child of the server it started is the listener', async () => {
    const { done } = runEnvUp(ENV_UP, envUpEnv(`node ${STUB_FORKS}`, 'stub-owner-forks.js'));
    const result = await done;
    expect(result.stderr).toBe('');
    expect(result.status, result.stderr).toBe(0);
    expect(readState().CM_DEMO_PID).toBe(String(stubPid()));
  }, 60_000);
});
