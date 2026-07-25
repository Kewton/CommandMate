import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MONITOR = path.join(
  process.cwd(),
  '.claude/skills/orchestrate-monitor/scripts/monitor.sh',
);
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

interface RunResult {
  stdout: string;
  /** One line per `tmux ...` invocation the loop made. */
  tmuxCalls: string[];
}

/**
 * Run the loop against a fixed capture frame with `tmux` and the commandmate
 * launcher replaced by shims, then stop it. The loop only exits on COMPLETE — and
 * with count_commits/count_uncommitted stubbed to 0 it never gets there — so it is
 * terminated on a timeout, which is also what exercises the EXIT trap.
 */
function runLoop(fixture: string, extraArgs: string[] = []): RunResult {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-resend-'));
  const tmuxLog = path.join(dir, 'tmux.log');
  const tmuxShim = path.join(dir, 'tmux');
  const cmShim = path.join(dir, 'fake-cm');

  writeFileSync(tmuxShim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${tmuxLog}"\nexit 0\n`);
  writeFileSync(cmShim, `#!/bin/sh\ncat "${path.join(FIXTURES, fixture)}"\n`);
  chmodSync(tmuxShim, 0o755);
  chmodSync(cmShim, 0o755);
  writeFileSync(tmuxLog, '');

  const proc = spawnSync(
    'bash',
    [MONITOR, '--interval', '1', '--idle-threshold', '1', ...extraArgs, 'w1'],
    {
      encoding: 'utf8',
      timeout: 2500,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CM: cmShim },
    },
  );

  return {
    stdout: proc.stdout ?? '',
    tmuxCalls: readFileSync(tmuxLog, 'utf8').split('\n').filter(Boolean),
  };
}

describe('monitor.sh recovers from retry exhaustion (Issue #1522, defect 4)', () => {
  it('resends once the CLI has given up and fallen back to an idle prompt', () => {
    const { stdout, tmuxCalls } = runLoop('live-api-error-exhausted.json', [
      '--max-resends',
      '1',
      '--resend-message',
      'resume please',
    ]);

    expect(tmuxCalls.some((c) => c.includes('send-keys') && c.includes('resume please'))).toBe(
      true,
    );
    expect(tmuxCalls.some((c) => c.includes('-t cm-w1'))).toBe(true);
    expect(stdout).toContain('resending (1/1)');
    // Capped, then escalated instead of typing into the pane forever.
    expect(stdout).toContain('resend budget spent');
    expect(tmuxCalls.filter((c) => c.includes('resume please'))).toHaveLength(1);
  }, 20_000);

  it('never intervenes while the CLI is still inside its own backoff', () => {
    // The production harm: input sent mid-backoff is queued, then delivered once
    // the retry succeeds, pushing the worker into work it was never asked to do.
    const { stdout, tmuxCalls } = runLoop('live-retrying-529.json');
    expect(tmuxCalls).toEqual([]);
    expect(stdout).not.toContain('rate limit');
    expect(stdout).not.toContain('resending');
  }, 20_000);

  it('never intervenes on a healthy worker whose pane shows rate-limiter source', () => {
    // The 5th defect at loop level: this frame used to classify as RATE_LIMIT and
    // get an `a` typed into it.
    const { stdout, tmuxCalls } = runLoop('live-generating-rate-limit-source.json');
    expect(tmuxCalls).toEqual([]);
    expect(stdout).not.toContain("sending 'a'");
  }, 20_000);

  it('still sends "a" on a genuine usage-limit banner', () => {
    const { stdout, tmuxCalls } = runLoop('rate-limit.json');
    expect(stdout).toContain("rate limit -> sending 'a'");
    expect(tmuxCalls.some((c) => c.includes('send-keys') && c.includes('-t cm-w1 a Enter'))).toBe(
      true,
    );
  }, 20_000);
});
