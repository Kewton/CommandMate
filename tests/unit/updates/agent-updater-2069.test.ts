/**
 * Planning and running an agent CLI's updater (Issue #2069).
 *
 * Two things this suite is actually defending:
 *
 *  1. **The strategy choice.** `codex update` exists from 0.149.0 and is an
 *     unknown-subcommand error below it, so the boundary is not cosmetic — get
 *     it wrong by one release and every 0.148 user's update button fails.
 *  2. **The command shape.** 実装内容 4 says `execFile` with an argv array and
 *     no shell string concatenation. That is a property of the *plan*, so it is
 *     assertable without spawning anything: an argv array whose members carry
 *     no shell metacharacters, and a command that is an absolute path rather
 *     than a name PATH gets to resolve at exec time.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  acquireAgentUpdateLock,
  CODEX_NATIVE_UPDATE_MIN_VERSION,
  CODEX_NPM_PACKAGE,
  isAgentUpdateInProgress,
  isUpdatableAgentTool,
  releaseAgentUpdateLock,
  resolveAgentUpdatePlan,
  runAgentUpdate,
  UPDATABLE_AGENT_TOOLS,
  type AgentUpdatePlan,
} from '@/lib/updates/agent-updater';

/** A machine with codex at `version` on PATH, plus npm. */
function machine(codexVersion: string | null, hasNpm: boolean = true) {
  return {
    resolveExecutable: (name: string): string | null => {
      if (name === 'codex') return codexVersion === null ? null : '/opt/isolated/bin/codex';
      if (name === 'npm') return hasNpm ? '/opt/isolated/bin/npm' : null;
      return null;
    },
    probeInstalledVersion: async (): Promise<string | null> => codexVersion,
  };
}

describe('[#2069] isUpdatableAgentTool', () => {
  it('accepts only the declared tools', () => {
    expect(isUpdatableAgentTool('codex')).toBe(true);
    expect(UPDATABLE_AGENT_TOOLS).toContain('codex');
  });

  it('rejects everything a request body could otherwise smuggle through', () => {
    for (const value of [
      'claude',
      'codex; rm -rf /',
      'codex update',
      '',
      null,
      undefined,
      42,
      { tool: 'codex' },
      ['codex'],
    ]) {
      expect(isUpdatableAgentTool(value)).toBe(false);
    }
  });
});

describe('[#2069] resolveAgentUpdatePlan — strategy choice', () => {
  it('prefers `codex update` at the minimum version', async () => {
    const result = await resolveAgentUpdatePlan('codex', machine(CODEX_NATIVE_UPDATE_MIN_VERSION));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.strategy).toBe('native');
    expect(result.plan.args).toEqual(['update']);
    expect(result.plan.reason).toBe('native-subcommand');
  });

  it('prefers `codex update` above the minimum version', async () => {
    const result = await resolveAgentUpdatePlan('codex', machine('0.151.0'));
    expect(result.ok && result.plan.strategy).toBe('native');
  });

  it('falls back to npm one patch BELOW the minimum version', async () => {
    // 0.148 has no `update` subcommand; running it would be an error, not a
    // no-op, so this boundary is the whole reason the constant exists.
    const result = await resolveAgentUpdatePlan('codex', machine('0.148.0'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.strategy).toBe('npm');
    expect(result.plan.args).toEqual(['install', '-g', `${CODEX_NPM_PACKAGE}@latest`]);
    expect(result.plan.reason).toBe('no-native-subcommand');
  });

  it('falls back to npm when codex is not on PATH at all', async () => {
    const result = await resolveAgentUpdatePlan('codex', machine(null));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.strategy).toBe('npm');
    expect(result.plan.reason).toBe('not-installed');
    expect(result.plan.installed).toBeNull();
  });

  it('falls back to npm when the installed version cannot be parsed', async () => {
    const result = await resolveAgentUpdatePlan('codex', {
      resolveExecutable: () => '/opt/isolated/bin/codex',
      probeInstalledVersion: async () => null,
    });
    expect(result.ok && result.plan.strategy).toBe('npm');
  });

  it('refuses a tool it has no flow for, without probing anything', async () => {
    const result = await resolveAgentUpdatePlan('claude', machine('0.151.0'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unsupported-tool');
  });

  it('refuses when neither codex nor npm can be resolved', async () => {
    const result = await resolveAgentUpdatePlan('codex', machine(null, false));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no-executable');
  });
});

describe('[#2069] resolveAgentUpdatePlan — the command shape (実装内容 4)', () => {
  it('resolves the command to an ABSOLUTE path, never a bare name', async () => {
    for (const version of [CODEX_NATIVE_UPDATE_MIN_VERSION, '0.148.0']) {
      const result = await resolveAgentUpdatePlan('codex', machine(version));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.command.startsWith('/')).toBe(true);
    }
  });

  it('carries the arguments as an ARRAY with no shell metacharacters', async () => {
    for (const version of [CODEX_NATIVE_UPDATE_MIN_VERSION, '0.148.0']) {
      const result = await resolveAgentUpdatePlan('codex', machine(version));
      if (!result.ok) throw new Error('expected a plan');
      expect(Array.isArray(result.plan.args)).toBe(true);
      for (const arg of result.plan.args) {
        expect(arg).not.toMatch(/[;&|`$><\n]/);
      }
    }
  });

  it('keeps `display` out of the executed path — it is a different value', async () => {
    const result = await resolveAgentUpdatePlan('codex', machine('0.151.0'));
    if (!result.ok) throw new Error('expected a plan');
    // The string a human reads is `codex update`; what runs is the absolute
    // path plus ['update']. If those two ever became the same field, the
    // display string would be an execution input.
    expect(result.plan.display).toBe('codex update');
    expect(result.plan.command).not.toBe(result.plan.display);
  });
});

describe('[#2069] runAgentUpdate', () => {
  const plan = (args: string[]): AgentUpdatePlan => ({
    tool: 'codex',
    strategy: 'native',
    command: process.execPath,
    args,
    display: 'node -e ...',
    installed: '0.149.0',
    reason: 'native-subcommand',
  });

  it('streams stdout and stderr as they arrive, and reports success', async () => {
    const chunks: string[] = [];
    const result = await runAgentUpdate(
      plan(['-e', 'process.stdout.write("out"); process.stderr.write("err")']),
      { onChunk: (chunk) => chunks.push(`${chunk.stream}:${chunk.text}`) }
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(chunks).toContain('stdout:out');
    expect(chunks).toContain('stderr:err');
  });

  it('reports a non-zero exit as a result rather than throwing', async () => {
    const result = await runAgentUpdate(plan(['-e', 'process.exit(7)']));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
  });

  it('reports a missing executable as a result rather than throwing', async () => {
    const missing: AgentUpdatePlan = {
      ...plan([]),
      command: '/nonexistent/definitely/not/here',
    };
    const result = await runAgentUpdate(missing);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('does NOT interpret its arguments through a shell', async () => {
    // Handed to a shell, `; process.stdout.write("PWNED")` would run. Through
    // execFile's argv array it is one literal argument to `-e`, and the program
    // it forms writes only "safe".
    const chunks: string[] = [];
    await runAgentUpdate(plan(['-e', 'process.stdout.write("safe")']), {
      onChunk: (chunk) => chunks.push(chunk.text),
    });
    expect(chunks.join('')).toBe('safe');
  });
});

describe('[#2069] the in-flight lock', () => {
  afterEach(() => releaseAgentUpdateLock('codex'));

  beforeEach(() => releaseAgentUpdateLock('codex'));

  it('admits one holder and refuses the second', () => {
    expect(acquireAgentUpdateLock('codex')).toBe(true);
    expect(isAgentUpdateInProgress('codex')).toBe(true);
    expect(acquireAgentUpdateLock('codex')).toBe(false);
  });

  it('is re-acquirable after release', () => {
    acquireAgentUpdateLock('codex');
    releaseAgentUpdateLock('codex');
    expect(isAgentUpdateInProgress('codex')).toBe(false);
    expect(acquireAgentUpdateLock('codex')).toBe(true);
  });

  it('tolerates a release with nothing held', () => {
    expect(() => releaseAgentUpdateLock('codex')).not.toThrow();
  });
});
