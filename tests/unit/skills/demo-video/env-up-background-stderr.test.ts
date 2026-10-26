/**
 * env-up.sh's background boot writes nothing to env-up's stderr (Issue #3935).
 *
 * With `set -m` on, bash calls setpgid(child, child) in both the parent and the
 * forked child. When the parent's call lands first the child's can fail with
 * EPERM, and the child prints `child setpgid (N to N): Operation not permitted`
 * to the stderr it inherited — before the subshell's `>"$LOG_FILE" 2>&1` takes
 * effect. env-up-listener-owner.test.ts and env-scripts.test.ts both require
 * env-up's stderr to be empty, so the line failed them now and then under load.
 *
 * env-up now wraps `set -m` … `set +m` in `{ … } 2>>"$LOG_FILE"`. These tests
 * run THAT block, cut out of the real script, with a cheap command in place of
 * the server:
 *   - many times in parallel (the load that made the race visible), stderr empty;
 *   - with a write to stderr injected inside the region, which must reach the
 *     log and not stderr — and, as the positive control, does reach stderr once
 *     the group's redirection is removed (the shape before #3935).
 * The EPERM itself is a race and cannot be forced, so the injected write is the
 * deterministic stand-in; tests/scripts/demo-video-bg-setpgid-load.sh measures
 * the race against both shapes.
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
const ENV_UP_COPIES = [
  '.claude/skills/demo-video/scripts/env-up.sh',
  '.agents/skills/demo-video/scripts/env-up.sh',
];
const ENV_UP = path.join(REPO_ROOT, ENV_UP_COPIES[0]);

const GROUP_OPEN = '{\nset -m\n';
const GROUP_CLOSE = '\nset +m\n} 2>>"$LOG_FILE"\n';

/** The `{ set -m … set +m; } 2>>"$LOG_FILE"` block of env-up.sh, verbatim. */
function bootBlock(source: string): string {
  const start = source.indexOf(GROUP_OPEN);
  const end = source.indexOf(GROUP_CLOSE);
  if (start < 0 || end < start) throw new Error('env-up.sh has no `{ set -m … } 2>>"$LOG_FILE"` block');
  return source.slice(start, end + GROUP_CLOSE.length);
}

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) removeTempDir(dir);
});

/**
 * Runs `block` `iterations` times in each of `loops` parallel loops, each with
 * its own log, and returns the harness's stderr and the logs' contents.
 */
function runBlock(block: string, loops: number, iterations: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-video-bg-stderr-'));
  scratch.push(dir);
  const harness = path.join(dir, 'harness.sh');
  fs.writeFileSync(
    harness,
    `REPO_ROOT=${JSON.stringify(dir)}
PORT=1 DB_PATH=/nonexistent SEED_REPO=/nonexistent SEED_ROOT=/nonexistent
SERVER_CMD="sleep 0"
boot_loop() {
  local i
  for ((i = 0; i < ${iterations}; i++)); do
    LOG_FILE="${dir}/log-$1"
    : >"$LOG_FILE"
${block}
    [ "$(cat "$LOG_FILE")" = "" ] || cp "$LOG_FILE" "$LOG_FILE.kept-$i"
    wait "$SERVER_PID"
  done
}
for ((n = 0; n < ${loops}; n++)); do boot_loop "$n" & done
wait
`,
  );
  const result = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 60_000 });
  const kept = fs
    .readdirSync(dir)
    .filter((name) => name.includes('.kept-'))
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('');
  return { status: result.status, stderr: result.stderr, kept };
}

describe('env-up background boot stderr (Issue #3935)', () => {
  it('routes the stderr of `set -m` … `set +m` to the server log in both copies', () => {
    for (const rel of ENV_UP_COPIES) {
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      const block = bootBlock(source);
      // Exactly one `set -m`, and it is inside the redirected group.
      expect(source.match(/^\s*set -m\b/gm), rel).toHaveLength(1);
      expect(block, rel).toMatch(/^set -m$/m);
      // The subshell appends, so it does not wipe a line bash wrote first.
      expect(block, rel).toContain(') >>"$LOG_FILE" 2>&1 &');
    }
  });

  it('keeps stderr empty over hundreds of parallel boots', () => {
    const result = runBlock(bootBlock(fs.readFileSync(ENV_UP, 'utf8')), 8, 100);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  }, 60_000);

  it('sends a write to stderr inside the region to the log, not to stderr', () => {
    const block = bootBlock(fs.readFileSync(ENV_UP, 'utf8')).replace(
      'set -m\n',
      'set -m\necho region-stderr >&2\n',
    );
    const result = runBlock(block, 1, 3);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.kept).toContain('region-stderr');
  });

  it('is not vacuous: without the group redirection the same write reaches stderr', () => {
    const block = bootBlock(fs.readFileSync(ENV_UP, 'utf8'))
      .replace('set -m\n', 'set -m\necho region-stderr >&2\n')
      .replace('} 2>>"$LOG_FILE"', '}');
    const result = runBlock(block, 1, 3);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('region-stderr');
  });
});
