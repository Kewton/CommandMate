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

import { formatHelp, parseArgs, type CanaryOptions } from './cli';
import { writeFixtureArtifacts } from './fixtures';
import { findUpstreamFault } from './expectations';
import { assertGuardSnapshotIntact, captureGuardSnapshot, type GuardSnapshot } from './guards';
import { createIsolatedHome, type IsolatedHome } from './isolated-home';
import { summarizeObservation } from './probe';
import { SCENARIOS, selectScenarios } from './scenarios';
import { CanarySession } from './session';
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
}

async function runScenario(scenario: CanaryScenario, deps: RunScenarioDeps): Promise<ScenarioResult> {
  const { tmux, home, preflight, runId, repoRoot, options, log } = deps;
  const expectation = options.mutate ? scenario.mutantExpectation : scenario.expectation;
  const timeoutMs = options.mutate ? Math.min(scenario.timeoutMs, 30_000) : scenario.timeoutMs;
  const startedAt = Date.now();
  const sessionName = `${CANARY_SOCKET_PREFIX}${scenario.id}-${runId}`;

  log(`\n▶ ${scenario.id} — ${scenario.title}`);
  log(`  expect: ${expectation.label}`);

  const session = await CanarySession.start({
    tmux,
    sessionName,
    workingDirectory: home.workingDirectoryFor(scenario.id),
    isolatedHome: home.root,
    claudeBinary: preflight.claudeBinary,
    log,
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
  lines.push(options.mutate ? 'MUTATION SELF-TEST SUMMARY' : 'DETECTION CANARY SUMMARY');
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

  log(`claude ${preflight.claudeVersion} · ${preflight.tmuxVersion}`);
  log(`protecting ${snapshot.realSettingsPath} and ${snapshot.productionSessions.length} mcbd-* session(s)`);
  if (options.mutate) {
    log('MUTATION SELF-TEST: every scenario runs against a deliberately wrong expectation and must FAIL.');
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

  try {
    for (const scenario of selected) {
      // Re-checked per scenario so a violation is attributable. In particular
      // this runs immediately BEFORE the /model overlay, which is the operation
      // that writes the default model.
      await assertGuardSnapshotIntact(snapshot, `before scenario ${scenario.id}`);
      try {
        results.push(
          await runScenario(scenario, { tmux, home, preflight, runId, repoRoot, options, log })
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
  const mutationSelfTestPassed = options.mutate && results.every(result => result.status !== 'passed');

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          claudeVersion: preflight.claudeVersion,
          tmuxVersion: preflight.tmuxVersion,
          mutate: options.mutate,
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
    if (options.mutate) {
      console.log(
        mutationSelfTestPassed
          ? 'mutation self-test PASSED — every scenario went red against a wrong expectation.'
          : 'mutation self-test FAILED — a scenario still passed with a wrong expectation (vacuous assertion).'
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
  if (options.mutate) return mutationSelfTestPassed ? 0 : 1;
  if (failed.length > 0) return 1;
  return inconclusive.length > 0 ? 4 : 0;
}
