/**
 * The release-readiness report run (Issue #3046). Entry point is
 * `release-report.ts`.
 *
 * The script only collects facts — gh (CI, PRs, Issues), git (tag, commits,
 * changelog fragments), the dispatch record (#3045), the metrics (#3044), the
 * agent-health reports and the orchestrate run files — and hands them to the
 * pure rules in `src/lib/agent-health/release-readiness.ts`. Every source is
 * optional: what cannot be read is shown as "取得できず" and the HTML is still
 * written, so running it by hand after a stopped orchestrate shows the state
 * as it is now.
 *
 * Reads only. The one file written is the HTML (`--out`).
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dispatchRecordPath, parseDispatchRecord } from '@/lib/agent-health/dispatch-record';
import {
  compareMetrics,
  countHighAdvisories,
  decideReadiness,
  extractAgentHealthKey,
  findPullRequestForIssue,
  jstDateOf,
  latestDateBefore,
  mergedOnDate,
  metricValue,
  NPM_AUDIT_METRIC_ID,
  parseHealthReportDigest,
  parseMetricsFile,
  parsePullRequests,
  parseReleaseReportArgs,
  parseTasksTsv,
  parseVerifyExit,
  pickWaitLog,
  selectRunFiles,
  reproducesFailAfter,
  analyzeCheckRollup,
  summarizeCheckRollup,
  summarizeWorkflowRuns,
  type CiState,
  type DispatchedIssueRow,
  type HealthReportDigest,
  type OrchestrateTask,
  type PullRequestInfo,
  type WorkflowRunInfo,
} from '@/lib/agent-health/release-readiness';
import {
  renderReleaseReadinessHtml,
  type ReleaseReadinessModel,
} from '@/lib/agent-health/release-readiness-html';
import { reportDateJst } from '@/lib/agent-health/report';

export interface ExecResult {
  status: number | null;
  stdout: string;
}

/** Runs a command without a shell; never throws (a missing binary is status null). */
export type Exec = (command: string, args: readonly string[], cwd: string) => ExecResult;

export interface ReleaseReportDeps {
  exec: Exec;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** The checkout whose git history is reported (default: this repository). */
  repoDir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PR_LOOKBACK_DAYS = 14;

const defaultExec: Exec = (command, args, cwd) => {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 120_000,
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
};

function defaultDeps(): ReleaseReportDeps {
  return {
    exec: defaultExec,
    now: () => new Date(),
    env: process.env,
    homedir: os.homedir(),
    repoDir: REPO_ROOT,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`[release-report] ${line}\n`),
  };
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Thin wrappers over git / gh / npm. Each returns null when the command fails. */
class Facts {
  readonly errors: string[] = [];

  constructor(
    private readonly deps: ReleaseReportDeps,
    private readonly repo: string
  ) {}

  private run(command: string, args: string[], what: string, attempts = 1): string | null {
    let result = this.deps.exec(command, args, this.deps.repoDir);
    for (let attempt = 1; attempt < attempts && result.status !== 0; attempt++) {
      result = this.deps.exec(command, args, this.deps.repoDir);
    }
    if (result.status !== 0) {
      this.errors.push(`${what}（\`${command} ${args.slice(0, 3).join(' ')} …\` が失敗）`);
      return null;
    }
    return result.stdout;
  }

  private json(command: string, args: string[], what: string): unknown {
    // GitHub's GraphQL answers 504 now and then: gh gets one retry.
    const text = this.run(command, args, what, command === 'gh' ? 2 : 1);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      this.errors.push(`${what}（出力が JSON でない）`);
      return null;
    }
  }

  git(args: string[], what: string): string | null {
    const text = this.run('git', args, what);
    return text === null ? null : text.trim();
  }

  /** Quiet probe: failure is an answer, not an error. */
  gitOk(args: string[]): boolean {
    return this.deps.exec('git', args, this.deps.repoDir).status === 0;
  }

  workflowRuns(sha: string): WorkflowRunInfo[] | null {
    const json = this.json(
      'gh',
      ['run', 'list', '--repo', this.repo, '--commit', sha, '--limit', '50', '--json', 'workflowName,status,conclusion,createdAt'],
      'develop HEAD の CI'
    );
    if (!Array.isArray(json)) return null;
    return json
      .filter((run): run is Record<string, unknown> => typeof run === 'object' && run !== null)
      .map((run) => ({
        workflowName: String(run.workflowName ?? ''),
        status: String(run.status ?? ''),
        conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
        createdAt: typeof run.createdAt === 'string' ? run.createdAt : undefined,
      }));
  }

  pullRequests(since: string): PullRequestInfo[] | null {
    const json = this.json(
      'gh',
      [
        'pr', 'list', '--repo', this.repo, '--state', 'all', '--limit', '300',
        '--search', `updated:>=${since}`,
        // No statusCheckRollup here: with it the query times out (HTTP 504). See prRollup().
        '--json', 'number,title,url,state,headRefName,baseRefName,mergedAt,mergeCommit,headRefOid,body',
      ],
      'PR の一覧'
    );
    return Array.isArray(json) ? parsePullRequests(json) : null;
  }

  /** One PR's checks, fetched only for the PRs the report shows. */
  prRollup(number: number): readonly unknown[] | null {
    const json = this.json(
      'gh',
      ['pr', 'view', String(number), '--repo', this.repo, '--json', 'statusCheckRollup'],
      `PR #${number} のチェック`
    );
    const rollup = (json as { statusCheckRollup?: unknown } | null)?.statusCheckRollup;
    return Array.isArray(rollup) ? rollup : null;
  }

  openIssues(label: string): Array<{ number: number; title: string; url: string; labels: string[] }> | null {
    const json = this.json(
      'gh',
      ['issue', 'list', '--repo', this.repo, '--state', 'open', '--label', label, '--limit', '200', '--json', 'number,title,url,labels'],
      `open な ${label} Issue`
    );
    if (!Array.isArray(json)) return null;
    return json
      .filter((issue): issue is Record<string, unknown> => typeof issue === 'object' && issue !== null && typeof issue.number === 'number')
      .map((issue) => ({
        number: issue.number as number,
        title: String(issue.title ?? ''),
        url: String(issue.url ?? ''),
        labels: Array.isArray(issue.labels)
          ? issue.labels.map((l) => String((l as { name?: unknown })?.name ?? '')).filter((l) => l !== '')
          : [],
      }));
  }

  issueBody(number: number): string | null {
    const json = this.json('gh', ['issue', 'view', String(number), '--repo', this.repo, '--json', 'body'], `#${number} の本文`);
    return typeof json === 'object' && json !== null && typeof (json as { body?: unknown }).body === 'string'
      ? (json as { body: string }).body
      : null;
  }

  /** `npm audit --omit=dev --json` exits 1 when it finds anything, so the status is not checked. */
  npmAuditHigh(): number | null {
    const result = this.deps.exec('npm', ['audit', '--omit=dev', '--json'], this.deps.repoDir);
    try {
      const count = countHighAdvisories(JSON.parse(result.stdout));
      if (count === null) this.errors.push('npm audit（出力が audit の JSON でない）');
      return count;
    } catch {
      this.errors.push('npm audit（実行できなかった）');
      return null;
    }
  }
}

/** `<main worktree>` of the checkout, from git's common dir; falls back to the checkout itself. */
function mainWorktree(facts: Facts, repoDir: string): string {
  const common = facts.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], 'main worktree の場所');
  return common ? path.dirname(common) : repoDir;
}

function loadHealthReports(reportsDir: string, date: string): HealthReportDigest[] {
  const digests: HealthReportDigest[] = [];
  for (const name of listDir(reportsDir)) {
    // `<date>.json` and its retries `<date>.json.retry-<tool>-<checkId>.json`, from the day on.
    if (!name.endsWith('.json') || name.slice(0, 10) < date) continue;
    const text = readText(path.join(reportsDir, name));
    const digest = text === null ? null : parseHealthReportDigest(name, text);
    if (digest) digests.push(digest);
  }
  return digests;
}

function loadMetrics(metricsDir: string, date: string, releaseDate: string | null) {
  const dates = listDir(metricsDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10));
  const read = (d: string | null) => (d === null ? null : parseMetricsFile(readText(path.join(metricsDir, `${d}.json`))));
  const today = read(date);
  const previousDayDate = latestDateBefore(dates, date, false);
  const releaseMetricsDate = releaseDate === null ? null : latestDateBefore(dates, releaseDate, true);
  return {
    today,
    todayFile: today ? path.join(metricsDir, `${date}.json`) : null,
    previousDayDate,
    previousDay: read(previousDayDate),
    releaseMetricsDate,
    atRelease: read(releaseMetricsDate),
  };
}

export async function main(argv: readonly string[], overrides: Partial<ReleaseReportDeps> = {}): Promise<number> {
  const deps: ReleaseReportDeps = { ...defaultDeps(), ...overrides };
  const parsed = parseReleaseReportArgs(argv, reportDateJst(deps.now()));
  if (!parsed.ok) {
    if (parsed.help) {
      deps.stdout(parsed.error);
      return 0;
    }
    deps.stderr(parsed.error);
    return 2;
  }
  const options = parsed.options;
  const { date, repo } = options;
  const facts = new Facts(deps, repo);

  const stateDir =
    options.stateDir ?? deps.env.AGENT_HEALTH_DIR ?? path.join(deps.homedir, '.commandmate', 'agent-health');
  const mainDir = options.out && options.runsDir ? null : mainWorktree(facts, deps.repoDir);
  const runsDir = options.runsDir ?? path.join(mainDir as string, 'workspace', 'orchestration', 'runs');
  const out =
    options.out ?? path.join(mainDir as string, 'workspace', 'agent-health', date, 'release-readiness.html');

  // --- dispatch record (#3045)
  const dispatch = parseDispatchRecord(readText(dispatchRecordPath(stateDir, date)));

  // --- git: develop HEAD, last release tag, fragments
  const ref = facts.gitOk(['rev-parse', '--verify', '--quiet', 'origin/develop']) ? 'origin/develop' : 'HEAD';
  const sha = facts.git(['rev-parse', ref], 'develop HEAD');
  const tag = facts.git(['describe', '--tags', '--abbrev=0', ref], '前回リリースタグ');
  // --ancestry-path: develop's own squash history is never reachable from a tag on main, so a
  // plain `<tag>..<ref>` counts all of it; only commits after the release back-merge count.
  const commitsText = tag
    ? facts.git(['rev-list', '--count', '--ancestry-path', `${tag}..${ref}`], 'タグからのコミット数')
    : null;
  const commitsSince = commitsText !== null && /^\d+$/.test(commitsText) ? Number(commitsText) : null;
  const releaseDate = tag ? jstDateOf(facts.git(['log', '-1', '--format=%cI', tag], 'タグの日付')) : null;
  const fragmentList = facts.git(['ls-tree', '--name-only', ref, 'changelog.d/'], 'changelog.d の断片');
  const fragments =
    fragmentList === null
      ? null
      : fragmentList
          .split('\n')
          .filter((file) => /^changelog\.d\/\d+\.md$/.test(file))
          .map((file) => {
            const text = facts.git(['show', `${ref}:${file}`], file) ?? '';
            const entry = text.split('\n').find((line) => line.startsWith('- ')) ?? '';
            return { file: path.basename(file), entry: entry.replace(/^- /, '') };
          });

  // --- gh: CI, PRs, Issues
  const developCi: CiState = options.gh && sha ? summarizeWorkflowRuns(facts.workflowRuns(sha)) : 'unknown';
  const prs = options.gh ? facts.pullRequests(shiftDate(date, -PR_LOOKBACK_DAYS)) : null;
  const rollupCache = new Map<number, readonly unknown[] | null>();
  const rollupOf = (number: number): readonly unknown[] | null => {
    if (!rollupCache.has(number)) rollupCache.set(number, facts.prRollup(number));
    return rollupCache.get(number) ?? null;
  };
  const checksOf = (number: number): CiState => summarizeCheckRollup(rollupOf(number));
  const mergedToday =
    prs === null
      ? null
      : mergedOnDate(prs, date).map((pr) => {
          // Merged PRs: the pull_request runs cancelled on close are not a failure (#3142).
          const { state, cancelled } = analyzeCheckRollup(rollupOf(pr.number), { ignoreCancelled: true });
          return { number: pr.number, title: pr.title, url: pr.url, checks: state, cancelledChecks: cancelled };
        });
  let openIssues: ReleaseReadinessModel['openIssues'] = null;
  if (options.gh) {
    const byNumber = new Map<number, NonNullable<ReleaseReadinessModel['openIssues']>[number]>();
    let any = false;
    for (const label of ['agent-health', 'metrics']) {
      const issues = facts.openIssues(label);
      if (issues === null) continue;
      any = true;
      for (const issue of issues) byNumber.set(issue.number, issue);
    }
    openIssues = any ? [...byNumber.values()].sort((a, b) => a.number - b.number) : null;
  }

  // --- orchestrate run files
  const runDir = path.join(runsDir, date);
  // One run's files when the dispatch record names its suffix (#3045); else the whole day.
  const runFiles = selectRunFiles(listDir(runDir), dispatch?.runSuffix);
  const tasks = new Map<number, OrchestrateTask>();
  for (const name of runFiles.filter((file) => /^tasks.*\.tsv$/.test(file))) {
    parseTasksTsv(readText(path.join(runDir, name)) ?? '', tasks);
  }
  const summaries = runFiles
    .filter((file) => /^summary.*\.md$/.test(file))
    .map((name) => ({ name, markdown: readText(path.join(runDir, name)) ?? '' }));

  // --- dispatched Issues
  const healthReports = loadHealthReports(path.join(stateDir, 'reports'), date);
  const dispatched: DispatchedIssueRow[] = (dispatch?.issues ?? []).map((issue) => {
    const pr = prs ? findPullRequestForIssue(prs, issue.number) : null;
    const task = tasks.get(issue.number);
    const waitLog = pickWaitLog(runFiles, issue.number);
    const verifyExit = waitLog ? parseVerifyExit(readText(path.join(runDir, waitLog)) ?? '') : null;
    const merged = pr?.state === 'MERGED';
    let agentHealthKey: string | null = null;
    let reproducedFail: boolean | null = null;
    if (issue.kind === 'bug' && options.gh) {
      const key = extractAgentHealthKey(facts.issueBody(issue.number) ?? '');
      if (key) {
        agentHealthKey = `agent-health:${key.tool}:${key.checkId}`;
        if (merged && pr?.mergedAt) reproducedFail = reproducesFailAfter(healthReports, key, pr.mergedAt);
      }
    }
    return {
      number: issue.number,
      kind: issue.kind,
      title: issue.title,
      agent: task ? `${task.agent}${task.model ? ` (${task.model})` : ''}` : null,
      pr: pr ? { number: pr.number, url: pr.url, state: pr.state } : null,
      ci: pr ? checksOf(pr.number) : 'unknown',
      verifyExit,
      merged,
      mergedAt: pr?.mergedAt ?? null,
      commit: merged ? pr?.mergeCommit ?? null : pr?.headRefOid ?? null,
      agentHealthKey,
      reproducedFail,
    };
  });

  // --- metrics (#3044) and npm audit
  const metrics = loadMetrics(path.join(stateDir, 'metrics'), date, releaseDate);
  let auditCurrent = metricValue(metrics.today, NPM_AUDIT_METRIC_ID);
  let auditSource = auditCurrent !== null ? `metrics/${date}.json` : '';
  if (auditCurrent === null && options.audit) {
    auditCurrent = facts.npmAuditHigh();
    if (auditCurrent !== null) auditSource = 'npm audit --omit=dev（この実行で計測）';
  }
  const auditAtRelease = metricValue(metrics.atRelease, NPM_AUDIT_METRIC_ID);
  if (auditAtRelease !== null) {
    auditSource += `${auditSource ? ' ／ ' : ''}前回リリース時: metrics/${metrics.releaseMetricsDate}.json`;
  }

  const decision = decideReadiness({
    developCi,
    mergedToday,
    audit: { current: auditCurrent, atLastRelease: auditAtRelease },
    dispatchStatus: dispatch?.status ?? null,
    dispatched,
    prLookupOk: prs !== null,
    deferred: dispatch?.deferred ?? [],
  });

  const findingsText = options.findings ? readText(options.findings) : null;
  if (options.findings && findingsText === null) facts.errors.push(`所見のファイル（${options.findings} を読めない）`);
  if (!options.gh) facts.errors.push('GitHub（--no-gh のため CI・PR・Issue は取得していない）');

  const model: ReleaseReadinessModel = {
    date,
    generatedAt: deps.now().toISOString(),
    repo,
    decision,
    developCi: {
      state: developCi,
      ref,
      sha,
      runsUrl: sha ? `https://github.com/${repo}/commit/${sha}` : null,
    },
    release: { tag, commitsSince, fragments },
    dispatch,
    dispatched,
    mergedToday,
    audit: { current: auditCurrent, atLastRelease: auditAtRelease, source: auditSource },
    metrics: {
      rows: metrics.today ? compareMetrics(metrics.today, metrics.previousDay, metrics.atRelease) : null,
      todayFile: metrics.todayFile,
      previousDayDate: metrics.previousDayDate,
      releaseDate: metrics.releaseMetricsDate,
    },
    openIssues,
    findings: findingsText !== null && options.findings ? { source: options.findings, markdown: findingsText } : null,
    summaries,
    collectionErrors: facts.errors,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderReleaseReadinessHtml(model));
  deps.stdout(`RELEASE_READINESS date=${date} verdict=${decision.verdict} dispatched=${dispatched.length} out=${out}`);
  return 0;
}
