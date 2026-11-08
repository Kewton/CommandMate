/**
 * The daily hand-off to develop's Claude 3 (Issue #3045). Entry point is
 * `dispatch.ts`; the scheduled AI runs it from docs/agent-health/dispatch-prompt.md.
 *
 * Order: list the open Issues → check the labels → select (pure) → take the
 * Claude 3 reservation (Issue #4243; skipped-busy when PM or another run holds
 * it) → check Claude 3 (pure judgement of `commandmate ls --json`) → `/clear`
 * → wait for its prompt → send the request → label and comment the Issues →
 * write `<state>/dispatch/<JST date>.json` → print one `AGENT_HEALTH_DISPATCH`
 * line. Every send goes through the reservation (`sendUnderReservation`), and
 * the reservation is kept after the request is sent: the run's last step
 * releases it (buildTerms). See docs/design/claude3-dispatch-exclusion-4243.md.
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
  buildTerms,
  DISPATCH_REPO,
  DISPATCHED_LABEL,
  dispatchComment,
  dispatchTermsPath,
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
  acquireReservation,
  defaultReservationDir,
  describeHolder,
  isOverdue,
  readReservation,
  releaseReservation,
  sendUnderReservation,
  type ReservationEnv,
  type ReservationGeneration,
} from '@/lib/agent-health/claude3-reservation';
import {
  dispatchRecordPath,
  parseDispatchRecord,
  type DispatchIssue,
  type DispatchRecord,
} from '@/lib/agent-health/dispatch-record';
import { reportDateJst } from '@/lib/agent-health/report';
import { defaultSpawnExec, spawnExecFromSync, type SpawnExec } from './spawn-exec';

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
  /** The repository this runs in; the terms file goes under its `workspace/`. */
  repoRoot: string;
  /** Writes a text file (creating its directory); throws on failure. */
  writeText: (file: string, content: string) => void;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /**
   * `commandmate send` (asynchronous, reports the child's pid). Default: a real
   * spawn — or, when only `exec` is injected (a test), `exec` itself.
   */
  spawnExec?: SpawnExec;
  /**
   * The Claude 3 reservation's directory (Issue #4243). Production is always
   * `defaultReservationDir()`; there is no option or environment variable for
   * it. When only `exec` is injected (a test) and this is not, a throwaway
   * directory under os.tmpdir() is used and removed — never the real one.
   */
  reservationDir?: string;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  /** Test hook of the reservation (after reading N, before publishing N+1). */
  beforePublish?: ReservationEnv['beforePublish'];
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
    repoRoot: path.resolve(__dirname, '..', '..'),
    writeText: (file, content) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
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
  const injected = overrides.exec !== undefined;
  let throwaway: string | null = null;
  let reservationDir = overrides.reservationDir;
  if (!reservationDir) {
    if (injected) {
      throwaway = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-claude3-reservation-'));
      reservationDir = throwaway;
    } else {
      reservationDir = defaultReservationDir();
    }
  }
  const spawnExec = overrides.spawnExec ?? (injected ? spawnExecFromSync(deps.exec) : defaultSpawnExec);
  const reservation: ReservationEnv = {
    dir: reservationDir,
    now: deps.now,
    pid: deps.pid ?? process.pid,
    ...(deps.isAlive ? { isAlive: deps.isAlive } : {}),
    ...(deps.beforePublish ? { beforePublish: deps.beforePublish } : {}),
  };
  try {
    return await dispatch(deps, parsed.options, reservation, spawnExec);
  } finally {
    if (throwaway) fs.rmSync(throwaway, { recursive: true, force: true });
  }
}

async function dispatch(
  deps: DispatchDeps,
  options: { stateDir: string | null; dryRun: boolean },
  reservation: ReservationEnv,
  spawnExec: SpawnExec
): Promise<number> {
  const { dryRun } = options;
  const date = reportDateJst(deps.now());
  const stateDir =
    options.stateDir ?? deps.env.AGENT_HEALTH_DIR ?? path.join(deps.homedir, '.commandmate', 'agent-health');
  const recordFile = dispatchRecordPath(stateDir, date);

  /**
   * Writes the record (not on a dry run), prints the line, returns the exit code.
   * A `sent` record of the day is never replaced by anything but `sent` (#4243 R5).
   */
  const finish = (record: DispatchRecord, exitCode: number): number => {
    if (!dryRun) {
      const existing = parseDispatchRecord(readText(recordFile));
      if (existing?.status === 'sent' && record.status !== 'sent') {
        deps.stderr(`本日（${date}）の記録は sent のため置き換えない（${recordFile}）`);
      } else {
        const error = writeRecord(recordFile, record);
        if (error) {
          deps.stderr(error);
          exitCode = Math.max(exitCode, record.status === 'sent' ? 1 : 2);
        }
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
  const carried = [...issues.map((issue) => issue.number), ...deferred];
  const skipped = (reason: string): number => {
    deps.stderr(`${reason} のため送らない（翌日に持ち越し）`);
    return finish(buildDispatchRecord({ date, status: 'skipped-busy', issues: [], deferred: carried, reason }), 0);
  };

  // --- the reservation (#4243): someone else holds Claude 3 → nothing is sent, nothing waits
  const skipReserved = (current: ReservationGeneration): number => {
    if (current.holder === 'dispatch' && current.date === date) {
      // Today's other dispatch holds it and writes today's record: only print.
      const reason = `同じ日付（${date}）の自動依頼が claude-3 を予約中（記録はそちらが書く）`;
      deps.stderr(reason);
      deps.stdout(
        `${dryRun ? 'DRY_RUN ' : ''}${formatDispatchLine({ date, status: 'skipped-busy', issues: [], deferred: carried, reason })}`
      );
      return 0;
    }
    if (current.holder === 'dispatch') {
      return skipped(
        `前日（${current.date ?? '-'}）の自動依頼の run が claude-3 を予約中${isOverdue(current, deps.now()) ? '（期限超過・要確認）' : ''}`
      );
    }
    return skipped(describeHolder(current, deps.now()));
  };

  // --- Claude 3
  const readState = (): AgentState => judgeAgentState(json(deps, 'commandmate', ['ls', '--json']));
  /** Claude 3's state when it may be sent to; else the exit code of the stop (record written). */
  const checkState = (): { stop: number } | { kind: AgentState['kind'] } => {
    const state = readState();
    if (state.kind === 'unknown') return { stop: fail(`Claude 3 の状態を確かめられない: ${state.detail}`, issues, deferred) };
    if (state.kind === 'busy') {
      deps.stderr(`Claude 3 が ${state.detail} のため送らない（翌日に持ち越し）`);
      return {
        stop: finish(
          buildDispatchRecord({ date, status: 'skipped-busy', issues: [], deferred: carried, reason: `Claude 3 が${state.detail}` }),
          0
        ),
      };
    }
    return { kind: state.kind };
  };

  if (dryRun) {
    const read = readReservation(reservation.dir);
    if (!read.ok) return fail(read.message, issues, deferred);
    if (read.current.state === 'held') return skipReserved(read.current);
    const checked = checkState();
    if ('stop' in checked) return checked.stop;
    const termsFile = dispatchTermsPath(deps.repoRoot, date, issues);
    const request = buildRequest(issues, termsFile);
    deps.stdout(`DRY_RUN state=${checked.kind} (nothing is sent, labelled or written)`);
    deps.stdout(`DRY_RUN terms file (not written): ${termsFile}`);
    deps.stdout(`DRY_RUN commandmate ${JSON.stringify(sendArgv('/clear', false))}`);
    deps.stdout(`DRY_RUN commandmate ${JSON.stringify(sendArgv('<request>', true))}`);
    deps.stdout('DRY_RUN request:');
    for (const line of request.split('\n')) deps.stdout(`  ${line}`);
    return finish(buildDispatchRecord({ date, status: 'sent', issues, deferred }), 0);
  }

  const acquired = acquireReservation(reservation, {
    holder: 'dispatch',
    label: issues.map((issue) => `#${issue.number}`).join(' '),
    date,
  });
  if (!acquired.ok) {
    if (acquired.code === 3 && acquired.current?.state === 'held') return skipReserved(acquired.current);
    return fail(acquired.message, issues, deferred);
  }
  const token = acquired.generation.token as string;
  /** Kept once the request may have arrived: the run releases it (buildTerms). */
  let keep = false;
  try {
    // Another dispatch may have sent between the first check and the reservation.
    const again = parseDispatchRecord(readText(recordFile));
    if (again?.status === 'sent') {
      deps.stderr(`本日（${date}）は送信済み（${recordFile}）。再依頼しない`);
      deps.stdout(formatDispatchLine({ ...again, reason: '本日は送信済み（再依頼しない）' }));
      return 0;
    }

    const checked = checkState();
    if ('stop' in checked) return checked.stop;

    const termsFile = dispatchTermsPath(deps.repoRoot, date, issues);
    const request = buildRequest(issues, termsFile);

    // --- the terms the request points at (a send is one line; see buildRequest)
    try {
      deps.writeText(termsFile, buildTerms(date, issues, token));
    } catch (error) {
      return fail(`条件ファイルを書けなかった: ${termsFile}（${error instanceof Error ? error.message : String(error)}）`, issues, deferred);
    }

    // --- send: every attempt (and the resend) checks the reservation first
    type Sent = { kind: 'ok' } | { kind: 'refused'; code: number; message: string } | { kind: 'failed'; status: number | null };
    const send = async (message: string, withAutoYes: boolean): Promise<Sent> => {
      const args = sendArgv(message, withAutoYes);
      const once = () => sendUnderReservation(reservation, token, (onChild) => spawnExec('commandmate', args, onChild));
      let result = await once();
      if (result.sent && result.status === COLD_START_EXIT) {
        deps.stderr(`send が exit ${COLD_START_EXIT}（起動直後）。${COLD_START_RETRY_MS / 1000} 秒後に 1 回だけ再送する`);
        await deps.sleep(COLD_START_RETRY_MS);
        result = await once();
      }
      if (!result.sent) return { kind: 'refused', code: result.code, message: result.message };
      return result.status === 0 ? { kind: 'ok' } : { kind: 'failed', status: result.status };
    };
    const refused = (sent: { code: number; message: string }): number =>
      sent.code === 3
        ? skipped(`予約が途中で引き継がれた（${sent.message}）`)
        : fail(`予約を確かめられなかった: ${sent.message}`, issues, deferred);

    // Issue #4115: `/clear` is a message to the same process. It keeps the role that
    // process started with and resolves nothing again; a new process gets the default.
    const cleared = await send('/clear', false);
    if (cleared.kind === 'refused') return refused(cleared);
    if (cleared.kind === 'failed') return fail('/clear を送れなかった', issues, deferred);
    let ready = false;
    for (let waited = 0; waited <= READY_TIMEOUT_MS; waited += READY_POLL_MS) {
      await deps.sleep(READY_POLL_MS);
      if (readState().kind === 'ready') {
        ready = true;
        break;
      }
    }
    if (!ready) return fail(`/clear の後 ${READY_TIMEOUT_MS / 1000} 秒で Claude 3 が入力待ちに戻らなかった`, issues, deferred);
    const requested = await send(request, true);
    if (requested.kind === 'refused') return refused(requested);
    if (requested.kind === 'failed') {
      if (requested.status === COLD_START_EXIT) return fail('依頼を送れなかった', issues, deferred);
      // It may have arrived: the run (or a person) releases the reservation.
      keep = true;
      return fail(`依頼を送れなかった（exit ${String(requested.status)}。届いたか不明のため claude-3 の予約は外さない）`, issues, deferred);
    }
    keep = true;
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
  } finally {
    // Only this token's reservation: a takeover / force release in between is left alone.
    if (!keep) releaseReservation(reservation, token);
  }
}
