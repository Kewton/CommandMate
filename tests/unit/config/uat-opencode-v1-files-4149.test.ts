/**
 * Issue #4149 F3: a UAT server's V1 records go under its run.
 *
 * The isolated server wrote the real `~/.commandmate/opencode-sessions.json`, and
 * `opencode-ports.json` would have gone the same way, because `run-server.sh` set
 * neither variable. Everything runs under a private HOME (`os.tmpdir()`); the
 * user's files are not read or written.
 *
 * @vitest-environment node
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';

import {
  REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
  REAL_SHELL_TEST_TIMEOUT_MS,
  assertSubprocessCompleted,
} from '@tests/helpers/real-shell-budget';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { rememberOpencodePort } from '@/lib/hooks/sources/opencode/ports';
import { rememberOpencodeSession } from '@/lib/session/opencode-session-store';

const ROOT = path.resolve(__dirname, '../../..');
const RUN_SERVER = path.join(ROOT, 'scripts/uat/run-server.sh');
const runServer = fs.readFileSync(RUN_SERVER, 'utf8');
const NAMES = ['CM_OPENCODE_SESSION_FILE', 'CM_OPENCODE_PORT_FILE'] as const;
const FILES = ['opencode-sessions.json', 'opencode-ports.json'] as const;

const readChecks = (file: string): string[] =>
  (YAML.parse(fs.readFileSync(path.join(ROOT, '.commandmate', file), 'utf8')) as { isolation: { checks: string[] } })
    .isolation.checks;

const v1Checks = (file: string): string[] => readChecks(file).filter((c) => /CM_OPENCODE_\(?(SESSION|PORT)/.test(c));

const has = (command: string): boolean =>
  spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).status === 0;
const HAS_TOOLS = has('tmux') && has('lsof');

const LISTEN_JS = `
const net = require('net');
const server = net.createServer((s) => s.end());
server.listen(Number(process.env.CM_PORT || 0), '127.0.0.1');
setInterval(() => {}, 1 << 30);
`;

describe('the V1 records, on paper', () => {
  it('are set under the run on the env -i line that starts the server', () => {
    const [line] = runServer
      .replace(/\\\n\s*/g, ' ')
      .split('\n')
      .filter((l) => l.includes('$SERVER_ENTRY'));
    expect(line.trimStart().startsWith('env -i ')).toBe(true);
    for (const assignment of [
      'CM_OPENCODE_SESSION_FILE="$RUN_DIR/opencode-sessions.json"',
      'CM_OPENCODE_PORT_FILE="$RUN_DIR/opencode-ports.json"',
    ]) {
      const at = line.indexOf(assignment);
      expect(at, assignment).toBeGreaterThan(line.indexOf('env -i'));
      expect(at, assignment).toBeLessThan(line.indexOf('nohup'));
    }
  });

  it.each(['uat.yaml', 'uat-own-home.yaml'])('%s checks both on the running process, positive and negative', (file) => {
    const checks = v1Checks(file);
    const positive = checks.find((c) => !c.includes('! ps eww'));
    expect(positive).toContain("grep -qxF 'CM_OPENCODE_SESSION_FILE={run_dir}/opencode-sessions.json'");
    expect(positive).toContain("grep -qxF 'CM_OPENCODE_PORT_FILE={run_dir}/opencode-ports.json'");
    expect(checks.some((c) => c.includes('! ps eww') && c.includes('grep -vF'))).toBe(true);
  });

  it.each(['docs/user-guide/uat-isolation.md', 'docs/en/user-guide/uat-isolation.md'])(
    '%s says where they go and how that is measured',
    (file) => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const name of [...NAMES, ...FILES]) expect(text).toContain(name);
      expect(text).toContain('opencode_v1_real_changed');
    }
  );

  it('the daily check has no writer of them to move: its V1 probe only builds a launch line', () => {
    const dir = path.join(ROOT, 'scripts/agent-health');
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      expect(text, name).not.toMatch(/reserveOpencodeServerPort|allocateOpencodePort|rememberOpencode(Port|Session)/);
    }
    expect(fs.readFileSync(path.join(dir, 'tool-table.ts'), 'utf8')).toMatch(/server\?: 'opencode-v2'/);
  });
});

describe.skipIf(!HAS_TOOLS)('the V1 records, on a running server', () => {
  let root: string;
  let runDir: string;
  let home: string;
  const children: ChildProcess[] = [];

  const baseEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.CM_RUN_LOCK_TOKEN;
    return {
      ...env,
      CM_RUN_LOCK_DIR: path.join(root, 'lock'),
      CM_UAT_SOCK_BASE: root,
      CM_UAT_SERVER_ENTRY: path.join(root, 'listen.js'),
      CODEX_HOME: path.join(root, 'codex'),
      HOME: home,
    };
  };

  const script = (...args: string[]) => {
    const result = spawnSync('bash', [RUN_SERVER, ...args], {
      cwd: ROOT,
      env: baseEnv(),
      encoding: 'utf8',
      timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    });
    assertSubprocessCompleted(result, `run-server.sh ${args[0]}`);
    return result;
  };

  const stateOf = (): Record<string, string> =>
    Object.fromEntries(
      fs
        .readFileSync(path.join(runDir, 'uat-run.state'), 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );

  const processEnv = (pid: number): string[] =>
    spawnSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.split(/\s+/);

  /** Each check as cmate-uat runs it: placeholders filled, in a shell, by exit code. */
  const runCheck = (check: string, port: number): number => {
    const filled = check.replaceAll('{port}', String(port)).replaceAll('{run_dir}', runDir);
    const result = spawnSync('bash', ['-c', filled], { encoding: 'utf8', timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS });
    assertSubprocessCompleted(result, 'isolation check');
    return result.status ?? -1;
  };

  const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    });

  const listensOn = async (port: number): Promise<void> => {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      if (spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`nothing listened on ${port}`);
  };

  /** A server this run did not start, with whatever V1 settings it is given. */
  const startOther = async (env: Record<string, string>): Promise<number> => {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(root, 'listen.js')], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', CM_PORT: String(port), ...env },
      stdio: 'ignore',
    });
    children.push(child);
    await listensOn(port);
    return port;
  };

  const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const real = (name: string): string => path.join(home, '.commandmate', name);
  const target = { worktreeId: 'wt-4149', cliToolId: 'opencode' as const, instanceId: 'opencode' };

  /** The real writers: a V1 port assignment and a V1 session memory. */
  const writeV1Records = (): void => {
    rememberOpencodePort(target, 4100, '/path/to/wt');
    rememberOpencodeSession(target, { sessionId: 'ses_4149abcdef', title: 'x', worktreePath: '/path/to/wt' });
  };

  beforeEach(() => {
    // Short: the socket path under it must stay within macOS's 104 bytes.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'u'));
    runDir = path.join(root, 'run');
    home = path.join(root, 'home');
    fs.mkdirSync(path.join(root, 'codex'));
    fs.mkdirSync(path.join(home, '.commandmate'), { recursive: true });
    fs.writeFileSync(path.join(root, 'listen.js'), LISTEN_JS);
    for (const name of FILES) fs.writeFileSync(real(name), '{}\n');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const child of children.splice(0)) child.kill('SIGKILL');
    const statePath = path.join(runDir, 'uat-run.state');
    if (fs.existsSync(statePath)) {
      const state = stateOf();
      if (state.sock_dir) {
        const socket = path.join(state.sock_dir, 'tmux.sock');
        spawnSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
      }
      const pid = Number(state.server_pid);
      try {
        if (pid > 0) process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    removeTempDir(root);
  });

  it(
    'up gives both to the process, the checks pass, the real writers stay in the run, and the real files keep their hash',
    async () => {
      const port = await freePort();
      const up = script('up', '--port', String(port), '--run-dir', runDir, '--wait-listen', '30');
      expect(up.status, up.stderr).toBe(0);

      const env = processEnv(Number(stateOf().server_pid));
      expect(env).toContain(`CM_OPENCODE_SESSION_FILE=${runDir}/opencode-sessions.json`);
      expect(env).toContain(`CM_OPENCODE_PORT_FILE=${runDir}/opencode-ports.json`);
      for (const check of v1Checks('uat.yaml')) expect(runCheck(check, port), check).toBe(0);

      const before = FILES.map((name) => sha(real(name)));
      vi.stubEnv('HOME', home);
      for (const assignment of env.filter((word) => NAMES.some((name) => word.startsWith(`${name}=`)))) {
        const at = assignment.indexOf('=');
        vi.stubEnv(assignment.slice(0, at), assignment.slice(at + 1));
      }
      writeV1Records();
      expect(FILES.map((name) => sha(real(name)))).toEqual(before);
      for (const name of FILES) expect(fs.readFileSync(path.join(runDir, name), 'utf8')).toContain('wt-4149');

      const down = script('down', '--run-dir', runDir);
      expect(down.status, down.stderr).toBe(0);
      expect(stateOf().opencode_v1_real_changed).toBe('no');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it('control: with neither variable the same writers do change the real files', () => {
    const before = FILES.map((name) => sha(real(name)));
    vi.stubEnv('HOME', home);
    for (const name of NAMES) vi.stubEnv(name, '');

    writeV1Records();

    const after = FILES.map((name) => sha(real(name)));
    FILES.forEach((_, i) => expect(after[i]).not.toBe(before[i]));
  });

  it(
    'down reports a real file that changed, and does not fail on it: the production server writes it too',
    async () => {
      const port = await freePort();
      expect(script('up', '--port', String(port), '--run-dir', runDir, '--wait-listen', '30').status).toBe(0);

      fs.writeFileSync(real('opencode-ports.json'), '{"changed":true}\n');

      const down = script('down', '--run-dir', runDir);
      expect(down.status, down.stderr).toBe(0);
      expect(down.stderr).toContain(real('opencode-ports.json'));
      expect(stateOf().opencode_v1_real_changed).toBe('yes');
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it(
    'positive control: a server with neither variable fails the positive check, and passes the negative one only because it has none',
    async () => {
      fs.mkdirSync(runDir);
      const port = await startOther({});
      const results = v1Checks('uat.yaml').map((check) => ({ negative: check.includes('! ps eww'), status: runCheck(check, port) }));
      expect(results.find((r) => !r.negative)?.status).not.toBe(0);
      expect(results.find((r) => r.negative)?.status).toBe(0);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );

  it.each(NAMES)(
    'positive control: a server with %s at the real file fails both checks',
    async (name) => {
      fs.mkdirSync(runDir);
      const others = Object.fromEntries(
        NAMES.map((n, i) => [n, n === name ? real(FILES[i]) : `${runDir}/${FILES[i]}`])
      );
      const port = await startOther(others);
      for (const check of v1Checks('uat.yaml')) expect(runCheck(check, port), check).not.toBe(0);
    },
    REAL_SHELL_TEST_TIMEOUT_MS
  );
});
