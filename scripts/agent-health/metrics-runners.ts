/**
 * Thin wrappers that run each measuring tool and hand its output to the pure
 * parsers in `src/lib/agent-health/metrics-parse.ts` (Issue #3044).
 *
 * A runner never throws for a tool problem: a missing binary, no network, a
 * timeout or unreadable output all become `status: 'skip'` with the reason.
 * Everything a tool writes goes to the run's temp dir (`ctx.workDir`).
 */

import { spawn } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import {
  countLines,
  countTypeSafety,
  measureComplexity,
  measureCoverage,
  measureDuplication,
  measureFileSize,
  measureGitleaks,
  measureKnip,
  measureNpmAudit,
  measureOutdated,
  measureSemgrep,
  measureTypeSafety,
  type TypeSafetyCounts,
} from '@/lib/agent-health/metrics-parse';
import { COMPLEXITY_REPORT_MIN, type MetricId, type MetricMeasurement } from '@/lib/agent-health/metrics-types';

export interface RunnerContext {
  repoRoot: string;
  /** The run's temp dir; tool reports and caches go here. */
  workDir: string;
  /** Epoch ms; no tool runs past it. */
  deadline: number;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The executable itself was not found (ENOENT). */
  missing: boolean;
}

const MIN_TOOL_MS = 5_000;
/** Process groups still running, so a signal can stop them (they are detached). */
const activeGroups = new Set<number>();

/** Stop every tool still running (SIGINT/SIGTERM of the run). */
export function killActiveCommands(): void {
  for (const pid of activeGroups) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  activeGroups.clear();
}
const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Run a command to completion (or its timeout). It gets its own process
 * group so a timeout also stops what `npx` started underneath.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    if (child.pid !== undefined) activeGroups.add(child.pid);
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 5_000).unref();
    }, options.timeoutMs);
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid !== undefined) activeGroups.delete(child.pid);
      resolve(result);
    };
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ code: null, stdout: '', stderr: error.message, timedOut: false, missing: error.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        missing: false,
      });
    });
  });
}

function tail(text: string, lines = 3): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-lines)
    .join(' / ')
    .slice(0, 300);
}

function skip(metricId: MetricId, reason: string): MetricMeasurement {
  return { metricId, status: 'skip', reason };
}

/** Run a tool within the remaining budget; the common skip reasons are decided here. */
async function runTool(
  ctx: RunnerContext,
  metricId: MetricId,
  command: string,
  args: readonly string[],
  limitMs: number,
  env: NodeJS.ProcessEnv = ctx.env
): Promise<CommandResult | MetricMeasurement> {
  const timeoutMs = Math.min(limitMs, ctx.deadline - Date.now());
  if (timeoutMs < MIN_TOOL_MS) return skip(metricId, '全体の時間上限に達したため実行しない');
  const started = Date.now();
  const result = await runCommand(command, args, { cwd: ctx.repoRoot, env, timeoutMs });
  ctx.log(`${metricId}: ${command} exit=${result.code} in ${Math.round((Date.now() - started) / 1000)}s`);
  if (result.missing) return skip(metricId, `${command} が見つからない（未インストール）`);
  if (result.timedOut) return skip(metricId, `${Math.round(timeoutMs / 1000)} 秒で打ち切った`);
  return result;
}

function isMeasurement(value: CommandResult | MetricMeasurement): value is MetricMeasurement {
  return 'metricId' in value;
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Repo-relative paths of every source file under `src/`. */
export function listSourceFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && SOURCE_EXT.test(entry.name)) files.push(path.relative(repoRoot, full));
    }
  };
  walk(path.join(repoRoot, 'src'));
  return files.sort();
}

// ── the runners ────────────────────────────────────────────────────────────

async function npmAudit(ctx: RunnerContext): Promise<MetricMeasurement> {
  // Same fetch limits as the CI step (scripts/check-npm-audit.mjs, Issue #2313).
  const result = await runTool(
    ctx,
    'npm-audit',
    'npm',
    ['audit', '--omit=dev', '--json', '--fetch-timeout=60000', '--fetch-retries=1'],
    150_000
  );
  return isMeasurement(result) ? result : measureNpmAudit(result.stdout);
}

async function semgrep(ctx: RunnerContext): Promise<MetricMeasurement> {
  const dir = path.join(ctx.workDir, 'semgrep');
  fs.mkdirSync(dir, { recursive: true });
  const result = await runTool(
    ctx,
    'semgrep',
    'semgrep',
    [
      'scan',
      '--config',
      'p/typescript',
      '--config',
      'p/nodejs',
      '--json',
      '--metrics=off',
      '--disable-version-check',
      '--quiet',
      'src',
    ],
    300_000,
    {
      ...ctx.env,
      SEMGREP_SETTINGS_FILE: path.join(dir, 'settings.yml'),
      SEMGREP_LOG_FILE: path.join(dir, 'semgrep.log'),
      SEMGREP_VERSION_CACHE_PATH: path.join(dir, 'version-cache'),
      SEMGREP_ENABLE_VERSION_CHECK: '0',
      SEMGREP_SEND_METRICS: 'off',
    }
  );
  if (isMeasurement(result)) return result;
  const measured = measureSemgrep(result.stdout);
  if (measured.status === 'skip') {
    return skip('semgrep', `semgrep が結果を返さなかった（ルールの取得にネットワークが要る）: exit ${result.code} ${tail(result.stderr)}`);
  }
  return measured;
}

async function secrets(ctx: RunnerContext): Promise<MetricMeasurement> {
  const report = path.join(ctx.workDir, 'gitleaks.json');
  const result = await runTool(
    ctx,
    'secrets',
    'gitleaks',
    [
      'detect',
      '--source',
      ctx.repoRoot,
      '--report-format',
      'json',
      '--report-path',
      report,
      '--redact',
      '--no-banner',
      '--exit-code',
      '0',
    ],
    240_000
  );
  if (isMeasurement(result)) return result;
  const text = readIfPresent(report);
  if (result.code !== 0 || text === null) {
    return skip('secrets', `gitleaks が失敗した: exit ${result.code} ${tail(result.stderr)}`);
  }
  return measureGitleaks(text);
}

function fileSize(ctx: RunnerContext): MetricMeasurement {
  const lines: Record<string, number> = {};
  for (const file of listSourceFiles(ctx.repoRoot)) {
    lines[file] = countLines(fs.readFileSync(path.join(ctx.repoRoot, file), 'utf8'));
  }
  return measureFileSize(lines);
}

async function complexity(ctx: RunnerContext): Promise<MetricMeasurement> {
  const requireFromRepo = createRequire(path.join(ctx.repoRoot, 'package.json'));
  let parser: string;
  try {
    parser = requireFromRepo.resolve('@typescript-eslint/parser');
  } catch {
    return skip('complexity', '@typescript-eslint/parser が見つからない（npm install が済んでいない）');
  }
  // Report-only: the repo's own config is not used, only `complexity` is on.
  const config = path.join(ctx.workDir, 'eslint-complexity.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      root: true,
      parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
      rules: { complexity: ['warn', COMPLEXITY_REPORT_MIN] },
    })
  );
  const eslint = path.join(ctx.repoRoot, 'node_modules', '.bin', 'eslint');
  const result = await runTool(
    ctx,
    'complexity',
    eslint,
    ['--no-eslintrc', '-c', config, '--no-inline-config', '--ext', '.ts,.tsx', '--format', 'json', 'src'],
    240_000
  );
  if (isMeasurement(result)) return result;
  const measured = measureComplexity(result.stdout, ctx.repoRoot);
  return measured.status === 'skip'
    ? skip('complexity', `ESLint が失敗した: exit ${result.code} ${tail(result.stderr)}`)
    : measured;
}

async function duplication(ctx: RunnerContext): Promise<MetricMeasurement> {
  const out = path.join(ctx.workDir, 'jscpd');
  const result = await runTool(
    ctx,
    'duplication',
    'npx',
    ['--yes', 'jscpd@4', 'src', '--reporters', 'json', '--output', out, '--silent', '--gitignore', '--min-lines', '10'],
    180_000
  );
  if (isMeasurement(result)) return result;
  const text = readIfPresent(path.join(out, 'jscpd-report.json'));
  if (text === null) return skip('duplication', `jscpd がレポートを書かなかった: exit ${result.code} ${tail(result.stderr)}`);
  return measureDuplication(text);
}

async function unused(ctx: RunnerContext): Promise<MetricMeasurement> {
  const result = await runTool(
    ctx,
    'unused',
    'npx',
    ['--yes', 'knip@5', '--reporter', 'json', '--no-progress', '--no-exit-code'],
    240_000
  );
  if (isMeasurement(result)) return result;
  const measured = measureKnip(result.stdout);
  return measured.status === 'skip'
    ? skip('unused', `knip が失敗した: exit ${result.code} ${tail(result.stderr)}`)
    : measured;
}

async function outdated(ctx: RunnerContext): Promise<MetricMeasurement> {
  const result = await runTool(ctx, 'outdated', 'npm', ['outdated', '--json'], 120_000);
  if (isMeasurement(result)) return result;
  const pkg = JSON.parse(fs.readFileSync(path.join(ctx.repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const direct = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  // npm outdated exits 1 when something is outdated; only the JSON decides.
  return measureOutdated(result.stdout, direct);
}

function typeSafety(ctx: RunnerContext): MetricMeasurement {
  const total: TypeSafetyCounts = { any: 0, eslintDisable: 0, tsIgnore: 0 };
  for (const file of listSourceFiles(ctx.repoRoot)) {
    const counts = countTypeSafety(fs.readFileSync(path.join(ctx.repoRoot, file), 'utf8'));
    total.any += counts.any;
    total.eslintDisable += counts.eslintDisable;
    total.tsIgnore += counts.tsIgnore;
  }
  return measureTypeSafety(total);
}

async function coverage(ctx: RunnerContext): Promise<MetricMeasurement> {
  const dir = path.join(ctx.workDir, 'coverage');
  const vitest = path.join(ctx.repoRoot, 'node_modules', '.bin', 'vitest');
  const result = await runTool(
    ctx,
    'coverage',
    vitest,
    [
      'run',
      'tests/unit',
      '--coverage.enabled=true',
      '--coverage.reporter=json-summary',
      `--coverage.reportsDirectory=${dir}`,
    ],
    // The whole run budget: coverage starts first and runs alongside the rest.
    ctx.deadline - Date.now()
  );
  if (isMeasurement(result)) return result;
  const text = readIfPresent(path.join(dir, 'coverage-summary.json'));
  if (text === null) return skip('coverage', `coverage-summary.json が書かれなかった: exit ${result.code} ${tail(result.stderr)}`);
  return measureCoverage(text);
}

export const METRIC_RUNNERS: Record<MetricId, (ctx: RunnerContext) => Promise<MetricMeasurement> | MetricMeasurement> = {
  'npm-audit': npmAudit,
  semgrep,
  secrets,
  'file-size': fileSize,
  complexity,
  duplication,
  unused,
  outdated,
  'type-safety': typeSafety,
  coverage,
};

/**
 * Longest first, so the pool starts the slow tools early. With
 * {@link MEASURE_CONCURRENCY} workers the whole set fits the 10-minute budget.
 */
export const RUN_ORDER: readonly MetricId[] = [
  'coverage',
  'semgrep',
  'unused',
  'complexity',
  'secrets',
  'duplication',
  'npm-audit',
  'outdated',
  'file-size',
  'type-safety',
];

export const MEASURE_CONCURRENCY = 3;

/** Run the selected metrics through a small worker pool; a runner that throws becomes a skip. */
export async function measureAll(ctx: RunnerContext, selected: readonly MetricId[]): Promise<MetricMeasurement[]> {
  const queue = RUN_ORDER.filter((id) => selected.includes(id));
  const results: MetricMeasurement[] = [];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        results.push(await METRIC_RUNNERS[id](ctx));
      } catch (error) {
        results.push(skip(id, `計測中の例外: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  };
  await Promise.all(Array.from({ length: MEASURE_CONCURRENCY }, worker));
  return results;
}
