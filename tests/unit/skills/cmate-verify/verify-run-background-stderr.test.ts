/**
 * verify-run.sh's gate launch writes nothing to its own stderr from job control
 * (Issue #3944; same shape as env-up.sh, Issue #3935).
 *
 * With `set -m` on, bash calls setpgid in the parent and in the forked child; a
 * failing child call prints `child setpgid (N to N): Operation not permitted` to
 * the stderr it inherited, before the subshell's `> "$rga_log" 2>&1` applies.
 * verify-run.sh wraps `set -m` … `set +m` in `{ … } 2>>"$rga_log.jobctl"`. These
 * tests run THAT block, cut out of the real script, with a cheap command as the
 * gate. The EPERM itself is a race and cannot be forced, so a write to stderr
 * injected inside the region is the deterministic stand-in.
 *
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTempDir } from '@tests/helpers/temp-dir';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const COPIES = [
  '.claude/skills/cmate-verify/scripts/verify-run.sh',
  '.agents/skills/cmate-verify/scripts/verify-run.sh',
];

const GROUP_OPEN = '  {\n  set -m\n';
const GROUP_CLOSE = '  set +m\n  } 2>>"$rga_log.jobctl"\n';

/** The `{ set -m … set +m; } 2>>"$rga_log.jobctl"` block, verbatim. */
function launchBlock(source: string): string {
  const start = source.indexOf(GROUP_OPEN);
  const end = source.indexOf(GROUP_CLOSE);
  if (start < 0 || end < start) throw new Error('verify-run.sh has no `{ set -m … } 2>>"$rga_log.jobctl"` block');
  return source.slice(start, end + GROUP_CLOSE.length);
}

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) removeTempDir(dir);
});

/** Runs `block` once with `gate` as the gate command; prints "pid pgid" to stdout. */
function runBlock(block: string, gate: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-run-bg-stderr-'));
  scratch.push(dir);
  const harness = path.join(dir, 'harness.sh');
  fs.writeFileSync(
    harness,
    `CWD=${JSON.stringify(dir)}
rga_cmd=${JSON.stringify(gate)}
rga_log=${JSON.stringify(path.join(dir, 'gate.log'))}
${block}
pgid=$(ps -o pgid= -p "$rga_pid" 2>/dev/null | tr -d ' ')
echo "$rga_pid $pgid"
wait "$rga_pid"
`,
  );
  const result = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 30_000 });
  const read = (name: string) => {
    const file = path.join(dir, name);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  return { ...result, gateLog: read('gate.log'), jobctl: read('gate.log.jobctl') };
}

describe('verify-run background gate launch (Issue #3944)', () => {
  it('wraps the only `set -m` in a group that appends stderr to a file beside the gate log, in both copies', () => {
    for (const rel of COPIES) {
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      const block = launchBlock(source);
      expect(source.match(/^\s*set -m\b/gm), rel).toHaveLength(1);
      expect(block, rel).toMatch(/^ {2}set -m$/m);
      expect(block, rel).toContain('> "$rga_log" 2>&1 &');
    }
  });

  it('sends a write to stderr inside the region to the jobctl file, not to stderr or the gate log', () => {
    const block = launchBlock(fs.readFileSync(path.join(REPO_ROOT, COPIES[0]), 'utf8')).replace(
      '  set -m\n',
      '  set -m\n  echo region-stderr >&2\n',
    );
    const result = runBlock(block, 'echo gate-out');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.jobctl).toContain('region-stderr');
    expect(result.gateLog).toBe('gate-out\n');
  });

  it('is not vacuous: without the group redirection the same write reaches stderr', () => {
    const block = launchBlock(fs.readFileSync(path.join(REPO_ROOT, COPIES[0]), 'utf8'))
      .replace('  set -m\n', '  set -m\n  echo region-stderr >&2\n')
      .replace('} 2>>"$rga_log.jobctl"', '}');
    const result = runBlock(block, 'echo gate-out');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('region-stderr');
  });

  it('keeps the gate its own process group leader (PGID = PID)', () => {
    const result = runBlock(launchBlock(fs.readFileSync(path.join(REPO_ROOT, COPIES[0]), 'utf8')), 'sleep 1');
    expect(result.status).toBe(0);
    const [pid, pgid] = result.stdout.trim().split(' ');
    expect(pid).toMatch(/^\d+$/);
    expect(pgid).toBe(pid);
  });
});
