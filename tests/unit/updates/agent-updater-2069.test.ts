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
 *  3. **The lock.** After #2068 three paths reach one `npm install -g`. The
 *     lock lives inside `runAgentUpdate` so that calling the function is what
 *     takes it — a caller-side lock only protects the caller that remembered.
 *
 * Two assertions here were vacuous in the first cut and are called out where
 * they are fixed: the absolute-path case asserted a value the test's own helper
 * had hardcoded, and the version boundary compared the constant against itself.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAbsolute } from 'path';
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

/**
 * A machine with codex at `version` on PATH, plus npm.
 *
 * `pathPrefix` is what a `PATH` entry looks like. The default is the ordinary
 * absolute one; the relative spelling is what a `PATH` of `.:/usr/bin` (or a
 * `node_modules/.bin` written without a leading slash) actually produces out of
 * `findExecutableOnPath`, which joins the entry with the name and returns it.
 */
function machine(
  codexVersion: string | null,
  hasNpm: boolean = true,
  pathPrefix: string = '/opt/isolated/bin'
) {
  return {
    resolveExecutable: (name: string): string | null => {
      if (name === 'codex') return codexVersion === null ? null : `${pathPrefix}/codex`;
      if (name === 'npm') return hasNpm ? `${pathPrefix}/npm` : null;
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
  it('puts the native boundary at 0.149.0, the release that added the subcommand', () => {
    // Pinned as a LITERAL. Feeding the constant back into `machine()` — which
    // the first cut of this file did — makes `installed >= MIN` true by
    // construction, so the boundary could move by a whole minor release with
    // every test still green while 0.149.x users all fell to the npm fallback
    // this constant exists to avoid. Measured against codex-cli 0.149.1, whose
    // `codex update --help` reads "Update Codex to the latest version".
    expect(CODEX_NATIVE_UPDATE_MIN_VERSION).toBe('0.149.0');
  });

  it.each([
    ['0.149.0', 'native'],
    ['0.149.1', 'native'],
    ['0.151.0', 'native'],
    ['0.148.99', 'npm'],
    ['0.148.0', 'npm'],
    ['0.99.0', 'npm'],
  ])('picks %s -> %s', async (installed, strategy) => {
    const result = await resolveAgentUpdatePlan('codex', machine(installed));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.strategy).toBe(strategy);
  });

  it('spells the native plan `codex update`', async () => {
    const result = await resolveAgentUpdatePlan('codex', machine('0.149.0'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.args).toEqual(['update']);
    expect(result.plan.reason).toBe('native-subcommand');
  });

  it('falls back to npm one patch BELOW the boundary', async () => {
    // 0.148 has no `update` subcommand; running it would be an error, not a
    // no-op, so this boundary is the whole reason the constant exists.
    const result = await resolveAgentUpdatePlan('codex', machine('0.148.99'));
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
  it.each([
    ['native', '0.149.0'],
    ['npm', '0.148.0'],
  ])('REFUSES a %s plan whose executable resolved to a relative path', async (_s, version) => {
    // The real case: `PATH=.:/usr/bin`, or a `node_modules/.bin` entry written
    // without a leading slash. `findExecutableOnPath` joins the entry with the
    // name and hands back `./codex`, which `execFile` then resolves against the
    // CHILD's cwd — i.e. whichever directory the update happens to run in gets
    // to supply the binary.
    //
    // The first cut of this test asserted `command.startsWith('/')` on a value
    // `machine()` had hardcoded as '/opt/isolated/bin/codex', so it held no
    // matter what the module did. This drives the module with a relative path
    // and asserts the REFUSAL, which only the isAbsolute check can produce.
    const result = await resolveAgentUpdatePlan('codex', machine(version, true, './bin'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no-executable');
  });

  it('refuses a bare name (a resolver that just echoes back what it was asked)', async () => {
    const result = await resolveAgentUpdatePlan('codex', {
      resolveExecutable: (name: string) => name,
      probeInstalledVersion: async () => '0.151.0',
    });
    expect(result.ok).toBe(false);
  });

  it('falls back to npm when only CODEX resolved relatively', async () => {
    // Not an all-or-nothing gate: an unusable codex must still leave the npm
    // route open, exactly as a missing codex does.
    const result = await resolveAgentUpdatePlan('codex', {
      resolveExecutable: (name: string) => (name === 'codex' ? './codex' : '/usr/bin/npm'),
      probeInstalledVersion: async () => '0.151.0',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.strategy).toBe('npm');
    expect(result.plan.command).toBe('/usr/bin/npm');
  });

  it('produces an absolute command on THIS machine, with no injected resolver', async () => {
    // The default resolver is not covered by any test that injects one, so a
    // default of `(name) => name` would slip through all of the above. npm is
    // always present wherever this suite runs, so a plan is always produced.
    const result = await resolveAgentUpdatePlan('codex');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isAbsolute(result.plan.command)).toBe(true);
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

describe('[#2069] the in-flight lock — the primitive', () => {
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

  it('stays exported from the barrel: the #2068 in-pane path takes it directly', async () => {
    // That path cannot go through `runAgentUpdate` (codex itself runs the
    // install; CommandMate only answers a dialog), so these three are the
    // seam. Deleting them from `lib/updates` would silently leave the third
    // caller unserialised.
    const barrel = await import('@/lib/updates');
    expect(typeof barrel.acquireAgentUpdateLock).toBe('function');
    expect(typeof barrel.releaseAgentUpdateLock).toBe('function');
    expect(typeof barrel.isAgentUpdateInProgress).toBe('function');
  });
});

describe('[#2069] the in-flight lock lives INSIDE runAgentUpdate', () => {
  const slow = (): AgentUpdatePlan => ({
    tool: 'codex',
    strategy: 'native',
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.stdout.write("done"), 120)'],
    display: 'node -e ...',
    installed: '0.149.0',
    reason: 'native-subcommand',
  });

  beforeEach(() => releaseAgentUpdateLock('codex'));
  afterEach(() => releaseAgentUpdateLock('codex'));

  it('takes the lock without the caller doing anything', async () => {
    const running = runAgentUpdate(slow());
    // Synchronously after the call, before any await resolves: this is what
    // lets the route read `isAgentUpdateInProgress` and answer 409 with no
    // interleaving point in between.
    expect(isAgentUpdateInProgress('codex')).toBe(true);
    await running;
  });

  it('gives the lock back when the run finishes', async () => {
    await runAgentUpdate(slow());
    expect(isAgentUpdateInProgress('codex')).toBe(false);
  });

  it('gives the lock back when the run FAILS', async () => {
    await runAgentUpdate({ ...slow(), command: '/nonexistent/definitely/not/here', args: [] });
    expect(isAgentUpdateInProgress('codex')).toBe(false);
  });

  it('refuses a second concurrent run and spawns NOTHING for it', async () => {
    // This is the protection every caller now gets for free — the CLI
    // (`commandmate agents update`) never touches the lock itself.
    const first = runAgentUpdate(slow());

    const chunks: string[] = [];
    const second = await runAgentUpdate(slow(), { onChunk: (c) => chunks.push(c.text) });

    expect(second.ok).toBe(false);
    expect(second.code).toBe('in_progress');
    // Nothing ran: no output, and no exit status to report.
    expect(chunks).toEqual([]);
    expect(second.exitCode).toBeNull();

    // And the refusal must not have stolen the running update's marker.
    expect(isAgentUpdateInProgress('codex')).toBe(true);
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(isAgentUpdateInProgress('codex')).toBe(false);
  });

  it('refuses when the lock was taken by the in-pane path (#2068)', async () => {
    expect(acquireAgentUpdateLock('codex')).toBe(true);
    const result = await runAgentUpdate(slow());
    expect(result.code).toBe('in_progress');
    // Still held by whoever took it — `runAgentUpdate` must not release a lock
    // it never acquired.
    expect(isAgentUpdateInProgress('codex')).toBe(true);
  });
});
