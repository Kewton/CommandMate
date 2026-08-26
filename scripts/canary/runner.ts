/**
 * Orchestrator for `npm run canary` (Issue #1727; per-tool since #2050).
 *
 * Run shape:
 *   preflight (incl. version drift) → guard snapshot → throwaway HOME
 *   → private tmux server → one fresh session per scenario
 *   (drive → poll → assert → fixture) → teardown → re-check the guards → summary
 *
 * The guards are re-checked between scenarios, not just at the end, so a
 * violation names the scenario that caused it.
 *
 * ## The version drift the preflight reports (Issue #2050)
 *
 * The one `<tool> --version` the preflight already runs is also the staleness
 * probe: its output goes through the SAME `parseCliVersion` that
 * `src/lib/detection/version-probes.ts` uses, and is compared against the SAME
 * `DETECTOR_VERIFIED_AGAINST` stamp `commandmate status` and
 * `check:detector-freshness` read. So a canary result is never reported without
 * saying which build produced it and whether the rules were read off that build.
 *
 * This is what makes a red run actionable. "opencode-permission FAILED" alone
 * cannot distinguish a detection regression from "you upgraded opencode
 * yesterday"; "opencode-permission FAILED, installed 1.18.30, rules read off
 * 1.18.22" answers it in the same breath. It is advisory by default and
 * `--strict-version` makes it fail — see that flag's docblock for why not the
 * other way round.
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
import {
  compareCliVersions,
  parseCliVersion,
  parseVerifiedAgainstVersion,
} from '@/lib/detection/version-probes';
import { DETECTOR_VERIFIED_AGAINST } from '@/lib/detection/tools/verified-against';
import { formatHelp, parseArgs, type CanaryOptions } from './cli';
import { writeFixtureArtifacts } from './fixtures';
import { findUpstreamFault } from './expectations';
import { assertGuardSnapshotIntact, captureGuardSnapshot, type GuardSnapshot } from './guards';
import { CanaryHookReceiver, CANARY_INSTANCE_ID } from './hook-receiver';
import { createIsolatedHome, type IsolatedHome } from './isolated-home';
import { CANARY_CLI_TOOL, summarizeObservation } from './probe';
import { SCENARIOS, selectScenarios } from './scenarios';
import { CanarySession } from './session';
import { resolveToolProfile, type CanaryToolProfile } from './tool-profiles';
import { CANARY_SOCKET_PREFIX, PrivateTmuxServer } from './tmux-private';
import { ObservationTimeoutError, type CanaryScenario, type ScenarioResult } from './types';

const execFileAsync = promisify(execFile);

/** Minimum tmux that supports `new-session -e VAR=value`. */
const MIN_TMUX_VERSION = '3.2';

/**
 * Exit code for `--strict-version` when the installed CLI is newer than the
 * build the rules were read off (Issue #2050).
 *
 * A new code rather than 1: 1 means "a detection regression, go read the
 * captured frames" and this means "nothing was measured against this build yet".
 * Conflating them would make the one exit code a caller can act on ambiguous.
 */
export const CANARY_EXIT_VERSION_DRIFT = 5;

/**
 * How the installed build compares with the build the detector rules were read
 * off (Issue #2050).
 *
 * `unmeasured` and `unreadable` are deliberately NOT `fresh`: "nobody ever
 * captured frames for this tool" and "the rules match the install" are different
 * answers and must not print the same — the same distinction
 * `getDetectorFreshness` draws.
 */
export type VersionDriftState = 'fresh' | 'stale' | 'rules-ahead' | 'unmeasured' | 'unreadable';

export interface VersionDrift {
  /** `major.minor.patch` read out of `<tool> --version`, or null. */
  installed: string | null;
  /** The tool's `verifiedAgainst.version` stamp. */
  verifiedAgainst: string;
  /** The tool's `verifiedAgainst.paneGeometry` stamp. */
  verifiedGeometry: string;
  /** The geometry this run actually captured at, `<width>x<height>`. */
  runGeometry: string;
  state: VersionDriftState;
}

/**
 * Compare an installed version with a `verifiedAgainst` stamp.
 *
 * Pure and exported so `tests/unit/canary/canary-opencode-2050.test.ts` can pin
 * the five outcomes without running a CLI.
 */
export function classifyVersionDrift(
  versionOutput: string,
  stamp: { version: string; paneGeometry: string },
  runGeometry: string
): VersionDrift {
  const installed = parseCliVersion(versionOutput);
  const baseline = parseVerifiedAgainstVersion(stamp.version);
  const base = {
    installed,
    verifiedAgainst: stamp.version,
    verifiedGeometry: stamp.paneGeometry,
    runGeometry,
  };
  if (baseline === null) return { ...base, state: 'unmeasured' };
  if (installed === null) return { ...base, state: 'unreadable' };
  const comparison = compareCliVersions(installed, baseline);
  if (comparison > 0) return { ...base, state: 'stale' };
  if (comparison < 0) return { ...base, state: 'rules-ahead' };
  return { ...base, state: 'fresh' };
}

/** One line describing the drift, for the run header and the summary. */
export function formatVersionDrift(tool: string, drift: VersionDrift): string {
  const geometry =
    drift.runGeometry === drift.verifiedGeometry
      ? drift.runGeometry
      : `${drift.runGeometry} (stamp says ${drift.verifiedGeometry})`;
  switch (drift.state) {
    case 'stale':
      return `VERSION DRIFT: ${tool} ${drift.installed} is installed, rules read off ${drift.verifiedAgainst} @ ${geometry} — re-capture fixtures and update tools/verified-against.ts`;
    case 'rules-ahead':
      return `VERSION DRIFT: rules were read off ${tool} ${drift.verifiedAgainst}, but ${drift.installed} is installed (older) @ ${geometry}`;
    case 'unmeasured':
      return `${tool}: no frames have ever been captured for this tool (verifiedAgainst=${drift.verifiedAgainst})`;
    case 'unreadable':
      return `${tool}: could not read a version out of --version; rules read off ${drift.verifiedAgainst} @ ${geometry}`;
    default:
      return `${tool} ${drift.installed} · rules read off ${drift.verifiedAgainst} @ ${geometry}`;
  }
}

interface Preflight {
  /** Absolute path of the tool's executable. */
  toolBinary: string;
  /** Raw `--version` output, recorded in the fixture headers. */
  toolVersion: string;
  tmuxVersion: string;
  drift: VersionDrift;
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

async function runPreflight(profile: CanaryToolProfile): Promise<Preflight> {
  const missing = `canary: \`${profile.executable}\` is not on PATH — install ${profile.label} first`;
  let toolBinary: string;
  try {
    const { stdout } = await execFileAsync('command', ['-v', profile.executable], { shell: '/bin/sh' });
    toolBinary = stdout.trim().split('\n')[0];
  } catch {
    throw new Error(missing);
  }
  if (!toolBinary) {
    throw new Error(missing);
  }

  const { stdout: versionOut } = await execFileAsync(toolBinary, ['--version'], { timeout: 30_000 });
  const toolVersion = versionOut.trim();
  const drift = classifyVersionDrift(
    toolVersion,
    DETECTOR_VERIFIED_AGAINST[profile.id] ?? { version: 'unmeasured', paneGeometry: 'unmeasured' },
    `${profile.paneWidth}x${profile.paneHeight}`
  );

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

  return { toolBinary, toolVersion, tmuxVersion, drift };
}

interface RunScenarioDeps {
  tmux: PrivateTmuxServer;
  profile: CanaryToolProfile;
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
  if (scenario.tool !== CANARY_CLI_TOOL) {
    // Guarded rather than assumed: `buildClaudeLaunchCommand` and
    // `resolvePermissionRequest` are claude's, and pointing another tool's
    // session at them would produce a session with no hooks and a scenario that
    // asserts nothing (Issue #2050).
    throw new Error(
      `canary: hook scenarios are ${CANARY_CLI_TOOL}-only; ${scenario.id} declares tool=${scenario.tool}`
    );
  }
  if (!isHookInjectionEnabled()) {
    throw new Error(
      'canary: CM_AGENT_HOOKS_INJECT=0 disables hook injection, so the Auto-Yes v2 scenarios ' +
        'would silently run a session with no hooks at all. Unset it and re-run.'
    );
  }

  const worktreeId = hookWorktreeIdFor(scenario);
  const launchCommand = buildClaudeLaunchCommand(
    preflight.toolBinary,
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
  if (launchCommand === preflight.toolBinary) {
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
  const { tmux, profile, home, preflight, runId, repoRoot, options, log } = deps;
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
    profile,
    sessionName,
    workingDirectory: home.workingDirectoryFor(scenario.id),
    isolatedHome: home.root,
    toolBinary: preflight.toolBinary,
    log,
    // Every scenario, hooks or not: see the profile's buildLaunchCommand (for
    // claude that appends --permission-mode manual; opencode takes no flags).
    launchCommand: profile.buildLaunchCommand(
      hookSession?.launchCommand ?? shellQuote(preflight.toolBinary)
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
          toolLabel: profile.label,
          toolVersion: preflight.toolVersion,
          paneGeometry: `${profile.paneWidth}x${profile.paneHeight}`,
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
            toolLabel: profile.label,
            toolVersion: preflight.toolVersion,
            paneGeometry: `${profile.paneWidth}x${profile.paneHeight}`,
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

function describeAuthSource(home: IsolatedHome): string {
  const source = home.authSource;
  if (source.kind === 'env') return `env ${source.variable}`;
  if (source.kind === 'keychain') return `keychain "${source.service}"`;
  return `file ${source.path}`;
}

function formatSummary(
  results: readonly ScenarioResult[],
  profile: CanaryToolProfile,
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
  lines.push(`tool      : ${profile.label} ${preflight.toolVersion}`);
  lines.push(`geometry  : ${profile.paneWidth}x${profile.paneHeight} (capture ${profile.captureLines} rows)`);
  lines.push(`rules     : ${formatVersionDrift(profile.id, preflight.drift)}`);
  lines.push(`tmux      : ${preflight.tmuxVersion}`);
  lines.push(`auth      : ${describeAuthSource(home)}`);
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
    // Every tool's scenarios, not just `--tool`'s: `--list` is the discovery
    // surface, and hiding the other tool's ids behind a flag the reader has not
    // typed yet is how they stay undiscovered (Issue #2050).
    for (const scenario of SCENARIOS) {
      console.log(
        `${scenario.id}  [${scenario.tool}]\n  ${scenario.title}\n  cost: ${scenario.cost}  timeout: ${scenario.timeoutMs / 1000}s`
      );
      console.log(`  ${scenario.intent}`);
      console.log(`  expects: ${scenario.expectation.label}\n`);
    }
    return 0;
  }

  let profile: CanaryToolProfile;
  try {
    profile = resolveToolProfile(options.tool);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const log = (message: string): void => {
    if (!options.json) console.log(message);
  };

  let selected: CanaryScenario[];
  try {
    selected = selectScenarios(options.only, options.skip, options.tool);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (selected.length === 0) {
    console.error(`canary: no scenarios selected for --tool ${options.tool}`);
    return 2;
  }
  if (options.mutateVerdict && !profile.supportsHookScenarios) {
    console.error(
      `canary: --mutate-verdict has nothing to mutate for --tool ${options.tool} — ` +
        `only ${CANARY_CLI_TOOL} has a PermissionRequest hook for the receiver to answer.`
    );
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
    preflight = await runPreflight(profile);
    snapshot = await captureGuardSnapshot(realHome);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  log(
    `${profile.label} ${preflight.toolVersion} · ${preflight.tmuxVersion} · pane ${profile.paneWidth}x${profile.paneHeight}`
  );
  log(formatVersionDrift(profile.id, preflight.drift));
  log(
    `protecting ${snapshot.guardedFiles.length} real config file(s) and ${snapshot.productionSessions.length} mcbd-* session(s)`
  );
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
    // `CM_CANARY_MODEL` is claude's cost lever; `CM_CANARY_OPENCODE_MODEL`
    // names the provider/model the copied `auth.json` can serve (Issue #2050).
    const model =
      profile.id === 'opencode' ? process.env.CM_CANARY_OPENCODE_MODEL : process.env.CM_CANARY_MODEL;
    home = await createIsolatedHome({
      realHome,
      tool: profile.id,
      scenarioIds: selected.map(scenario => scenario.id),
      claudeVersion: preflight.toolVersion.split(' ')[0],
      parentEnv: process.env,
      ...(model ? { model } : {}),
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
          await runScenario(scenario, {
            tmux,
            profile,
            home,
            preflight,
            runId,
            repoRoot,
            options,
            log,
            receiver,
          })
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
      // Give the killed CLI processes a moment to exit before the HOME they
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
          tool: profile.id,
          toolVersion: preflight.toolVersion,
          paneGeometry: `${profile.paneWidth}x${profile.paneHeight}`,
          versionDrift: preflight.drift,
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
    console.log(formatSummary(results, profile, preflight, home, options, totalMs));
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
      // Said HERE, next to the red, rather than only in the header 30 lines up:
      // a drift is the first thing to rule out before opening a regression Issue.
      if (preflight.drift.state === 'stale') {
        console.log(
          `  ...but note the drift above: ${profile.id} ${preflight.drift.installed} is installed and ` +
            `the rules were read off ${preflight.drift.verifiedAgainst}. Re-capture before filing a regression.`
        );
      }
    } else if (inconclusive.length > 0) {
      console.log(
        `INCONCLUSIVE: ${inconclusive.length} scenario(s) never reached their state because of an ` +
          `upstream fault or an aborted run. This is not a detection regression — re-run later.`
      );
    } else {
      console.log(
        `all ${results.length} scenario(s) green on ${profile.label} ${preflight.toolVersion}`
      );
    }
    if (options.strictVersion && preflight.drift.state === 'stale') {
      console.error(`--strict-version: ${formatVersionDrift(profile.id, preflight.drift)}`);
    }
  }

  if (guardError) return 3;
  if (mutating) return mutationSelfTestPassed ? 0 : 1;
  if (failed.length > 0) return 1;
  // Ranked below a detection regression on purpose: a drift is a reason to
  // re-capture, a red scenario is a reason to fix the detector (Issue #2050).
  if (options.strictVersion && preflight.drift.state === 'stale') return CANARY_EXIT_VERSION_DRIFT;
  return inconclusive.length > 0 ? 4 : 0;
}
