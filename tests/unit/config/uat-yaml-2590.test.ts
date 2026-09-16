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
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const UAT_YAML = path.join(REPO_ROOT, '.commandmate/uat.yaml');

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

/** Shell lines as bash sees them: a trailing backslash joins the next line. */
function logicalLines(script: string): string[] {
  return script
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
    const serverLines = logicalLines(spec.env.up).filter((line) => line.includes('dist/server/server.js'));
    expect(serverLines, 'exactly one line starts the server').toHaveLength(1);
    const [line] = serverLines;
    expect(line.startsWith('env -i '), `the server line must begin with env -i: ${line}`).toBe(true);
    for (const assignment of [
      'CM_PORT={port}',
      'CM_BIND=127.0.0.1',
      'CM_DB_PATH={run_dir}/',
      'CM_ROOT_DIR={run_dir}/',
      // The production code calls tmux with no socket argument, so TMUX decides
      // which server it reaches. It has to name the private socket, never the
      // caller's value (env -i drops that, and this puts the private one back).
      'TMUX="/tmp/cmuat-{port}/tmux.sock,',
    ]) {
      expect(line, `the server line must set ${assignment}`).toContain(assignment);
    }
  });

  it('has no statement in env.up that only assigns variables (the symptom of a broken continuation)', () => {
    const bareAssignment = /^[A-Z_][A-Z0-9_]*=\S*(\s+[A-Z_][A-Z0-9_]*=\S*)*$/;
    for (const line of logicalLines(spec.env.up)) {
      expect(line, `a bare assignment line does not reach the server: ${line}`).not.toMatch(bareAssignment);
    }
  });

  it('never talks to a tmux server without naming its socket', () => {
    // With TMUX set in the caller, a bare `tmux kill-server` reaches the user's
    // own server. Every tmux command in up and down names the private socket.
    for (const script of [spec.env.up, spec.env.down ?? '']) {
      for (const line of logicalLines(script)) {
        for (const match of line.matchAll(/(?:^|[;&|(]\s*)tmux\s+(\S+)/g)) {
          expect(match[1], `tmux without -S: ${line}`).toBe('-S');
        }
      }
    }
  });

  it('stops only what LISTENS on the port (CommandMate#2473)', () => {
    const down = spec.env.down ?? '';
    const lsofCalls = [...down.matchAll(/lsof\s[^\n;|)]*/g)].map((match) => match[0]);
    expect(lsofCalls.length).toBeGreaterThan(0);
    for (const call of lsofCalls) {
      expect(call, `lsof without the LISTEN filter: ${call}`).toContain('-sTCP:LISTEN');
    }
    expect(down).not.toMatch(/\b(pkill|killall)\b/);
  });

  it('writes its run output under .commandmate/uat, which .gitignore keeps out of the repository', () => {
    expect(spec.report_dir ?? '.commandmate/uat').toBe('.commandmate/uat');
  });
});
