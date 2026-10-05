/**
 * Shape of `.commandmate/uat.yaml` — CommandMate's own environment declaration
 * for the official cmate-uat Skill (Issue #2590).
 *
 * The file is shell wrapped in YAML, and the one defect it has already had was
 * invisible to anything but a live run: the first `env.up` was a folded block
 * (`>-`) with deeper-indented continuation lines. YAML keeps the line break
 * before a more-indented line, so `env -i …` became a command of its own and
 * `node` started with the caller's whole environment. The DB still looked
 * isolated only because the caller happened to export CM_DB_PATH already; TMUX
 * came through and pointed the UAT server at the user's own tmux server. A live
 * isolation check caught it. These assertions hold that shape without a server:
 * after bash's own line continuation, the line that starts the server has to be
 * the one that clears the environment and sets the isolating variables.
 *
 * The lap itself (up -> health -> isolation.checks -> down) is run by hand when
 * the file changes; its record is in the PR that introduced the file.
 *
 * Issue #3359 moved the shell of `up` / `down` into scripts/uat/run-server.sh
 * (shared with the daily check). The yaml now only calls it, so the shape
 * assertions below read the script's `cmd_up` / `cmd_down`; what they hold is
 * unchanged. The script's behaviour is tests/unit/scripts/uat/run-server-3359.test.ts.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const UAT_YAML = path.join(REPO_ROOT, '.commandmate/uat.yaml');
const RUN_SERVER = path.join(REPO_ROOT, 'scripts/uat/run-server.sh');

interface UatYaml {
  version: number;
  env: {
    build?: string;
    up: string;
    down?: string;
    health: string;
    health_timeout_sec?: number;
    port_range: [number, number];
  };
  isolation: { checks: string[] };
  report_dir?: string;
}

const spec = YAML.parse(fs.readFileSync(UAT_YAML, 'utf8')) as UatYaml;
const runServer = fs.readFileSync(RUN_SERVER, 'utf8');

/** The body of a shell function in run-server.sh (up to its closing brace at column 0). */
function shellFunction(name: string): string {
  const match = runServer.match(new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}$`, 'm'));
  expect(match, `run-server.sh must define ${name}()`).toBeTruthy();
  return match![1];
}

/** What `up` runs: the script's cmd_up. */
const upScript = shellFunction('cmd_up');
/** What `down` runs: cmd_down and the verified stop it calls. */
const downScript = `${shellFunction('cmd_down')}\n${shellFunction('stop_recorded')}`;

/** Shell lines as bash sees them: a trailing backslash joins the next line. */
function logicalLines(script: string): string[] {
  return script
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

describe('.commandmate/uat.yaml (Issue #2590)', () => {
  it('declares contract v1 with the required keys', () => {
    expect(spec.version).toBe(1);
    expect(typeof spec.env.up).toBe('string');
    expect(typeof spec.env.health).toBe('string');
    expect(spec.env.port_range).toHaveLength(2);
    const [from, to] = spec.env.port_range;
    // Never the production port, and a real range.
    expect(from).toBeGreaterThan(3000);
    expect(to).toBeGreaterThanOrEqual(from);
  });

  it('declares isolation.checks as a non-empty list — the key is mandatory and [] would mean "none needed"', () => {
    expect(Array.isArray(spec.isolation?.checks)).toBe(true);
    expect(spec.isolation.checks.length).toBeGreaterThan(0);
  });

  it('starts the server on ONE logical line that clears the environment and sets every isolating variable', () => {
    expect(spec.env.up).toBe('bash scripts/uat/run-server.sh up --port {port} --run-dir {run_dir}');
    const serverLines = logicalLines(upScript).filter((line) => line.includes('$SERVER_ENTRY'));
    expect(serverLines, 'exactly one line starts the server').toHaveLength(1);
    expect(runServer).toContain('SERVER_ENTRY="${CM_UAT_SERVER_ENTRY:-dist/server/server.js}"');
    const [line] = serverLines;
    expect(line.startsWith('env -i '), `the server line must begin with env -i: ${line}`).toBe(true);
    for (const assignment of [
      'CM_PORT="$PORT"',
      'CM_BIND=127.0.0.1',
      'CM_DB_PATH="$RUN_DIR/',
      'CM_ROOT_DIR="$RUN_DIR/',
      // The production code calls tmux with no socket argument, so TMUX decides
      // which server it reaches. It has to name the private socket, never the
      // caller's value (env -i drops that, and this puts the private one back).
      // Issue #3359: the socket is per run, /tmp/cmuat-<port>-<run id>/tmux.sock.
      'TMUX="$sock,',
    ]) {
      expect(line, `the server line must set ${assignment}`).toContain(assignment);
    }
  });

  it('has no statement in env.up that only assigns variables (the symptom of a broken continuation)', () => {
    const bareAssignment = /^[A-Z_][A-Z0-9_]*=\S*(\s+[A-Z_][A-Z0-9_]*=\S*)*$/;
    for (const line of logicalLines(spec.env.up)) {
      expect(line, `a bare assignment line does not reach the server: ${line}`).not.toMatch(bareAssignment);
    }
    // In run-server.sh plain assignments are its own variables; an isolating
    // variable (or TMUX / NODE_ENV) on such a line is a broken continuation.
    for (const line of logicalLines(upScript)) {
      if (!bareAssignment.test(line)) continue;
      expect(line, `a bare assignment line does not reach the server: ${line}`).not.toMatch(/\b(CM_[A-Z_]+|TMUX|NODE_ENV)=/);
    }
  });

  it('never talks to a tmux server without naming its socket', () => {
    // With TMUX set in the caller, a bare `tmux kill-server` reaches the user's
    // own server. Every tmux command in up and down names the private socket.
    for (const script of [spec.env.up, spec.env.down ?? '', runServer]) {
      for (const line of logicalLines(script)) {
        for (const match of line.matchAll(/(?:^|[;&|(]\s*)tmux\s+(\S+)/g)) {
          expect(match[1], `tmux without -S: ${line}`).toBe('-S');
        }
      }
    }
  });

  it('stops only what LISTENS on the port (CommandMate#2473)', () => {
    expect(spec.env.down).toBe('bash scripts/uat/run-server.sh down --run-dir {run_dir}');
    // The port is looked up only through scripts/lib/port-pids.sh (LISTEN-only),
    // and only to compare with the recorded pid (Issue #3359).
    expect(downScript).toContain('find_listen_pids_by_port "$port"');
    expect(runServer).toContain('. "$REPO_ROOT/scripts/lib/port-pids.sh"');
    const lsofCalls = [...runServer.matchAll(/lsof\s[^\n;|)]*/g)].map((match) => match[0]);
    for (const call of lsofCalls) {
      expect(call, `lsof without the LISTEN filter: ${call}`).toContain('-sTCP:LISTEN');
    }
    expect(runServer).not.toMatch(/\b(pkill|killall)\b/);
  });

  it('writes its run output under .commandmate/uat, which .gitignore keeps out of the repository', () => {
    expect(spec.report_dir ?? '.commandmate/uat').toBe('.commandmate/uat');
  });

  it('moves the shared opencode-v2 and hook directories under the run, after env -i (Issue #3342)', () => {
    const [line] = logicalLines(upScript).filter((l) => l.includes('$SERVER_ENTRY'));
    expect(line.startsWith('env -i ')).toBe(true);
    const envEnd = line.indexOf('nohup');
    for (const assignment of ['CM_OPENCODE_V2_DIR="$RUN_DIR/opencode-v2"', 'CM_AGENT_HOOKS_DIR="$RUN_DIR/hooks"']) {
      const at = line.indexOf(assignment);
      expect(at, `the server line must set ${assignment}`).toBeGreaterThan(line.indexOf('env -i'));
      expect(at).toBeLessThan(envEnd);
    }
  });

  it('checks on the running process that both directories point under the run, positive and negative (Issue #3342)', () => {
    const checks = spec.isolation.checks.filter((c) => /OPENCODE_V2/.test(c));
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(checks.some((c) => c.includes('ps eww') && c.includes('{run_dir}/opencode-v2') && c.includes('{run_dir}/hooks') && !c.includes('! '))).toBe(true);
    expect(checks.some((c) => c.includes('! ps eww') && c.includes('grep -vF'))).toBe(true);
  });

  it('records codex shared-file hashes before the server starts and fails in down when they changed (Issue #3342)', () => {
    const up = upScript;
    const down = shellFunction('cmd_down');
    const check = shellFunction('check_shared_record');
    expect(runServer).toContain('CODEX_SHARED_FILES="hooks.json commandmate/cmate-agent-event.sh"');
    expect(runServer).toContain('SHARED_RECORD_NAME="codex-shared.sha256"');
    expect(up.indexOf('write_shared_record')).toBeGreaterThan(-1);
    expect(up.indexOf('write_shared_record')).toBeLessThan(up.indexOf('$SERVER_ENTRY'));
    expect(down).toContain('check_shared_record "$RUN_DIR/$SHARED_RECORD_NAME" || rc=1');
    expect(check).toMatch(/rc=1/);
    // Never writes back: the user's own changes must survive.
    expect(`${down}\n${check}`).not.toMatch(/\bcp\b|\bmv\b|>\s*"?\$(f|base)/);
  });

  it('uses ONE decided CODEX_HOME for the record, the server (after env -i) and down (Issue #3358)', () => {
    // Issue #3359: the decision lives in run-server.sh (decide_codex_home), up calls it.
    const decide = shellFunction('decide_codex_home');
    expect(decide).toContain('"${CODEX_HOME:-$HOME/.codex}"');
    expect(decide).toContain('CH="$(');
    expect(shellFunction('write_shared_record')).toMatch(/printf 'CODEX_HOME {2}%s\\n' "\$CH"/);
    const [line] = logicalLines(upScript).filter((l) => l.includes('$SERVER_ENTRY'));
    const at = line.indexOf('CODEX_HOME="$CH"');
    expect(at, 'the server line must set CODEX_HOME').toBeGreaterThan(line.indexOf('env -i'));
    expect(at).toBeLessThan(line.indexOf('nohup'));
    // The record names the home; down reads it back instead of re-deriving it.
    const check = shellFunction('check_shared_record');
    expect(check).toContain('CODEX_HOME) base="$rest"');
    expect(check).toContain('"$base/$rest"');
    expect(`${shellFunction('cmd_down')}\n${check}`).not.toContain('$HOME/.codex');
  });

  describe('CODEX_HOME is made absolute and refused like the server refuses it (Issue #3358)', () => {
    // run-server.sh sourced: only its functions are defined, nothing starts.
    // decide_codex_home then the record, as `up` does before the tmux server.
    function runPreamble(codexHome: string | undefined, cwd: string) {
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uat-3358-run-'));
      const env = { PATH: process.env.PATH ?? '', HOME: path.join(runDir, 'home') };
      if (codexHome !== undefined) Object.assign(env, { CODEX_HOME: codexHome });
      const script = [
        `. '${RUN_SERVER}'`,
        'decide_codex_home || exit 1',
        `mkdir -p '${runDir}/root'`,
        `write_shared_record '${runDir}/codex-shared.sha256' || exit 1`,
        `printf '%s' "$CH"`,
      ].join('\n');
      const res = spawnSync('bash', ['-c', script], {
        cwd,
        env: env as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
      });
      return { ...res, runDir };
    }

    it('starts the private tmux server with the decided CODEX_HOME, not the caller\'s', () => {
      const [line] = logicalLines(upScript).filter((l) => l.includes('new-session'));
      expect(line.startsWith('CODEX_HOME="$CH" tmux -S ')).toBe(true);
    });

    it('decides CODEX_HOME before up makes or starts anything', () => {
      const at = upScript.indexOf('decide_codex_home || exit 1');
      expect(at).toBeGreaterThan(-1);
      for (const later of ['mkdir -p "$RUN_DIR"', 'run_lock_acquire', 'new-session', '$SERVER_ENTRY']) {
        expect(at, later).toBeLessThan(upScript.indexOf(later));
      }
    });

    it('turns a relative CODEX_HOME into an absolute one and records it', () => {
      const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uat-3358-cwd-')));
      fs.mkdirSync(path.join(cwd, 'rel-codex'));
      const res = runPreamble('rel-codex', cwd);
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toBe(path.join(cwd, 'rel-codex'));
      expect(fs.readFileSync(path.join(res.runDir, 'codex-shared.sha256'), 'utf8')).toContain(
        `CODEX_HOME  ${path.join(cwd, 'rel-codex')}\n`,
      );
    });

    it('aborts with exit 1, before anything is written, for a value the server would replace', () => {
      const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uat-3358-cwd-')));
      const link = path.join(cwd, 'to-dev');
      fs.symlinkSync('/dev', link);
      for (const value of ['/dev/shm/codex', '/proc/x', '/sys', link]) {
        const res = runPreamble(value, cwd);
        expect(res.status, `${value}: ${res.stderr}`).toBe(1);
        expect(res.stderr).toContain('refused by the server');
        expect(fs.existsSync(path.join(res.runDir, 'codex-shared.sha256')), value).toBe(false);
        expect(fs.existsSync(path.join(res.runDir, 'root')), value).toBe(false);
      }
    });

    it('aborts for an explicit CODEX_HOME that is not an existing directory', () => {
      const res = runPreamble(path.join(os.tmpdir(), 'uat-3358-does-not-exist'), os.tmpdir());
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('not an existing directory');
    });

    it('compares in down against the recorded CODEX_HOME, not the caller\'s', () => {
      const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uat-3358-home-')));
      fs.writeFileSync(path.join(home, 'hooks.json'), '{}\n');
      const first = runPreamble(home, os.tmpdir());
      expect(first.status, first.stderr).toBe(0);
      const record = path.join(first.runDir, 'codex-shared.sha256');
      const check = (env: Record<string, string>) =>
        spawnSync('bash', ['-c', `. '${RUN_SERVER}'; check_shared_record '${record}'`], {
          env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), ...env } as unknown as NodeJS.ProcessEnv,
          encoding: 'utf8',
        });
      // Unchanged, even with a different CODEX_HOME in the caller.
      expect(check({ CODEX_HOME: '/nowhere' }).status).toBe(0);
      fs.writeFileSync(path.join(home, 'hooks.json'), '{"changed":true}\n');
      const changed = check({});
      expect(changed.status).toBe(1);
      expect(changed.stderr).toContain(`codex shared file changed during the run: ${home}/hooks.json`);
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(first.runDir, { recursive: true, force: true });
    });

    it('keeps its refused roots identical to the server\'s VIRTUAL_FILESYSTEM_ROOTS', () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, 'src/config/system-directories.ts'), 'utf8');
      const serverRoots = [...source.match(/VIRTUAL_FILESYSTEM_ROOTS = \[([^\]]*)\]/)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect(serverRoots.length).toBeGreaterThan(0);
      const caseBlock = shellFunction('decide_codex_home').match(/case "\$d" in\n\s*([^)]*)\)/)![1];
      const scriptRoots = caseBlock.split('|').map((x) => x.trim()).filter((x) => !x.endsWith('/*'));
      expect(scriptRoots.sort()).toEqual([...serverRoots].sort());
      expect(caseBlock.split('|').map((x) => x.trim()).filter((x) => x.endsWith('/*')).sort()).toEqual(serverRoots.map((r) => `${r}/*`).sort());
    });
  });
});
