/**
 * `scripts/opencode-v2/launch.sh` — one pane, two processes, one lifetime
 * (Issue #2934, decision D2).
 *
 * `opencode2` is replaced by a fake on PATH. The fake's `serve` role is a small
 * node HTTP server that listens on the port it was given, answers
 * `GET /openapi.json` 200 only for `Basic opencode:$OPENCODE_SERVER_PASSWORD`,
 * and writes down what it was started with; its TUI role writes the same and
 * then either exits at once or waits for a signal. What is asserted is the
 * wrapper's contract:
 *
 *  - the TUI exiting stops the server and frees the port;
 *  - SIGHUP to the wrapper (what `tmux kill-session` delivers) stops both;
 *  - a server that never answers makes the wrapper exit non-zero, leaving no
 *    server behind;
 *  - the password reaches the processes' environment and nothing else — not
 *    their arguments, not the wrapper's stdout or stderr.
 *
 * Run under `/bin/bash` on purpose: on macOS that is bash 3.2, the version the
 * wrapper promises to work on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

const SCRIPT = resolve(__dirname, '../../../../scripts/opencode-v2/launch.sh');
const PASSWORD = 'pw-2934-Zq8xVb3NfT0sLr9KmW2yHcE5uJdA7gPo-_';

let sandbox: string;
let children: ChildProcess[] = [];

interface Record2934 {
  role: 'serve' | 'tui';
  pid: number;
  argv: string[];
  passwordEnv: string | null;
  /** The fake's own `$0`: which executable the wrapper actually ran (Issue #2952). */
  self: string;
  /** COREPACK_ENABLE_AUTO_PIN / OPENCODE_DISABLE_AUTOUPDATE as received (Issue #2957). */
  autoPinEnv: string | null;
  disableAutoupdateEnv: string | null;
}

const FAKE_SERVE_JS = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1]);
const host = argv[argv.indexOf('--hostname') + 1];
const record = { role: 'serve', pid: process.pid, argv, passwordEnv: process.env.OPENCODE_SERVER_PASSWORD ?? null, self: process.env.FAKE_SELF, autoPinEnv: process.env.COREPACK_ENABLE_AUTO_PIN ?? null, disableAutoupdateEnv: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? null };
fs.writeFileSync(path.join(process.env.FAKE_RECORD_DIR, 'serve.json'), JSON.stringify(record));
process.on('SIGTERM', () => process.exit(0));
if (process.env.FAKE_SERVE_MODE === 'silent') {
  setInterval(() => {}, 1000);
} else {
  const expected = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
  http.createServer((req, res) => {
    const ok = req.url === '/openapi.json' && req.headers.authorization === expected;
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end('{}');
  }).listen(port, host);
}
`;

const FAKE_OPENCODE2 = `#!/bin/bash
export FAKE_SELF="$0"
if [ "\${1:-}" = "serve" ]; then
  shift
  exec node "$FAKE_RECORD_DIR/fake-serve.js" "$@"
fi
node -e '
  const fs = require("node:fs");
  const record = { role: "tui", pid: Number(process.argv[1]), argv: process.argv.slice(2), passwordEnv: process.env.OPENCODE_SERVER_PASSWORD ?? null, self: process.env.FAKE_SELF, autoPinEnv: process.env.COREPACK_ENABLE_AUTO_PIN ?? null, disableAutoupdateEnv: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? null };
  fs.writeFileSync(process.env.FAKE_RECORD_DIR + "/tui.json", JSON.stringify(record));
' "$$" "$@"
if [ "\${FAKE_TUI_MODE:-exit}" = "wait" ]; then
  trap 'exit 0' TERM HUP INT
  while :; do sleep 0.1; done
fi
sleep 0.3
exit 0
`;

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolveAnswer) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolveAnswer(true);
    });
    socket.once('error', () => resolveAnswer(false));
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

function readRecord(role: 'serve' | 'tui'): Record2934 {
  return JSON.parse(readFileSync(join(sandbox, `${role}.json`), 'utf8')) as Record2934;
}

interface Run {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => { stdout: string; stderr: string };
}

function runWrapper(args: string[], env: Record<string, string> = {}): Run {
  const child = spawn('/bin/bash', [SCRIPT, ...args], {
    cwd: sandbox,
    env: {
      ...process.env,
      PATH: `${join(sandbox, 'bin')}:${process.env.PATH ?? ''}`,
      FAKE_RECORD_DIR: sandbox,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.once('exit', (code, signal) => done({ code, signal }))
  );
  return { child, exited, output: () => ({ stdout, stderr }) };
}

beforeEach(() => {
  sandbox = makeTempDir('cm-2934-launch-');
  const bin = join(sandbox, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'opencode2'), FAKE_OPENCODE2);
  chmodSync(join(bin, 'opencode2'), 0o755);
  writeFileSync(join(sandbox, 'fake-serve.js'), FAKE_SERVE_JS);
  writeFileSync(join(sandbox, 'pw'), `${PASSWORD}\n`, { mode: 0o600 });
  mkdirSync(join(sandbox, 'repo'));
  children = [];
});

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.pid !== undefined) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  for (const role of ['serve', 'tui'] as const) {
    const file = join(sandbox, `${role}.json`);
    if (!existsSync(file)) continue;
    const { pid } = JSON.parse(readFileSync(file, 'utf8')) as Record2934;
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
  removeTempDir(sandbox);
});

function standardArgs(port: number): string[] {
  return [
    '--port',
    String(port),
    '--password-file',
    join(sandbox, 'pw'),
    '--directory',
    join(sandbox, 'repo'),
  ];
}

describe('scripts/opencode-v2/launch.sh (Issue #2934 D2)', () => {
  it('stops the server and frees the port when the TUI exits', async () => {
    const port = await freePort();
    const run = runWrapper(standardArgs(port), { FAKE_TUI_MODE: 'exit' });

    const { code } = await run.exited;
    expect(code).toBe(0);

    const serve = readRecord('serve');
    const tui = readRecord('tui');
    expect(serve.argv).toEqual(['--hostname', '127.0.0.1', '--port', String(port)]);
    expect(tui.argv).toEqual(['--server', `http://127.0.0.1:${port}`, join(sandbox, 'repo')]);
    // The wrapper reaps the server before its own exit is observable.
    expect(isAlive(serve.pid)).toBe(false);
    expect(await portAnswers(port)).toBe(false);
  });

  it('stops both processes when the wrapper gets SIGHUP (tmux kill-session)', async () => {
    const port = await freePort();
    const run = runWrapper(standardArgs(port), { FAKE_TUI_MODE: 'wait' });

    await waitFor(() => existsSync(join(sandbox, 'tui.json')));
    const serve = readRecord('serve');
    const tui = readRecord('tui');
    expect(isAlive(serve.pid)).toBe(true);
    expect(isAlive(tui.pid)).toBe(true);
    expect(await portAnswers(port)).toBe(true);

    run.child.kill('SIGHUP');
    const { code } = await run.exited;

    expect(code).toBe(129);
    await waitFor(() => !isAlive(serve.pid) && !isAlive(tui.pid), 10_000);
    expect(await portAnswers(port)).toBe(false);
  });

  it('exits non-zero and leaves no server behind when the server never answers', async () => {
    const port = await freePort();
    const run = runWrapper(standardArgs(port), {
      FAKE_SERVE_MODE: 'silent',
      CM_OPENCODE_V2_READY_TIMEOUT: '2',
    });

    const { code } = await run.exited;
    expect(code).toBe(69);
    expect(run.output().stderr).toContain('did not answer');

    const serve = readRecord('serve');
    expect(isAlive(serve.pid)).toBe(false);
    // The TUI was never started.
    expect(existsSync(join(sandbox, 'tui.json'))).toBe(false);
  });

  it('waits 15 seconds for the server by default', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toMatch(
      /^READY_TIMEOUT_SECONDS="\$\{CM_OPENCODE_V2_READY_TIMEOUT:-15\}"$/m
    );
  });

  it('puts the password in the environment only — never in argv, stdout or stderr', async () => {
    const port = await freePort();
    const run = runWrapper(standardArgs(port), { FAKE_TUI_MODE: 'exit' });
    const { code } = await run.exited;
    expect(code).toBe(0);

    const serve = readRecord('serve');
    const tui = readRecord('tui');
    // Read from the file, handed over as OPENCODE_SERVER_PASSWORD (the fake
    // server only answered 200 because the TUI would have had the same value).
    expect(serve.passwordEnv).toBe(PASSWORD);
    expect(tui.passwordEnv).toBe(PASSWORD);
    expect(serve.argv.join(' ')).not.toContain(PASSWORD);
    expect(tui.argv.join(' ')).not.toContain(PASSWORD);
    const { stdout, stderr } = run.output();
    expect(stdout).not.toContain(PASSWORD);
    expect(stderr).not.toContain(PASSWORD);
    // And the wrapper's own command line names only the file.
    expect(standardArgs(port).join(' ')).not.toContain(PASSWORD);
  });

  it('keeps the project package.json untouched: no corepack auto-pin, no self-update check (Issue #2957)', async () => {
    const port = await freePort();
    // Whatever the caller had set, the wrapper's values win.
    const run = runWrapper(standardArgs(port), {
      FAKE_TUI_MODE: 'exit',
      COREPACK_ENABLE_AUTO_PIN: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '0',
    });
    const { code } = await run.exited;
    expect(code).toBe(0);

    for (const role of ['serve', 'tui'] as const) {
      const record = readRecord(role);
      expect(record.autoPinEnv).toBe('0');
      expect(record.disableAutoupdateEnv).toBe('1');
    }
  });

  it('refuses to start without its three arguments', async () => {
    const run = runWrapper(['--port', '4300']);
    const { code } = await run.exited;
    expect(code).toBe(64);
    expect(existsSync(join(sandbox, 'serve.json'))).toBe(false);
  });

  it('refuses an empty password file rather than start an unauthenticated-looking server', async () => {
    writeFileSync(join(sandbox, 'pw'), '');
    const run = runWrapper(standardArgs(await freePort()));
    const { code } = await run.exited;
    expect(code).toBe(66);
    expect(existsSync(join(sandbox, 'serve.json'))).toBe(false);
  });
});

describe('scripts/opencode-v2/launch.sh --executable (Issue #2952)', () => {
  it('runs both the server and the TUI with the given executable, even one named `opencode` off PATH', async () => {
    // OpenCode V2 installed under the `opencode` name only, somewhere PATH does
    // not reach; the `opencode2` on PATH must not be the one that runs.
    const elsewhere = join(sandbox, 'elsewhere');
    mkdirSync(elsewhere);
    const executable = join(elsewhere, 'opencode');
    writeFileSync(executable, FAKE_OPENCODE2);
    chmodSync(executable, 0o755);

    const port = await freePort();
    const run = runWrapper([...standardArgs(port), '--executable', executable], {
      FAKE_TUI_MODE: 'exit',
    });
    const { code } = await run.exited;
    expect(code).toBe(0);

    const serve = readRecord('serve');
    const tui = readRecord('tui');
    expect(serve.self).toBe(executable);
    expect(tui.self).toBe(executable);
    expect(serve.argv).toEqual(['--hostname', '127.0.0.1', '--port', String(port)]);
    expect(tui.argv).toEqual(['--server', `http://127.0.0.1:${port}`, join(sandbox, 'repo')]);
    expect(isAlive(serve.pid)).toBe(false);
    expect(await portAnswers(port)).toBe(false);
  });

  it('runs `opencode2` from PATH when --executable is omitted', async () => {
    const port = await freePort();
    const run = runWrapper(standardArgs(port), { FAKE_TUI_MODE: 'exit' });
    const { code } = await run.exited;
    expect(code).toBe(0);

    const onPath = join(sandbox, 'bin', 'opencode2');
    expect(readRecord('serve').self).toBe(onPath);
    expect(readRecord('tui').self).toBe(onPath);
  });

  it('refuses an --executable that is not an executable file, before starting anything', async () => {
    const notExecutable = join(sandbox, 'opencode');
    writeFileSync(notExecutable, FAKE_OPENCODE2);
    for (const bad of [notExecutable, join(sandbox, 'missing'), join(sandbox, 'repo')]) {
      const run = runWrapper([...standardArgs(await freePort()), '--executable', bad]);
      const { code } = await run.exited;
      expect(code).toBe(64);
      expect(run.output().stderr).toContain('--executable');
    }
    expect(existsSync(join(sandbox, 'serve.json'))).toBe(false);
  });
});
