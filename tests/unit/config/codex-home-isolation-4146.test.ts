/**
 * Issue #4146: the suite's `CODEX_HOME` and `COPILOT_HOME` are always temporary
 * paths. Started with a real directory in either variable, `tests/setup.ts` used
 * to keep it, and a test that starts a session would edit that directory.
 *
 * Sets no environment of its own for the first group: what it reads is the
 * process `tests/setup.ts` handed it. The second reads the statements out of
 * `tests/setup.ts` and runs them against a fake environment, so the outer value
 * can be chosen without starting another suite. Read-only: nothing is written to
 * any home, real or temporary.
 *
 * @vitest-environment node
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '@/cli/utils/api-client';
import { ApiError } from '@/cli/utils/api-client-errors';
import { resolveServerEndpoint } from '@/cli/utils/server-url';
import { ExitCode } from '@/cli/types';
import { getServerPort } from '@/lib/env';
import {
  DEFAULT_SERVER_PORT,
  TEST_HOOK_HOST,
  fenceFetch,
  fencedPortsFor,
  fencedTarget,
  installRealServerFence,
  isFencedFetch,
  readEnvFiles,
} from '@tests/helpers/real-server-fence';
import { getCodexHome, getCodexHooksPath } from '@/lib/hooks/sources/codex/hooks-config';
import { resolveCodexHome } from '@/lib/hooks/sources/codex/history';

const SETUP_SOURCE = readFileSync(resolve(process.cwd(), 'tests/setup.ts'), 'utf8');

/** A real directory as the shell would have exported it. Never read or written. */
const OUTER_VALUE = join(homedir(), '.outer-home-4146');

/** The statements of `source` that write `process.env.<name>`, comments left out. */
function statementsWriting(source: string, name: string): string {
  const code = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  const at = code.indexOf(`process.env.${name} `);
  const start = code.lastIndexOf('\n', at) + 1;
  const guarded = code.startsWith('if (', start);
  const end = code.indexOf(guarded ? '\n}\n' : ';\n', at);
  return code.slice(start, end + (guarded ? 3 : 2));
}

/** What the statements leave in the variable, started from `outer`. */
function valueAfterSetup(statements: string, name: string, outer: string | undefined): string | undefined {
  const fakeProcess = { env: { [name]: outer }, pid: 1 };
  new Function('process', 'join', 'tmpdir', statements)(fakeProcess, join, tmpdir);
  return fakeProcess.env[name];
}

describe('the process tests/setup.ts handed this file', () => {
  it('CODEX_HOME is the temporary path', () => {
    expect(process.env.CODEX_HOME).toBe(join(tmpdir(), 'commandmate-test-codex-home'));
  });

  it('COPILOT_HOME is under the temporary directory', () => {
    expect(process.env.COPILOT_HOME?.startsWith(join(tmpdir(), 'commandmate-test-copilot-home'))).toBe(true);
  });

  it('codex resolves its home and hooks file away from the real ~/.codex', () => {
    const real = join(homedir(), '.codex');
    expect(getCodexHome()).not.toBe(real);
    expect(getCodexHooksPath()).not.toBe(join(real, 'hooks.json'));
    expect(resolveCodexHome()).not.toBe(real);
  });

  it('and the variable is what stands between the suite and the real ~/.codex', () => {
    expect(resolveCodexHome({})).toBe(join(homedir(), '.codex'));
  });
});

describe('a value the suite was started with', () => {
  it.each(['CODEX_HOME', 'COPILOT_HOME'])('%s does not survive tests/setup.ts', (name) => {
    const statements = statementsWriting(SETUP_SOURCE, name);
    const after = valueAfterSetup(statements, name, OUTER_VALUE);
    expect(after).not.toBe(OUTER_VALUE);
    expect(after?.startsWith(tmpdir())).toBe(true);
  });

  it.each(['CODEX_HOME', 'COPILOT_HOME'])('%s is filled in when nothing was set, or a blank', (name) => {
    const statements = statementsWriting(SETUP_SOURCE, name);
    expect(valueAfterSetup(statements, name, undefined)?.startsWith(tmpdir())).toBe(true);
    expect(valueAfterSetup(statements, name, '')?.startsWith(tmpdir())).toBe(true);
  });

  it('positive control: the shapes this replaced keep the outer value, so the reading can tell', () => {
    const oldCodex = "process.env.CODEX_HOME ??= join(tmpdir(), 'commandmate-test-codex-home');";
    expect(valueAfterSetup(statementsWriting(`${oldCodex}\n`, 'CODEX_HOME'), 'CODEX_HOME', OUTER_VALUE)).toBe(OUTER_VALUE);

    const oldCopilot = [
      "if ((process.env.COPILOT_HOME ?? '').trim() === '') {",
      "  process.env.COPILOT_HOME = join(tmpdir(), 'x');",
      '}',
      '',
    ].join('\n');
    expect(valueAfterSetup(statementsWriting(oldCopilot, 'COPILOT_HOME'), 'COPILOT_HOME', OUTER_VALUE)).toBe(OUTER_VALUE);
  });
});

/*
 * Issue #4163, item 2: every `CM_*` that names a real place. Moved here from
 * tests/unit/guards/worktree-route-session-ownership-3290.test.ts by #4176, which
 * added CM_TMUX_SCRIPT_DIR, CM_HOST and the removed server settings. No file is
 * written.
 */
describe('[#4163] tests/setup.ts keeps no CM_* path from outside', () => {
  const SETUP = SETUP_SOURCE;
  const PINNED = [
    'CM_VERIFY_WORKTREE_INDEX_ROOT',
    'CM_SESSION_KILL_LEDGER_ROOT',
    'CM_OPENCODE_PORT_FILE',
    'CM_OPENCODE_V2_DIR',
    'CM_AUTO_YES_SHUTDOWN_RECORD_PATH',
    'CM_AGENT_ROLE_ARTIFACTS_DIR',
    'CM_AGENT_ROLE_ANTIGRAVITY_AGENTS_DIR',
    'CM_OPENCODE_SESSION_FILE',
    'CM_OPENCODE_LAUNCH_SETTINGS_FILE',
    'CM_AGENT_HOOKS_DIR',
    'CM_VERIFY_LOCK_ROOT',
    'CM_LOG_DIR',
    'CM_RUN_LOCK_DIR',
    'CM_UAT_SOCK_BASE',
    'CM_PRODUCT_PUBLISH_DIR',
    // Issue #4176
    'CM_TMUX_SCRIPT_DIR',
  ];
  const REMOVED = [
    'CM_ROOT_DIR',
    'MCBD_ROOT_DIR',
    'CM_BROWSE_ROOTS',
    'CM_HOOK_URL',
    'CM_PERMISSION_HOOK_URL',
    'CM_HOOK_PORT',
    'CM_REMOTE_PAIRING_FILE',
    'CM_OPENCODE_LOCAL_PROVIDER_CONFIG',
    'CM_AGENT_ROLE_ANTIGRAVITY_ENABLED',
    // Issue #4176
    'CM_PORT',
    'MCBD_PORT',
    'CM_AUTH_TOKEN',
    'CM_HTTPS_CERT',
    'CM_HTTPS_KEY',
  ];
  const OUTER = '/outer/real/place-4163';

  /** The statements of `source` over `process.env`, run from an environment where every name is `outer`. */
  function afterSetup(source: string, outer: string | undefined): Record<string, string | undefined> {
    const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    const statements = code.match(
      /^(?:if \(\(process\.env\.[\s\S]*?^\}$|process\.env\.CM_\w+ = [\s\S]*?;$|delete process\.env\.\w+;$)/gm
    ) ?? [];
    const env: Record<string, string | undefined> = {};
    for (const name of [...PINNED, ...REMOVED, 'CM_HOST']) env[name] = outer;
    new Function('process', 'join', 'tmpdir', 'TEST_HOOK_HOST', statements.join('\n'))(
      { env, pid: 1 },
      join,
      tmpdir,
      TEST_HOOK_HOST
    );
    return env;
  }

  it.each(PINNED)('%s ends under the temp directory, whatever it started as', (name) => {
    for (const outer of [OUTER, '', undefined]) {
      expect(afterSetup(SETUP, outer)[name]?.startsWith(tmpdir()), String(outer)).toBe(true);
    }
  });

  it.each(REMOVED)('%s does not survive', (name) => {
    expect(afterSetup(SETUP, OUTER)[name]).toBeUndefined();
  });

  it('this process, which tests/setup.ts handed to this file, is the same', () => {
    for (const name of PINNED) expect(process.env[name]?.startsWith(tmpdir()), name).toBe(true);
    for (const name of REMOVED) expect(process.env[name], name).toBeUndefined();
  });

  it('positive control: the guard the pins replaced keeps the outer value, so the reading can tell', () => {
    const old = "if ((process.env.CM_LOG_DIR ?? '').trim() === '') {\n  process.env.CM_LOG_DIR = join(tmpdir(), 'x');\n}\n";
    expect(afterSetup(old, OUTER).CM_LOG_DIR).toBe(OUTER);
    expect(afterSetup(old, '').CM_LOG_DIR?.startsWith(tmpdir())).toBe(true);
  });

  it('positive control: a name nobody pinned keeps the outer value', () => {
    expect(afterSetup('', OUTER).CM_LOG_DIR).toBe(OUTER);
  });

  it('[#4176] CM_HOST ends as the host that never resolves, whatever it started as', () => {
    for (const outer of ['127.0.0.1', '', undefined]) {
      expect(afterSetup(SETUP, outer).CM_HOST, String(outer)).toBe(TEST_HOOK_HOST);
    }
    expect(process.env.CM_HOST).toBe(TEST_HOOK_HOST);
    expect(TEST_HOOK_HOST.endsWith('.invalid')).toBe(true);
  });
});

/*
 * Issue #4176, item 1. A worker's pane inherits the running server's
 * `CM_PORT=3000`, and the defaults all answer 3000 too, so what keeps the suite
 * off that server is the fence in front of `fetch`, not a value. The requests
 * that matter here go to a server this file starts on an ephemeral port.
 */
describe('[#4176] the suite does not reach the server running on this machine', () => {
  let server: Server | undefined;
  let hits: string[] = [];

  afterEach(async () => {
    const open = server;
    server = undefined;
    hits = [];
    if (open) await new Promise<void>((done) => open.close(() => done()));
  });

  /** A server on an ephemeral loopback port that records each request it gets. */
  async function listen(): Promise<number> {
    const created = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('{}');
    });
    server = created;
    await new Promise<void>((done) => created.listen(0, '127.0.0.1', () => done()));
    return (created.address() as AddressInfo).port;
  }

  it('the defaults still answer 3000, as on CI', () => {
    expect(process.env.CM_PORT).toBeUndefined();
    expect(getServerPort()).toBe(DEFAULT_SERVER_PORT);
    expect(resolveServerEndpoint(process.env).url).toBe(`http://127.0.0.1:${DEFAULT_SERVER_PORT}`);
  });

  it('fetch is fenced, and the port the CLI dials by default is a fenced one', () => {
    expect(isFencedFetch(globalThis.fetch)).toBe(true);
    const ports = installRealServerFence(process.env);
    expect(ports).toContain(DEFAULT_SERVER_PORT);
    expect(ports).toContain(Number(new URL(new ApiClient().serverUrl).port));
  });

  it('a request through the CLI to the default target is refused as a closed port, unsent', async () => {
    // Checked first so that a broken fence fails here instead of sending the
    // request to the server this machine is running.
    expect(isFencedFetch(globalThis.fetch)).toBe(true);
    const error = await new ApiClient({ baseUrl: `http://127.0.0.1:${DEFAULT_SERVER_PORT}` })
      .get('/api/worktrees')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).exitCode).toBe(ExitCode.DEPENDENCY_ERROR);
  });

  it('a fenced port receives nothing, and every other port is untouched', async () => {
    const port = await listen();
    const fenced = fenceFetch(globalThis.fetch, [port]);

    const refused = await fenced(`http://127.0.0.1:${port}/fenced`).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TypeError);
    expect(((refused as TypeError).cause as { code?: string }).code).toBe('ECONNREFUSED');
    await fenced(`http://localhost:${port}/fenced-by-name`).catch(() => undefined);
    expect(hits).toEqual([]);

    // Positive control: the same server answers a port nobody fenced, and the
    // same request without the fence, so "nothing arrived" is the fence.
    expect((await fenceFetch(globalThis.fetch, [port + 1])(`http://127.0.0.1:${port}/other`)).ok).toBe(true);
    expect((await globalThis.fetch(`http://127.0.0.1:${port}/unfenced`)).ok).toBe(true);
    expect(hits).toEqual(['/other', '/unfenced']);
  });

  it('judges loopback hosts only, and relative URLs not at all', () => {
    expect(fencedTarget('http://localhost:3000/x', [3000])?.port).toBe(3000);
    expect(fencedTarget('http://[::1]:3000/x', [3000])?.port).toBe(3000);
    expect(fencedTarget(new URL('https://127.0.0.2:3000/'), [3000])?.port).toBe(3000);
    expect(fencedTarget('http://example.test:3000/x', [3000])).toBeUndefined();
    expect(fencedTarget('/api/worktrees', [3000])).toBeUndefined();
    expect(fencedTarget('http://127.0.0.1:3001/x', [3000])).toBeUndefined();
  });

  it('fences the ports the suite was started with and the ones a client .env names', () => {
    expect(fencedPortsFor({ CM_PORT: '3011' }, { MCBD_PORT: '3012' }, { CM_PORT: 'nonsense' })).toEqual([
      3000, 3011, 3012,
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'cm-4176-env-'));
    try {
      writeFileSync(join(dir, '.env'), 'CM_PORT=3013\n');
      expect(readEnvFiles([join(dir, '.env'), join(dir, 'missing.env')])).toEqual([{ CM_PORT: '3013' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('positive control: removing CM_PORT alone leaves the CLI on 3000, which is why the fence exists', () => {
    expect(resolveServerEndpoint({ CM_PORT: '3000' }).url).toBe(resolveServerEndpoint({}).url);
  });
});
