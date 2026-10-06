/**
 * Issue #3312 — `run-server.sh up --own-home` and the `own_home` set in
 * `.commandmate/uat.yaml`.
 *
 * `down` runs for real here against a hand-written state with no server pid
 * and no socket directory, so nothing is started (no node, no tmux): it only
 * compares the shared-file record. Under `--own-home` a changed shared file is
 * recorded and is not a failure; without it (the user's UAT) it still fails.
 * Positive control: before this Issue `down` failed in both cases.
 *
 * `up` starts tmux and a server, so its own-home half is held by shape: the
 * server line keeps `CM_UAT_ISOLATION=1` and appends the own-home pair after
 * it (env sets the later value), only when `--own-home` was given.
 *
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const RUN_SERVER = path.join(REPO_ROOT, 'scripts/uat/run-server.sh');
const runServer = fs.readFileSync(RUN_SERVER, 'utf8');

let root: string;
let runDir: string;
let home: string;
let gemini: string;

function env(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    CM_RUN_LOCK_DIR: path.join(root, 'lock'),
    CM_UAT_SOCK_BASE: root,
  } as unknown as NodeJS.ProcessEnv;
}

/** `up`'s record, then a state as `up` leaves it, with no pid and no socket directory. */
function prepareRun(isolation: string | null): void {
  const record = spawnSync(
    'bash',
    ['-c', `. '${RUN_SERVER}'\ndecide_codex_home || exit 1\nwrite_shared_record '${runDir}/codex-shared.sha256'`],
    { env: env(), encoding: 'utf8' }
  );
  expect(record.status, record.stderr).toBe(0);
  const lines = [
    'run_id=261006000000-abcd',
    'port=3019',
    `run_dir=${runDir}`,
    `sock_dir=${path.join(root, 'cmuat-3019-261006000000-abcd')}`,
    ...(isolation === null ? [] : [`isolation=${isolation}`]),
    'status=up',
  ];
  fs.writeFileSync(path.join(runDir, 'uat-run.state'), `${lines.join('\n')}\n`);
}

function down() {
  return spawnSync('bash', [RUN_SERVER, 'down', '--run-dir', runDir], {
    cwd: REPO_ROOT,
    env: env(),
    encoding: 'utf8',
  });
}

function state(): string {
  return fs.readFileSync(path.join(runDir, 'uat-run.state'), 'utf8');
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uat-3312-run-')));
  runDir = path.join(root, 'run');
  home = path.join(root, 'home');
  fs.mkdirSync(runDir);
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  gemini = path.join(home, '.gemini', 'config', 'hooks.json');
  fs.writeFileSync(gemini, '{"commandmate":{}}\n');
});

afterEach(() => {
  removeTempDir(root);
});

describe('run-server.sh down and the shared-file record (Issue #3312)', () => {
  it('--own-home: a changed shared file is recorded, not a failure', () => {
    prepareRun('own-home');
    fs.writeFileSync(gemini, '{"commandmate":{"rewritten":true}}\n');
    fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), '{}\n');

    const res = down();
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain(`shared agent hook file changed during the run: ${gemini}`);
    expect(res.stderr).toContain(`codex shared file changed during the run: ${path.join(home, '.codex')}/hooks.json`);
    expect(res.stderr).toContain('recorded, not a failure');
    expect(state()).toMatch(/^shared_changed=yes$/m);
  });

  it('--own-home: an unchanged run records shared_changed=no', () => {
    prepareRun('own-home');
    const res = down();
    expect(res.status, res.stderr).toBe(0);
    expect(state()).toMatch(/^shared_changed=no$/m);
  });

  it('negative control — the user\'s UAT (isolation=1, or a state from before this Issue) still fails', () => {
    for (const isolation of ['1', null]) {
      prepareRun(isolation);
      fs.writeFileSync(gemini, `{"commandmate":{"rewritten":${JSON.stringify(String(isolation))}}}\n`);
      const res = down();
      expect(res.status, `${isolation}: ${res.stderr}`).toBe(1);
      expect(res.stderr).toContain(`shared agent hook file changed during the run: ${gemini}`);
      expect(state()).not.toContain('shared_changed=');
      fs.writeFileSync(gemini, '{"commandmate":{}}\n');
    }
  });
});

describe('run-server.sh up --own-home (Issue #3312), by shape', () => {
  function shellFunction(name: string): string {
    const match = runServer.match(new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}$`, 'm'));
    expect(match, `run-server.sh must define ${name}()`).toBeTruthy();
    return match![1];
  }
  const up = shellFunction('cmd_up');
  const serverLine = up
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('$SERVER_ENTRY'));

  it('accepts --own-home', () => {
    expect(shellFunction('parse_args')).toMatch(/--own-home\)\n\s*OWN_HOME=1/);
  });

  it('appends CM_UAT_ISOLATION=own-home and the dedicated user after CM_UAT_ISOLATION=1, only with --own-home', () => {
    expect(serverLine).toHaveLength(1);
    const [line] = serverLine;
    const one = line.indexOf('CM_UAT_ISOLATION=1');
    const own = line.indexOf('${own_home_env[@]+"${own_home_env[@]}"}');
    expect(one).toBeGreaterThan(line.indexOf('env -i'));
    expect(own).toBeGreaterThan(one);
    expect(own).toBeLessThan(line.indexOf('nohup'));
    expect(up).toMatch(
      /if \[ "\$OWN_HOME" -eq 1 \]; then\n\s*isolation=own-home\n\s*own_home_env=\(CM_UAT_ISOLATION=own-home "CM_UAT_DEDICATED_USER=\$\(id -un\)"\)/
    );
    expect(up).toContain('state_set "$UP_STATE" isolation "$isolation"');
  });

  it('env really takes the later of two assignments, under bash 3.2-safe empty-array expansion', () => {
    const script = [
      'set -u',
      'a=()',
      'env -i X=1 ${a[@]+"${a[@]}"} /usr/bin/env',
      'a=(X=own-home "Y=$(id -un)")',
      'env -i X=1 ${a[@]+"${a[@]}"} /usr/bin/env',
    ].join('\n');
    const res = spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.split('\n').filter(Boolean)).toEqual(['X=1', 'X=own-home', `Y=${os.userInfo().username}`]);
  });
});

describe('.commandmate/uat.yaml own_home set (Issue #3312)', () => {
  const spec = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, '.commandmate/uat.yaml'), 'utf8')) as {
    env: { up: string };
    isolation: { checks: string[] };
    own_home: { up: string; down: string; checks: string[] };
  };

  it('starts with --own-home and leaves the user\'s UAT set as it was', () => {
    expect(spec.own_home.up).toBe('bash scripts/uat/run-server.sh up --own-home --port {port} --run-dir {run_dir}');
    expect(spec.own_home.down).toBe('bash scripts/uat/run-server.sh down --run-dir {run_dir}');
    expect(spec.env.up).not.toContain('--own-home');
    expect(spec.isolation.checks.some((c) => c.includes("grep -qxF 'CM_UAT_ISOLATION=1'"))).toBe(true);
    expect(spec.isolation.checks.join('\n')).not.toContain('own-home');
  });

  it('checks the value, the user and the socket location on the running process', () => {
    const checks = spec.own_home.checks.join('\n');
    expect(checks).toContain("grep -qxF 'CM_UAT_ISOLATION=own-home'");
    expect(checks).toContain("! ps eww -p $P | tr ' ' '\\n' | grep -qxF 'CM_UAT_ISOLATION=1'");
    expect(checks).toContain('grep -qxF "CM_UAT_DEDICATED_USER=$U"');
    expect(checks).toContain('ps -o user= -p $P');
    expect(checks).toContain('case "$S" in "$HOME"/*/cmuat-{port}-?*)');
    expect(checks).toContain("grep -qxF 'n{run_dir}/uat.db'");
  });

  it('its socket check accepts a socket under the dedicated HOME and refuses /tmp', () => {
    const check = spec.own_home.checks.find((c) => c.includes('case "$S" in'))!;
    const caseOnly = check.slice(check.indexOf('S=$('), check.indexOf('esac;') + 'esac;'.length);
    const run = (sockDir: string) => {
      fs.writeFileSync(path.join(runDir, 'uat-run.state'), `sock_dir=${sockDir}\n`);
      const script = caseOnly.replace(/\{run_dir\}/g, runDir).replace(/\{port\}/g, '3019');
      return spawnSync('bash', ['-c', script], { env: env(), encoding: 'utf8' }).status;
    };
    expect(run(path.join(home, 'run', 'cmuat-3019-261006000000-abcd'))).toBe(0);
    expect(run('/tmp/cmuat-3019-261006000000-abcd')).toBe(1);
  });
});
