/**
 * agent-health: the daily, AI-free check that each agent CLI still works with
 * CommandMate (Issue #2878). Entry point is `run.ts`; this is the run.
 *
 * Order of a run:
 *   1. parse arguments, take the run lock, start the hook listener
 *   2. per tool: `--version` → snapshot machine-singleton files →
 *      `prepareLaunch` → private tmux session → screens and turns → kill →
 *      restore the snapshots (sha256-proved) → scan the production log
 *   3. tear down tmux, the listener and the temp dirs (also on error/signal)
 *   4. write the report, then the state file
 *
 * Invariants (docs/user-guide/agent-health.md): tmux only through
 * `-L cm-agent-health` with `TMUX` removed; work dirs are fresh temp repos;
 * machine-singleton hook files come back byte for byte or the run exits 2;
 * hooks go to the listener, never to production.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseAgentHealthArgs,
  RUN_BUDGET_SEC,
  syncRecordFor,
  type AgentHealthOptions,
} from '@/lib/agent-health/cli-args';
import {
  restoreSnapshot,
  restoreTrustState,
  snapshotFile,
  type FileSnapshot,
} from '@/lib/agent-health/config-guard';
import {
  buildToolResult,
  decideExitCode,
  nextState,
  parseState,
  previousVersionOf,
  reportDateJst,
  type AgentHealthExitCode,
} from '@/lib/agent-health/report';
import { AGENT_HEALTH_TMUX_SOCKET, buildChildEnv } from '@/lib/agent-health/tmux-command';
import {
  PROBE_WORKTREE_ID,
  type AgentHealthCheck,
  type AgentHealthReport,
  type AgentHealthToolResult,
  type GlobalConfigRestoreEntry,
} from '@/lib/agent-health/types';
import { HookListener } from './hook-listener';
import { locateServerLog, ServerLogWatch } from './production-log';
import { probeTool, readVersion } from './probe-tool';
import { AgentHealthTmux } from './tmux-driver';
import { TOOL_PROBE_SPECS } from './tool-table';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DIR = path.join(os.homedir(), '.commandmate', 'agent-health');
/** Kept back from the run budget for teardown and writing the report. */
const TEARDOWN_RESERVE_MS = 60_000;
/** Prefix of every temp dir the run creates — the marker for trust-state restores. */
const WORK_PREFIX = 'cm-agent-health-';

function log(message: string): void {
  process.stderr.write(`[agent-health] ${message}\n`);
}

function commandmateCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function readTextIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(staging, file);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One run at a time: the tmux socket label and the listener's hook config are shared. */
function acquireLock(lockPath: string): string | null {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const holder = Number.parseInt(readTextIfPresent(lockPath) ?? '', 10);
  if (Number.isInteger(holder) && holder !== process.pid && isAlive(holder)) {
    return `別の agent-health 実行（pid ${holder}）が進行中（${lockPath}）`;
  }
  fs.writeFileSync(lockPath, String(process.pid));
  return null;
}

function emptyReport(startedAt: Date, errors: string[], syncedFrom: string | null = null): AgentHealthReport {
  const commit = commandmateCommit();
  const sync = syncRecordFor(syncedFrom, commit);
  return {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    host: { commandmateCommit: commit, node: process.version },
    tools: [],
    safety: { globalConfigRestored: [], tmuxSocket: AGENT_HEALTH_TMUX_SOCKET },
    scriptErrors: errors,
    ...(sync ? { sync } : {}),
  };
}

function writeReportOrPrint(file: string, report: AgentHealthReport): boolean {
  try {
    writeJson(file, report);
    log(`report: ${file}`);
    return true;
  } catch (error) {
    log(`could not write the report to ${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return false;
  }
}

/**
 * Point this process's own launch-line builders at the listener. The
 * `prepareLaunch` implementations read `CM_PORT` (the hook URL's port) and
 * `CM_AGENT_HOOKS_DIR` (where claude's `--settings` file goes); the rest is
 * removed so nothing inherited from the shell leaks into a launch line.
 */
function redirectLaunchEnvironment(port: number, hooksDir: string): void {
  for (const name of [
    'CM_HOOK_URL',
    'CM_PERMISSION_HOOK_URL',
    'CM_AUTH_TOKEN',
    'CM_AUTH_TOKEN_HASH',
    'CM_AGENT_HOOKS_INJECT',
    'CM_AGENT_WORKTREE_ID',
    'CM_AGENT_INSTANCE_ID',
    'CM_AGENT_TOOL',
    'MCBD_PORT',
  ]) {
    delete process.env[name];
  }
  process.env.CM_PORT = String(port);
  process.env.CM_AGENT_HOOKS_DIR = hooksDir;
}

export async function main(argv: readonly string[]): Promise<AgentHealthExitCode> {
  const startedAt = new Date();
  const parsed = parseAgentHealthArgs(argv);
  if (!parsed.ok && parsed.help) {
    process.stdout.write(`${parsed.error}\n`);
    return 0;
  }
  if (!parsed.ok) {
    log(parsed.error);
    const report = emptyReport(startedAt, [`引数の誤り: ${parsed.error}`]);
    writeReportOrPrint(path.join(DEFAULT_DIR, 'reports', `${reportDateJst(startedAt)}.json`), report);
    return 2;
  }
  const options = parsed.options;
  return run(options, startedAt);
}

async function run(options: AgentHealthOptions, startedAt: Date): Promise<AgentHealthExitCode> {
  const outPath = path.resolve(options.out ?? path.join(DEFAULT_DIR, 'reports', `${reportDateJst(startedAt)}.json`));
  const statePath = path.resolve(options.statePath ?? path.join(DEFAULT_DIR, 'state.json'));
  const lockPath = path.join(path.dirname(statePath), 'run.lock');
  const scriptErrors: string[] = [];
  const restoreEntries: GlobalConfigRestoreEntry[] = [];
  const results: AgentHealthToolResult[] = [];
  const globalDeadline = startedAt.getTime() + RUN_BUDGET_SEC * 1000 - TEARDOWN_RESERVE_MS;

  const lockError = acquireLock(lockPath);
  if (lockError) {
    log(lockError);
    writeReportOrPrint(outPath, emptyReport(startedAt, [lockError], options.syncedFrom));
    return 2;
  }

  // `resolveRelayScriptPath()` is cwd-relative (scripts/hooks/cmate-agent-event.sh).
  process.chdir(REPO_ROOT);
  const workRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), WORK_PREFIX));
  const hooksDir = path.join(workRoot, 'hooks');
  fs.mkdirSync(hooksDir, { mode: 0o700 });

  let listener: HookListener | null = null;
  let tmux: AgentHealthTmux | null = null;
  const pendingSnapshots: Array<{ snapshot: FileSnapshot; kind: 'hook-config' | 'trust-state' }> = [];

  const restorePending = () => {
    while (pendingSnapshots.length > 0) {
      const { snapshot, kind } = pendingSnapshots.shift()!;
      const entry =
        kind === 'hook-config' ? restoreSnapshot(snapshot) : restoreTrustState(snapshot, WORK_PREFIX);
      restoreEntries.push(entry);
      log(`restore ${entry.path}: ${entry.restored ? 'ok' : `NOT restored (${entry.detail ?? ''})`}`);
    }
  };

  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = true;
    log(`${signal} received — cleaning up`);
    scriptErrors.push(`${signal} で中断された`);
    void (async () => {
      restorePending();
      await tmux?.teardown();
      await listener?.close().catch(() => undefined);
      fs.rmSync(workRoot, { recursive: true, force: true });
      fs.rmSync(lockPath, { force: true });
      process.exit(2);
    })();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const serverLogPath = locateServerLog(REPO_ROOT, options.serverLog);
  const serverLog = new ServerLogWatch(serverLogPath);
  const linesAtStart = serverLog.lineCount();
  let probeLines = 0;
  if (!serverLogPath) log('production server log not found — the leak scan is off');

  const state = parseState(readTextIfPresent(statePath));

  try {
    listener = await HookListener.start();
    redirectLaunchEnvironment(listener.port, hooksDir);
    const childEnv = buildChildEnv(process.env, {
      CM_PORT: String(listener.port),
      // Safety net only: every launch line sets its own URL. A hook that
      // falls back to this one arrives without correlation keys and fails
      // the check — it never reaches production.
      CM_HOOK_URL: listener.agentEventUrl,
    });
    tmux = new AgentHealthTmux(childEnv, workRoot);
    if (await tmux.isServerRunning()) {
      // The lock says no run is live, so this is a crashed run's leftover.
      log(`stale private tmux server on -L ${AGENT_HEALTH_TMUX_SOCKET} — tearing it down`);
      await tmux.teardown();
    }
    log(`listener on 127.0.0.1:${listener.port}; work dir ${workRoot}`);

    for (const tool of options.tools) {
      const spec = TOOL_PROBE_SPECS[tool];
      const previousVersion = previousVersionOf(state, tool);
      const selected = (checkId: AgentHealthCheck['checkId']) => options.checks.includes(checkId);

      if (Date.now() >= globalDeadline) {
        const { version } = await readVersion(spec.executable, childEnv);
        const skipped: AgentHealthCheck[] = options.checks
          .filter((checkId) => checkId !== 'version')
          .map((checkId) => ({
            checkId,
            status: 'skip',
            summary: `全体の時間上限（${RUN_BUDGET_SEC / 60} 分）に達したため実行しない`,
            skipReason: 'run budget exhausted',
          }));
        results.push(
          buildToolResult({
            tool,
            version,
            previousVersion,
            checks: [
              version === null
                ? { checkId: 'version', status: 'fail', summary: `\`${spec.executable} --version\` が取得できなかった` }
                : { checkId: 'version', status: 'pass', summary: `\`${spec.executable} --version\` → ${version}` },
              ...skipped,
            ],
          })
        );
        continue;
      }

      log(`── ${tool}`);
      const guarded = spec.guardedFiles();
      for (const file of guarded.hookConfig) pendingSnapshots.push({ snapshot: snapshotFile(file), kind: 'hook-config' });
      for (const file of guarded.trustState) pendingSnapshots.push({ snapshot: snapshotFile(file), kind: 'trust-state' });
      serverLog.takeLinesContaining(PROBE_WORKTREE_ID);

      let outcome: { version: string | null; checks: AgentHealthCheck[] };
      try {
        outcome = await probeTool({
          spec,
          tmux,
          listener,
          childEnv,
          workRoot,
          selected,
          deadline: Math.min(Date.now() + options.timeoutPerToolSec * 1000, globalDeadline),
          log,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`${tool}: ${message}`);
        outcome = {
          version: null,
          checks: [
            {
              checkId: 'version',
              status: 'fail',
              summary: `確認の準備で異常終了: ${message}`,
            },
          ],
        };
      } finally {
        restorePending();
      }

      const leaked = serverLog.takeLinesContaining(PROBE_WORKTREE_ID);
      probeLines += leaked.length;
      if (leaked.length > 0) {
        const others = outcome.checks.filter((check) => check.checkId !== 'hook-correlation');
        outcome.checks = [
          ...others,
          {
            checkId: 'hook-correlation',
            status: 'fail',
            summary: `期待: probe の hook が本番サーバに届かない。実際: 本番ログに ${PROBE_WORKTREE_ID} を含む行が ${leaked.length} 行増えた`,
            evidence: leaked.join('\n'),
          },
        ];
      }

      results.push(buildToolResult({ tool, version: outcome.version, previousVersion, checks: outcome.checks }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    log(`run aborted: ${message}`);
    scriptErrors.push(message);
  } finally {
    restorePending();
    await tmux?.teardown();
    await listener?.close().catch(() => undefined);
    fs.rmSync(workRoot, { recursive: true, force: true });
  }

  // Late arrivals after teardown still count.
  const lateLeak = serverLog.takeLinesContaining(PROBE_WORKTREE_ID);
  probeLines += lateLeak.length;
  if (lateLeak.length > 0) {
    scriptErrors.push(`後始末の後に本番ログへ ${PROBE_WORKTREE_ID} を含む行が ${lateLeak.length} 行増えた`);
  }

  const commit = commandmateCommit();
  const sync = syncRecordFor(options.syncedFrom, commit);
  const report: AgentHealthReport = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    host: { commandmateCommit: commit, node: process.version },
    tools: results,
    safety: {
      globalConfigRestored: restoreEntries,
      tmuxSocket: AGENT_HEALTH_TMUX_SOCKET,
      productionLog: {
        path: serverLogPath,
        linesAtStart,
        linesAtEnd: serverLog.lineCount(),
        probeLines,
      },
    },
    ...(scriptErrors.length > 0 ? { scriptErrors } : {}),
    ...(sync ? { sync } : {}),
  };

  if (!writeReportOrPrint(outPath, report)) scriptErrors.push(`レポートを書けなかった: ${outPath}`);
  try {
    writeJson(statePath, nextState(state, results));
  } catch (error) {
    scriptErrors.push(`state を書けなかった: ${error instanceof Error ? error.message : String(error)}`);
  }
  fs.rmSync(lockPath, { force: true });

  const exitCode = scriptErrors.length > 0 ? 2 : decideExitCode(report);
  for (const result of results) {
    const line = result.checks.map((check) => `${check.checkId}=${check.status}`).join(' ');
    log(`${result.tool} ${result.version ?? '(no version)'}${result.versionChanged ? ` (was ${result.previousVersion})` : ''}: ${line}`);
  }
  log(`exit ${exitCode}`);
  return exitCode;
}
