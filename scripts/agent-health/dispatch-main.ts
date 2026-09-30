/**
 * The daily hand-off to develop's Claude 3 (Issue #3045). Entry point is
 * `dispatch.ts`; the scheduled AI runs it from docs/agent-health/dispatch-prompt.md.
 *
 * Order: list the open Issues → check the labels → select (pure) → check
 * Claude 3 (pure judgement of `commandmate ls --json`) → `/clear` → wait for
 * its prompt → send the request → label and comment the Issues → write
 * `<state>/dispatch/<JST date>.json` → print one `AGENT_HEALTH_DISPATCH` line.
 *
 * Every rule lives in `src/lib/agent-health/dispatch.ts`; this file only runs
 * gh / commandmate through an injectable `exec`. The destination is the
 * constants there — there is no option to send anywhere else.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildDispatchRecord,
  buildRequest,
  DISPATCH_REPO,
  DISPATCHED_LABEL,
  dispatchComment,
  formatDispatchLine,
  judgeAgentState,
  missingLabels,
  parseDispatchArgs,
  parseIssueList,
  parseLabelNames,
  selectDispatchTargets,
  sendArgv,
  type AgentState,
} from '@/lib/agent-health/dispatch';
import {
  dispatchRecordPath,
  parseDispatchRecord,
  type DispatchIssue,
  type DispatchRecord,
} from '@/lib/agent-health/dispatch-record';
import { reportDateJst } from '@/lib/agent-health/report';

export interface ExecResult {
  status: number | null;
  stdout: string;
}

/** Runs a command without a shell; never throws (a missing binary is status null). */
export type Exec = (command: string, args: readonly string[]) => ExecResult;

export interface DispatchDeps {
  exec: Exec;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  homedir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** `commandmate send` exits 99 on a cold start whose prompt is not ready yet: one resend after this. */
export const COLD_START_RETRY_MS = 120_000;
export const COLD_START_EXIT = 99;
/** How long `/clear` gets to bring Claude 3 back to its prompt. */
export const READY_TIMEOUT_MS = 90_000;
export const READY_POLL_MS = 5_000;

const defaultExec: Exec = (command, args) => {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 300_000,
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' };
};

function defaultDeps(): DispatchDeps {
  return {
    exec: defaultExec,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    env: process.env,
    homedir: os.homedir(),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`[agent-health-dispatch] ${line}\n`),
  };
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function writeRecord(file: string, record: DispatchRecord): string | null {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const staging = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(staging, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(staging, file);
    return null;
  } catch (error) {
    return `記録を書けなかった: ${file}（${error instanceof Error ? error.message : String(error)}）`;
  }
}

function json(deps: DispatchDeps, command: string, args: string[]): unknown {
  const result = deps.exec(command, args);
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

export async function main(argv: readonly string[], overrides: Partial<DispatchDeps> = {}): Promise<number> {
  const deps: DispatchDeps = { ...defaultDeps(), ...overrides };
  const parsed = parseDispatchArgs(argv);
  if (!parsed.ok) {
    if (parsed.help) {
      deps.stdout(parsed.error);
      return 0;
    }
    deps.stderr(parsed.error);
    return 2;
  }
  const { dryRun } = parsed.options;
  const date = reportDateJst(deps.now());
  const stateDir =
    parsed.options.stateDir ?? deps.env.AGENT_HEALTH_DIR ?? path.join(deps.homedir, '.commandmate', 'agent-health');
  const recordFile = dispatchRecordPath(stateDir, date);

  /** Writes the record (not on a dry run), prints the line, returns the exit code. */
  const finish = (record: DispatchRecord, exitCode: number): number => {
    if (!dryRun) {
      const error = writeRecord(recordFile, record);
      if (error) {
        deps.stderr(error);
        exitCode = Math.max(exitCode, record.status === 'sent' ? 1 : 2);
      }
    }
    deps.stdout(`${dryRun ? 'DRY_RUN ' : ''}${formatDispatchLine(record)}`);
    return exitCode;
  };
  const fail = (reason: string, issues: readonly DispatchIssue[] = [], deferred: readonly number[] = []): number => {
    deps.stderr(reason);
    // Not sent: whatever was selected is carried over to tomorrow.
    return finish(
      buildDispatchRecord({ date, status: 'skipped-busy', issues: [], deferred: [...issues.map((i) => i.number), ...deferred], reason }),
      2
    );
  };

  // A failed orchestrate is not handed again the same day.
  const earlier = parseDispatchRecord(readText(recordFile));
  if (earlier?.status === 'sent' && !dryRun) {
    deps.stderr(`本日（${date}）は送信済み（${recordFile}）。再依頼しない`);
    deps.stdout(formatDispatchLine({ ...earlier, reason: '本日は送信済み（再依頼しない）' }));
    return 0;
  }

  // --- targets
  const candidates = parseIssueList(
    json(deps, 'gh', [
      'issue', 'list', '--repo', DISPATCH_REPO, '--state', 'open', '--limit', '300',
      '--json', 'number,title,author,labels,createdAt',
    ])
  );
  if (candidates === null) return fail('open な Issue の一覧を gh から取得できなかった');
  const { issues, deferred } = selectDispatchTargets(candidates);

  const labels = parseLabelNames(json(deps, 'gh', ['label', 'list', '--repo', DISPATCH_REPO, '--limit', '300', '--json', 'name']));
  if (labels === null) return fail('ラベルの一覧を gh から取得できなかった', issues, deferred);
  const missing = missingLabels(labels);
  if (missing.length > 0) {
    const reason = `ラベルが GitHub に無い: ${missing.join(', ')}（作成は利用者が行う。docs/user-guide/agent-health.md「自動依頼」）`;
    if (!dryRun) return fail(reason, issues, deferred);
    deps.stderr(`${reason} — --dry-run のため続ける`);
  }

  if (issues.length === 0) {
    return finish(buildDispatchRecord({ date, status: 'no-target', issues: [], deferred }), 0);
  }

  // --- Claude 3
  const readState = (): AgentState => judgeAgentState(json(deps, 'commandmate', ['ls', '--json']));
  const state = readState();
  if (state.kind === 'unknown') return fail(`Claude 3 の状態を確かめられない: ${state.detail}`, issues, deferred);
  if (state.kind === 'busy') {
    deps.stderr(`Claude 3 が ${state.detail} のため送らない（翌日に持ち越し）`);
    return finish(
      buildDispatchRecord({
        date,
        status: 'skipped-busy',
        issues: [],
        deferred: [...issues.map((issue) => issue.number), ...deferred],
        reason: `Claude 3 が${state.detail}`,
      }),
      0
    );
  }

  const request = buildRequest(date, issues);
  if (dryRun) {
    deps.stdout(`DRY_RUN state=${state.kind} (nothing is sent, labelled or written)`);
    deps.stdout(`DRY_RUN commandmate ${JSON.stringify(sendArgv('/clear', false))}`);
    deps.stdout(`DRY_RUN commandmate ${JSON.stringify(sendArgv('<request>', true))}`);
    deps.stdout('DRY_RUN request:');
    for (const line of request.split('\n')) deps.stdout(`  ${line}`);
    return finish(buildDispatchRecord({ date, status: 'sent', issues, deferred }), 0);
  }

  // --- send
  const send = async (message: string, withAutoYes: boolean): Promise<boolean> => {
    const args = sendArgv(message, withAutoYes);
    let result = deps.exec('commandmate', args);
    if (result.status === COLD_START_EXIT) {
      deps.stderr(`send が exit ${COLD_START_EXIT}（起動直後）。${COLD_START_RETRY_MS / 1000} 秒後に 1 回だけ再送する`);
      await deps.sleep(COLD_START_RETRY_MS);
      result = deps.exec('commandmate', args);
    }
    return result.status === 0;
  };

  if (!(await send('/clear', false))) return fail('/clear を送れなかった', issues, deferred);
  let ready = false;
  for (let waited = 0; waited <= READY_TIMEOUT_MS; waited += READY_POLL_MS) {
    await deps.sleep(READY_POLL_MS);
    if (readState().kind === 'ready') {
      ready = true;
      break;
    }
  }
  if (!ready) return fail(`/clear の後 ${READY_TIMEOUT_MS / 1000} 秒で Claude 3 が入力待ちに戻らなかった`, issues, deferred);
  if (!(await send(request, true))) return fail('依頼を送れなかった', issues, deferred);
  const sentAt = deps.now().toISOString();

  // --- mark the Issues so tomorrow does not pick them again
  const markErrors: string[] = [];
  for (const issue of issues) {
    const number = String(issue.number);
    if (deps.exec('gh', ['issue', 'edit', number, '--repo', DISPATCH_REPO, '--add-label', DISPATCHED_LABEL]).status !== 0) {
      markErrors.push(`#${number} にラベルを付けられなかった`);
    }
    const body = dispatchComment(date, issue, issues);
    if (deps.exec('gh', ['issue', 'comment', number, '--repo', DISPATCH_REPO, '--body', body]).status !== 0) {
      markErrors.push(`#${number} にコメントできなかった`);
    }
  }
  for (const error of markErrors) deps.stderr(error);

  return finish(
    buildDispatchRecord({
      date,
      status: 'sent',
      sentAt,
      issues,
      deferred,
      ...(markErrors.length > 0 ? { reason: markErrors.join('／') } : {}),
    }),
    markErrors.length > 0 ? 1 : 0
  );
}
