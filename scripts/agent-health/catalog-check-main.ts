/**
 * The daily slash-command catalog drift check (Issue #3158). Entry point is
 * `catalog-check.ts`; the scheduled AI runs it from docs/agent-health/catalog-prompt.md.
 *
 * Order: `npm run catalog:refresh -- --check` → verdict (pure) → compare today's
 * agent-health report with the attestations → list the open `catalog-drift`
 * Issues the owner wrote → create / update / close → write
 * `<state>/catalog/<JST date>.json` → print one `AGENT_HEALTH_CATALOG` line.
 *
 * Every rule lives in `src/lib/agent-health/catalog-check.ts`; this file only
 * runs npm / gh through injectable functions. It never writes inside the
 * repository: the record goes under the state directory.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  agentHealthReportPath,
  attestedVersionsOf,
  buildCatalogRecord,
  CATALOG_CHECK_COMMAND,
  CATALOG_ISSUE_LABEL,
  CATALOG_REPO,
  catalogIssueBody,
  catalogRecordPath,
  closeComment,
  compareVersions,
  countChangedComment,
  formatCatalogLine,
  inconclusiveReason,
  judgeCatalogCheck,
  parseCatalogCheckArgs,
  parseTrackingIssues,
  planIssueSync,
  type CatalogCheckRecord,
  type CatalogIssueAction,
  type CatalogIssuePlan,
  type VersionComparison,
} from '@/lib/agent-health/catalog-check';
import { reportDateJst } from '@/lib/agent-health/report';
import { trackingIssueTitle } from '@/lib/slash-command-reconcile/check-report';

export interface ExecResult {
  status: number | null;
  stdout: string;
}

/** Runs a command without a shell; never throws (a missing binary is status null). */
export type Exec = (command: string, args: readonly string[]) => ExecResult;

export interface CatalogCheckDeps {
  /** gh. */
  exec: Exec;
  /** `npm run catalog:refresh -- --check` in the repository; stdout and stderr together. */
  runCheck: () => { status: number | null; output: string };
  now: () => Date;
  env: NodeJS.ProcessEnv;
  homedir: string;
  repoRoot: string;
  /** Reads a text file; null when it is missing or unreadable. */
  readText: (file: string) => string | null;
  /** Writes a text file (creating its directory); throws on failure. */
  writeText: (file: string, content: string) => void;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const defaultExec: Exec = (command, args) => {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 120_000,
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
};

function defaultDeps(): CatalogCheckDeps {
  const repoRoot = path.resolve(__dirname, '..', '..');
  return {
    exec: defaultExec,
    runCheck: () => {
      const result = spawnSync('npm', [...CATALOG_CHECK_COMMAND], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 600_000,
      });
      return {
        status: result.error ? null : result.status,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      };
    },
    now: () => new Date(),
    env: process.env,
    homedir: os.homedir(),
    repoRoot,
    readText: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    writeText: (file, content) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const staging = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(staging, content);
      fs.renameSync(staging, file);
    },
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`[agent-health-catalog] ${line}\n`),
  };
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function main(argv: readonly string[], overrides: Partial<CatalogCheckDeps> = {}): Promise<number> {
  const deps: CatalogCheckDeps = { ...defaultDeps(), ...overrides };
  const parsed = parseCatalogCheckArgs(argv);
  if (!parsed.ok) {
    if (parsed.help) {
      deps.stdout(parsed.error);
      return 0;
    }
    deps.stderr(parsed.error);
    return 2;
  }
  const { dryRun } = parsed.options;
  const startedAt = deps.now();
  const date = reportDateJst(startedAt);
  const checkedAt = startedAt.toISOString();
  const stateDir =
    parsed.options.stateDir ?? deps.env.AGENT_HEALTH_DIR ?? path.join(deps.homedir, '.commandmate', 'agent-health');

  // --- verdict
  const run = deps.runCheck();
  const report = judgeCatalogCheck(run.output, run.status ?? 1);
  const ranAtAll = run.status !== null;

  // --- versions (reported, never a verdict)
  const attested = attestedVersionsOf(
    parseJson(deps.readText(path.join(deps.repoRoot, 'src', 'config', 'slash-commands-attestations.json')))
  );
  const versions: VersionComparison = compareVersions(
    parseJson(deps.readText(agentHealthReportPath(stateDir, date))),
    attested
  );
  if (!versions.available) deps.stderr(`当日の agent-health レポートが無い: ${agentHealthReportPath(stateDir, date)}`);

  let exitCode = ranAtAll ? 0 : 2;
  const errors: string[] = [];
  if (!ranAtAll) errors.push('npm run catalog:refresh -- --check を実行できなかった');

  // --- Issue sync
  let issue: number | null = null;
  let action: CatalogIssueAction = 'none';
  let wouldDo: CatalogIssuePlan | 'unknown' | undefined;

  if (report.status !== 'inconclusive') {
    const listed = deps.exec('gh', [
      'issue', 'list', '--repo', CATALOG_REPO, '--label', CATALOG_ISSUE_LABEL, '--state', 'open',
      '--limit', '100', '--json', 'number,title,author',
    ]);
    const open = listed.status === 0 ? parseTrackingIssues(parseJson(listed.stdout)) : null;
    if (open === null) {
      errors.push(`open な ${CATALOG_ISSUE_LABEL} の Issue を gh から取得できなかった`);
      wouldDo = 'unknown';
    } else {
      const current = open[0] ?? null;
      const plan = planIssueSync(report.status, current);
      issue = current?.number ?? null;
      if (dryRun) {
        wouldDo = plan;
      } else {
        const title = trackingIssueTitle(report);
        const body = catalogIssueBody(report, versions, { checkedAt, exitCode: run.status ?? 1 });
        if (plan === 'create') {
          const created = deps.exec('gh', [
            'issue', 'create', '--repo', CATALOG_REPO, '--title', title, '--body', body, '--label', CATALOG_ISSUE_LABEL,
          ]);
          const number = /\/issues\/(\d+)/.exec(created.stdout)?.[1];
          if (created.status === 0 && number) {
            issue = Number(number);
            action = 'created';
          } else {
            errors.push('Issue を作れなかった');
          }
        } else if (plan === 'update' && current) {
          const edited = deps.exec('gh', [
            'issue', 'edit', String(current.number), '--repo', CATALOG_REPO, '--title', title, '--body', body,
          ]);
          if (edited.status === 0) {
            action = 'updated';
            if (current.title !== title) {
              const commented = deps.exec('gh', [
                'issue', 'comment', String(current.number), '--repo', CATALOG_REPO,
                '--body', countChangedComment(date, current.title, title),
              ]);
              if (commented.status !== 0) errors.push(`#${current.number} にコメントできなかった`);
            }
          } else {
            errors.push(`#${current.number} を更新できなかった`);
          }
        } else if (plan === 'close' && current) {
          const closed = deps.exec('gh', [
            'issue', 'close', String(current.number), '--repo', CATALOG_REPO, '--comment', closeComment(date),
          ]);
          if (closed.status === 0) action = 'closed';
          else errors.push(`#${current.number} を閉じられなかった`);
        }
      }
    }
    if (errors.length > 0) exitCode = Math.max(exitCode, 1);
  } else if (dryRun) {
    wouldDo = 'none';
  }

  const reasons = [inconclusiveReason(report), ...errors].filter((text): text is string => Boolean(text));
  const record: CatalogCheckRecord = buildCatalogRecord({
    date,
    checkedAt,
    dryRun,
    report,
    versions,
    issue,
    action,
    ...(wouldDo ? { wouldDo } : {}),
    ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
  });

  // --- record (not on a dry run)
  if (!dryRun) {
    const file = catalogRecordPath(stateDir, date);
    try {
      deps.writeText(file, `${JSON.stringify(record, null, 2)}\n`);
    } catch (error) {
      deps.stderr(`記録を書けなかった: ${file}（${errorText(error)}）`);
      exitCode = Math.max(exitCode, 1);
    }
  }

  for (const error of errors) deps.stderr(error);
  deps.stdout(`${dryRun ? 'DRY_RUN ' : ''}${formatCatalogLine(record)}`);
  return exitCode;
}
