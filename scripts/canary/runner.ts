/**
 * Orchestrator for `npm run canary` (Issue #1727).
 *
 * Run shape:
 *   preflight → guard snapshot → throwaway HOME → private tmux server
 *   → one fresh session per scenario (drive → poll → assert → fixture)
 *   → teardown → re-check the guards → summary
 *
 * The guards are re-checked between scenarios, not just at the end, so a
 * violation names the scenario that caused it.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import {
  buildClaudeLaunchCommand,
  isHookInjectionEnabled,
  shellQuote,
} from '@/lib/hooks/hook-settings-generator';
import { formatHelp, parseArgs, type CanaryOptions } from './cli';
import { writeFixtureArtifacts } from './fixtures';
import { findUpstreamFault } from './expectations';
import { assertGuardSnapshotIntact, captureGuardSnapshot, type GuardSnapshot } from './guards';
import { CanaryHookReceiver, CANARY_INSTANCE_ID } from './hook-receiver';
import { createIsolatedHome, type IsolatedHome } from './isolated-home';
import { CANARY_CLI_TOOL, summarizeObservation } from './probe';
import { SCENARIOS, selectScenarios } from './scenarios';
import { buildLaunchCommand, CANARY_PERMISSION_MODE, CanarySession } from './session';
import { CANARY_SOCKET_PREFIX, PrivateTmuxServer } from './tmux-private';
import { ObservationTimeoutError, type CanaryScenario, type ScenarioResult } from './types';

const execFileAsync = promisify(execFile);

/** Minimum tmux that supports `new-session -e VAR=value`. */
const MIN_TMUX_VERSION = '3.2';

interface Preflight {
  claudeBinary: string;
  claudeVersion: string;
  tmuxVersion: string;
}

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`canary: could not locate the repo root from ${startDir}`);
    }
    dir = parent;
  }
}

async function runPreflight(): Promise<Preflight> {
  let claudeBinary: string;
  try {
    const { stdout } = await execFileAsync('command', ['-v', 'claude'], { shell: '/bin/sh' });
    claudeBinary = stdout.trim().split('\n')[0];
  } catch {
    throw new Error('canary: `claude` is not on PATH — install Claude Code first');
  }
  if (!claudeBinary) {
    throw new Error('canary: `claude` is not on PATH — install Claude Code first');
  }

  const { stdout: versionOut } = await execFileAsync(claudeBinary, ['--version'], { timeout: 30_000 });
  const claudeVersion = versionOut.trim();

  let tmuxVersion: string;
  try {
    const { stdout } = await execFileAsync('tmux', ['-V'], { timeout: 10_000 });
    tmuxVersion = stdout.trim();
  } catch {
    throw new Error('canary: tmux is not installed');
  }
  const numeric = /(\d+)\.(\d+)/.exec(tmuxVersion);
  if (numeric) {
    const [major, minor] = [Number(numeric[1]), Number(numeric[2])];
    const [minMajor, minMinor] = MIN_TMUX_VERSION.split('.').map(Number);
    if (major < minMajor || (major === minMajor && minor < minMinor)) {
      throw new Error(
        `canary: tmux ${tmuxVersion} is too old — ${MIN_TMUX_VERSION}+ is required for \`new-session -e\``
      );
    }
  }

  return { claudeBinary, claudeVersion, tmuxVersion };
}

interface RunScenarioDeps {
  tmux: PrivateTmuxServer;
  home: IsolatedHome;
  preflight: Preflight;
  runId: string;
  repoRoot: string;
  options: CanaryOptions;
  log: (message: string) => void;
  /** Non-null once any selected scenario declares `hooks` (Issue #1847). */
  receiver: CanaryHookReceiver | null;
}

/**
 * Correlation key baked into this scenario's injected hook URLs.
 *
 * Not a real worktree id and never looked up in a database: the canary's
 * receiver only checks that a request carries the id of the scenario it is
 * currently answering for, which is what stops a straggling session from an
 * earlier scenario being adjudicated against the current one's policy.
 */
function hookWorktreeIdFor(scenario: CanaryScenario): string {
  return `canary-${scenario.id}`;
}

/**
 * Wire a scenario's session to the canary's receiver (Issue #1847).
 *
 * The launch command comes from the production launcher, so the settings file
 * under test is byte-for-byte the one a real CommandMate session gets — only
 * `port` (the receiver's ephemeral one) and `directory` (inside the throwaway
 * HOME, never `~/.commandmate/hooks`) are overridden.
 *
 * @returns The shell command tmux should run, and the per-capture hook sampler
 */
function prepareHookSession(
  scenario: CanaryScenario,
  deps: RunScenarioDeps
): { launchCommand: string; observeHooks: CanaryHookReceiver['observe'] } {
  const { receiver, home, preflight, options, log } = deps;
  const hooks = scenario.hooks;
  if (!hooks || !receiver) {
    throw new Error(`canary: scenario ${scenario.id} has no hook receiver to attach to`);
  }
  if (!isHookInjectionEnabled()) {
    throw new Error(
      'canary: CM_AGENT_HOOKS_INJECT=0 disables hook injection, so the Auto-Yes v2 scenarios ' +
        'would silently run a session with no hooks at all. Unset it and re-run.'
    );
  }

  const worktreeId = hookWorktreeIdFor(scenario);
  const launchCommand = buildClaudeLaunchCommand(
    preflight.claudeBinary,
    { worktreeId, instanceId: CANARY_INSTANCE_ID, cliToolId: CANARY_CLI_TOOL },
    {
      port: receiver.port,
      directory: path.join(home.root, 'hooks'),
      // The receiver has no auth middleware, and `$CM_AUTH_TOKEN` would be sent
      // as a literal `$CM_AUTH_TOKEN` unless the throwaway session carried the
      // variable (D7). Asking for the header would only add a way to fail.
      withAuthHeader: false,
    }
  );
  if (launchCommand === preflight.claudeBinary) {
    throw new Error(
      'canary: the hook settings file could not be written, so the session would start without ' +
        'hooks and the scenario would assert nothing. See the hook-settings-write-failed warning.'
    );
  }
  // Last, so a failure above leaves the receiver unconfigured rather than
  // answering for a session that is never going to start.
  receiver.beginSession({
    worktreeId,
    policy: hooks.policy,
    probeFilePath: path.join(home.workingDirectoryFor(scenario.id), hooks.probeFile),
    invertVerdict: options.mutateVerdict,
  });
  log(`  hooks: receiver on 127.0.0.1:${receiver.port}, worktreeId=${worktreeId}`);
  return { launchCommand, observeHooks: receiver.observe.bind(receiver) };
}

async function runScenario(scenario: CanaryScenario, deps: RunScenarioDeps): Promise<ScenarioResult> {
  const { tmux, home, preflight, runId, repoRoot, options, log } = deps;
  const expectation = options.mutate ? scenario.mutantExpectation : scenario.expectation;
  // `--mutate-verdict` deliberately keeps the full timeout: a mutated hook
  // scenario is supposed to go red because the flipped reply changed the SCREEN,
  // and cutting the clock short would make it go red because nothing had
  // happened yet — a self-test that passes for the wrong reason.
  const timeoutMs = options.mutate ? Math.min(scenario.timeoutMs, 30_000) : scenario.timeoutMs;
  const startedAt = Date.now();
  const sessionName = `${CANARY_SOCKET_PREFIX}${scenario.id}-${runId}`;

  log(`\n▶ ${scenario.id} — ${scenario.title}`);
  log(`  expect: ${expectation.label}`);
  if (options.mutateVerdict && scenario.hooks) {
    log('  --mutate-verdict: the receiver answers the OPPOSITE verdict; this scenario must FAIL.');
  }

  const hookSession = scenario.hooks ? prepareHookSession(scenario, deps) : null;
  const session = await CanarySession.start({
    tmux,
    sessionName,
    workingDirectory: home.workingDirectoryFor(scenario.id),
    isolatedHome: home.root,
    claudeBinary: preflight.claudeBinary,
    log,
    // Every scenario, hooks or not: see CANARY_PERMISSION_MODE.
    launchCommand: buildLaunchCommand(
      hookSession?.launchCommand ?? shellQuote(preflight.claudeBinary)
    ),
    ...(hookSession ? { observeHooks: hookSession.observeHooks } : {}),
  });

  try {
    await scenario.drive(session);
    const observation = await session.waitFor(observed => expectation.matches(observed), {
      timeoutMs,
      pollIntervalMs: scenario.pollIntervalMs,
      label: expectation.label,
    });
    const observed = summarizeObservation(observation);
    log(`  ✓ ${JSON.stringify(observed)}`);

    const fixtures = options.mutate
      ? undefined
      : writeFixtureArtifacts(repoRoot, {
          scenarioId: scenario.id,
          title: scenario.title,
          claudeVersion: preflight.claudeVersion,
          capturedAtIso: new Date().toISOString(),
          expectationLabel: expectation.label,
          passed: true,
          observed,
          frame: observation.frame,
        });

    return {
      scenarioId: scenario.id,
      title: scenario.title,
      status: 'passed',
      expectationLabel: expectation.label,
      durationMs: Date.now() - startedAt,
      observed,
      ...(fixtures ? { fixtures } : {}),
    };
  } catch (error) {
    if (!(error instanceof ObservationTimeoutError)) throw error;

    const observation = error.lastObservation;
    const observed = observation ? summarizeObservation(observation) : undefined;
    // An upstream fault (API overload, rate limit) is not a detection
    // regression: report it as `blocked` so a nightly run does not page anyone
    // about Anthropic capacity.
    const upstreamFault = observation ? findUpstreamFault(observation.frame) : null;
    log(`  ✗ ${error.message}`);
    if (upstreamFault) log(`    upstream fault visible: ${upstreamFault.id} — NOT a detection regression`);
    if (observed) log(`    last seen: ${JSON.stringify(observed)}`);

    const fixtures =
      observation && !options.mutate
        ? writeFixtureArtifacts(repoRoot, {
            scenarioId: scenario.id,
            title: scenario.title,
            claudeVersion: preflight.claudeVersion,
            capturedAtIso: new Date().toISOString(),
            expectationLabel: expectation.label,
            passed: false,
            observed: observed ?? {},
            frame: observation.frame,
          })
        : undefined;
    if (fixtures) log(`    frame saved: ${fixtures.module} (+ ${fixtures.raw})`);

    return {
      scenarioId: scenario.id,
      title: scenario.title,
      status: upstreamFault ? 'blocked' : 'failed',
      expectationLabel: expectation.label,
      durationMs: Date.now() - startedAt,
      ...(observed ? { observed } : {}),
      error: upstreamFault ? `${error.message} (upstream fault: ${upstreamFault.id})` : error.message,
      ...(fixtures ? { fixtures } : {}),
    };
  } finally {
    if (options.keep) {
      log(`  --keep: leaving session ${sessionName} on socket ${tmux.socketName}`);
    } else {
      await session.close(scenario.resetKeys ?? []);
    }
    // After the session is gone, so a straggling request from it cannot be
    // adjudicated against the NEXT scenario's policy.
    deps.receiver?.endSession();
  }
}

function formatSummary(
  results: readonly ScenarioResult[],
  preflight: Preflight,
  home: IsolatedHome,
  options: CanaryOptions,
  totalMs: number
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('─'.repeat(78));
  lines.push(
    options.mutate || options.mutateVerdict
      ? 'MUTATION SELF-TEST SUMMARY'
      : 'DETECTION CANARY SUMMARY'
  );
  lines.push('─'.repeat(78));
  lines.push(`claude    : ${preflight.claudeVersion}`);
  lines.push(`tmux      : ${preflight.tmuxVersion}`);
  lines.push(
    `auth      : ${home.authSource.kind === 'env' ? `env ${home.authSource.variable}` : `keychain "${home.authSource.service}"`}`
  );
  lines.push(`duration  : ${(totalMs / 1000).toFixed(1)}s`);
  lines.push('');

  const marks: Record<ScenarioResult['status'], string> = {
    passed: 'PASS',
    failed: 'FAIL',
    blocked: 'BLOCKED',
    skipped: 'SKIP',
  };
  for (const result of results) {
    const mark = marks[result.status];
    lines.push(`  [${mark}] ${result.scenarioId.padEnd(28)} ${(result.durationMs / 1000).toFixed(1)}s`);
    if (result.observed) {
      lines.push(
        `         status=${result.observed.status} reason=${result.observed.reason} ` +
          `hasActivePrompt=${result.observed.hasActivePrompt} autoYesIsPrompt=${result.observed.autoYesIsPrompt}`
      );
    }
    if (result.error) lines.push(`         ${result.error}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: CanaryOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const scenarioIds = SCENARIOS.map(scenario => scenario.id);
  if (options.help) {
    console.log(formatHelp(scenarioIds));
    return 0;
  }
  if (options.list) {
    for (const scenario of SCENARIOS) {
      console.log(`${scenario.id}\n  ${scenario.title}\n  cost: ${scenario.cost}  timeout: ${scenario.timeoutMs / 1000}s`);
      console.log(`  ${scenario.intent}`);
      console.log(`  expects: ${scenario.expectation.label}\n`);
    }
    return 0;
  }

  const log = (message: string): void => {
    if (!options.json) console.log(message);
  };

  let selected: CanaryScenario[];
  try {
    selected = selectScenarios(options.only, options.skip);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (selected.length === 0) {
    console.error('canary: no scenarios selected');
    return 2;
  }

  // `--mutate-verdict` mutates the hook receiver, so it has nothing to say
  // about a scenario that runs a bare `claude`. Those are reported SKIP rather
  // than silently dropped, so the summary shows what the self-test did not cover.
  const verdictSkipped: CanaryScenario[] = options.mutateVerdict
    ? selected.filter(scenario => !scenario.hooks)
    : [];
  if (options.mutateVerdict) {
    selected = selected.filter(scenario => scenario.hooks);
    if (selected.length === 0) {
      console.error(
        'canary: --mutate-verdict selected no scenario with a hook receiver. ' +
          `Hook scenarios: ${SCENARIOS.filter(s => s.hooks).map(s => s.id).join(', ')}`
      );
      return 2;
    }
  }

  const repoRoot = findRepoRoot(process.cwd());
  const realHome = os.homedir();
  const startedAt = Date.now();

  let preflight: Preflight;
  let snapshot: GuardSnapshot;
  try {
    preflight = await runPreflight();
    snapshot = await captureGuardSnapshot(realHome);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  log(`claude ${preflight.claudeVersion} · ${preflight.tmuxVersion} · --permission-mode ${CANARY_PERMISSION_MODE}`);
  log(`protecting ${snapshot.realSettingsPath} and ${snapshot.productionSessions.length} mcbd-* session(s)`);
  if (options.mutate) {
    log('MUTATION SELF-TEST: every scenario runs against a deliberately wrong expectation and must FAIL.');
  }
  if (options.mutateVerdict) {
    log(
      'VERDICT MUTATION SELF-TEST: the hook receiver answers the opposite verdict and every ' +
        'hook scenario must FAIL against its REAL expectation.'
    );
  }

  const runId = randomBytes(3).toString('hex');
  const socketName = `${CANARY_SOCKET_PREFIX}${process.pid}-${runId}`;

  let home: IsolatedHome;
  try {
    home = await createIsolatedHome({
      realHome,
      scenarioIds: selected.map(scenario => scenario.id),
      claudeVersion: preflight.claudeVersion.split(' ')[0],
      parentEnv: process.env,
      ...(process.env.CM_CANARY_MODEL ? { model: process.env.CM_CANARY_MODEL } : {}),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  log(`throwaway HOME: ${home.root}`);

  const tmux = new PrivateTmuxServer(socketName, home.env);
  const results: ScenarioResult[] = [];
  let fatalError: Error | null = null;

  // One receiver for the whole run, on a kernel-assigned loopback port: never
  // 3000, never a worktree server's port, and gone when the process exits.
  let receiver: CanaryHookReceiver | null = null;
  if (selected.some(scenario => scenario.hooks)) {
    try {
      receiver = await CanaryHookReceiver.start(log);
      log(`hook receiver: http://127.0.0.1:${receiver.port} (ephemeral, loopback only)`);
    } catch (error) {
      console.error(
        `canary: could not start the hook receiver — ${error instanceof Error ? error.message : String(error)}`
      );
      home.dispose();
      return 2;
    }
  }

  try {
    for (const scenario of selected) {
      // Re-checked per scenario so a violation is attributable. In particular
      // this runs immediately BEFORE the /model overlay, which is the operation
      // that writes the default model.
      await assertGuardSnapshotIntact(snapshot, `before scenario ${scenario.id}`);
      try {
        results.push(
          await runScenario(scenario, { tmux, home, preflight, runId, repoRoot, options, log, receiver })
        );
      } catch (error) {
        fatalError = error instanceof Error ? error : new Error(String(error));
        results.push({
          scenarioId: scenario.id,
          title: scenario.title,
          status: 'failed',
          expectationLabel: (options.mutate ? scenario.mutantExpectation : scenario.expectation).label,
          durationMs: 0,
          error: fatalError.message,
        });
        break;
      }
      await assertGuardSnapshotIntact(snapshot, `after scenario ${scenario.id}`);
    }
  } catch (error) {
    fatalError = error instanceof Error ? error : new Error(String(error));
  } finally {
    await receiver?.close();
    if (options.keep) {
      log(`\n--keep: tmux socket ${socketName} and HOME ${home.root} were left in place.`);
      log(`  inspect: tmux -L ${socketName} attach`);
      log(`  clean up: tmux -L ${socketName} kill-server && rm -rf ${home.root}`);
    } else {
      await tmux.killServer();
      // Give the killed `claude` processes a moment to exit before the HOME they
      // are still writing to is removed.
      await new Promise(resolve => setTimeout(resolve, 1_000));
      home.dispose();
      if (existsSync(home.root)) {
        console.error(`canary: could not fully remove the throwaway HOME — delete it manually: ${home.root}`);
      }
    }
  }

  for (const scenario of selected) {
    if (!results.some(result => result.scenarioId === scenario.id)) {
      results.push({
        scenarioId: scenario.id,
        title: scenario.title,
        status: 'skipped',
        expectationLabel: scenario.expectation.label,
        durationMs: 0,
        error: 'not run (aborted earlier)',
      });
    }
  }
  for (const scenario of verdictSkipped) {
    results.push({
      scenarioId: scenario.id,
      title: scenario.title,
      status: 'skipped',
      expectationLabel: scenario.expectation.label,
      durationMs: 0,
      error: 'not run (--mutate-verdict only mutates scenarios with a hook receiver)',
    });
  }

  // Final guard check runs after teardown so a leak by the teardown itself is caught.
  let guardError: Error | null = null;
  try {
    await assertGuardSnapshotIntact(snapshot, 'after teardown');
  } catch (error) {
    guardError = error instanceof Error ? error : new Error(String(error));
  }

  const totalMs = Date.now() - startedAt;
  const failed = results.filter(result => result.status === 'failed');
  const inconclusive = results.filter(
    result => result.status === 'blocked' || result.status === 'skipped'
  );
  const mutating = options.mutate || options.mutateVerdict;
  // A SKIP under `--mutate-verdict` is a scenario the self-test never touched,
  // so it must not count as evidence in either direction — only the scenarios
  // that actually ran with a flipped verdict do.
  const mutationSelfTestPassed =
    mutating && results.some(r => r.status !== 'skipped') && results.every(r => r.status !== 'passed');

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          claudeVersion: preflight.claudeVersion,
          tmuxVersion: preflight.tmuxVersion,
          mutate: options.mutate,
          mutateVerdict: options.mutateVerdict,
          durationMs: totalMs,
          guardViolation: guardError?.message ?? null,
          fatalError: fatalError?.message ?? null,
          results,
        },
        null,
        2
      )
    );
  } else {
    console.log(formatSummary(results, preflight, home, options, totalMs));
    if (guardError) console.error(`GUARD VIOLATION: ${guardError.message}`);
    if (fatalError) console.error(`ABORTED: ${fatalError.message}`);
    if (mutating) {
      const mutant = options.mutate ? 'a wrong expectation' : 'a flipped hook verdict';
      console.log(
        mutationSelfTestPassed
          ? `mutation self-test PASSED — every scenario that ran went red against ${mutant}.`
          : `mutation self-test FAILED — a scenario still passed with ${mutant} (vacuous assertion).`
      );
    } else if (failed.length > 0) {
      console.log(
        `${failed.length} of ${results.length} scenario(s) RED — a detection regression. ` +
          `The captured frames are in ${path.join('tests', 'fixtures', 'canary')}/.`
      );
    } else if (inconclusive.length > 0) {
      console.log(
        `INCONCLUSIVE: ${inconclusive.length} scenario(s) never reached their state because of an ` +
          `upstream fault or an aborted run. This is not a detection regression — re-run later.`
      );
    } else {
      console.log(`all ${results.length} scenario(s) green on claude ${preflight.claudeVersion}`);
    }
  }

  if (guardError) return 3;
  if (mutating) return mutationSelfTestPassed ? 0 : 1;
  if (failed.length > 0) return 1;
  return inconclusive.length > 0 ? 4 : 0;
}
