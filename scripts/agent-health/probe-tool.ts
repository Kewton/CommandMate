/**
 * One tool's probe: launch, get past start-up dialogs, drive the fixed turns,
 * judge each screen with the production detector (Issue #2878).
 *
 * Nothing here decides pass/fail by itself — the verdicts come from
 * `src/lib/agent-health/{screen-checks,hook-correlation,server-events}.ts`. What lives here
 * is timing: when a frame is "the idle screen", "the running screen", "the
 * dialog", "the reply is done".
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { stripAnsi } from '@/lib/detection/ansi';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { shellQuote } from '@/lib/hooks/hook-settings-generator';
import { getAgentEventSource, renderAgentLaunchCommand } from '@/lib/hooks/sources';
import { selectionKeys } from '@/lib/agent-health/dialog-select';
import {
  evaluateHookCorrelation,
  expectedHookEvents,
} from '@/lib/agent-health/hook-correlation';
import { firstVersionLine, paneEvidence } from '@/lib/agent-health/report';
import {
  evaluateOpencodeV2LaunchLine,
  evaluateServerEvents,
  evaluateServerLeftovers,
} from '@/lib/agent-health/server-events';
import {
  countMatches,
  evaluateScreen,
  screenExpectationHolds,
  type ScreenCheckId,
  type ScreenVerdict,
} from '@/lib/agent-health/screen-checks';
import {
  PROBE_WORKTREE_ID,
  probeInstanceId,
  type AgentHealthCheck,
  type AgentHealthCheckId,
} from '@/lib/agent-health/types';
import type { AgentEventSource } from '@/lib/hooks/sources/types';
import type { HookListener } from './hook-listener';
import {
  collectServerLeftovers,
  recordServerEvents,
  releaseProbeServer,
  reserveProbeServer,
  type ServerEventRecorder,
} from './opencode-v2-server';
import type { AgentHealthTmux } from './tmux-driver';
import type { ToolProbeSpec } from './tool-table';

const execFileAsync = promisify(execFile);

const VERSION_TIMEOUT_MS = 20_000;
const POLL_MS = 1000;
const RUNNING_POLL_MS = 500;
/** How long the running screen may take to appear after the request. */
const RUNNING_APPEAR_MS = 20_000;
/** How long an approval dialog may take to appear after the request. */
const DIALOG_APPEAR_MS = 60_000;
/** Longest wait for one turn to finish. */
const TURN_MAX_MS = 90_000;
/** Longest wait for the first idle screen. */
const STARTUP_MAX_MS = 45_000;
/** Pause between typing a request and pressing Enter (codex drops an Enter that arrives with the text). */
const TYPE_TO_ENTER_MS = 800;
/** After the session is killed: time for a `session_end` / late `stop` to land. */
const HOOK_GRACE_MS = 2000;

export interface ProbeContext {
  spec: ToolProbeSpec;
  tmux: AgentHealthTmux;
  listener: HookListener;
  /** Environment for `--version` and `git init` (no TMUX, no inherited CM_*). */
  childEnv: NodeJS.ProcessEnv;
  workRoot: string;
  selected: (checkId: AgentHealthCheckId) => boolean;
  /** Absolute epoch ms by which this tool must be done. */
  deadline: number;
  log: (message: string) => void;
}

export interface ProbeOutcome {
  version: string | null;
  checks: AgentHealthCheck[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export async function readVersion(
  executable: string,
  env: NodeJS.ProcessEnv
): Promise<{ version: string | null; error: string | null }> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
      env,
    });
    const version = firstVersionLine(stdout) ?? firstVersionLine(stderr);
    return version === null
      ? { version: null, error: `${executable} --version は何も出力しなかった` }
      : { version, error: null };
  } catch (error) {
    return { version: null, error: error instanceof Error ? error.message : String(error) };
  }
}

class DeadlineExceeded extends Error {}

/**
 * What fills the `hook-correlation` slot: the hooks the listener receives,
 * the tool's own server's SSE (opencode-v2, Issue #2937), or nothing — a
 * tool that reads its events from a server the probe does not check
 * (`configScope: 'none'`, v1's opencode).
 */
export type EventCheckMode = 'hooks' | 'server-sse' | 'skip';

export function eventCheckMode(
  spec: Pick<ToolProbeSpec, 'server'>,
  capabilities: Pick<AgentEventSource['capabilities'], 'configScope'>
): EventCheckMode {
  if (spec.server === 'opencode-v2') return 'server-sse';
  return capabilities.configScope === 'none' ? 'skip' : 'hooks';
}

/** The pane's command: `K=V …` from `spec.launchEnv`, then the production line, then the flags. */
export function buildProbeLaunchCommand(spec: ToolProbeSpec, renderedLaunch: string, workDir: string): string {
  const env = Object.entries(spec.launchEnv?.(workDir) ?? {}).map(([name, value]) => `${name}=${shellQuote(value)}`);
  return [...env, renderedLaunch, ...spec.launchFlags(workDir).map(shellQuote)].join(' ');
}

/** Everything one session needs; one instance per tool. */
class ToolSession {
  readonly name: string;
  readonly checks = new Map<AgentHealthCheckId, AgentHealthCheck>();
  lastFrame = '';
  /** From the running request's Enter to the end of that turn. */
  runningWindow: { from: number; to: number } | null = null;

  constructor(private readonly ctx: ProbeContext) {
    this.name = `agent-health-${ctx.spec.tool}`;
  }

  private get spec() {
    return this.ctx.spec;
  }

  private remaining(): number {
    return this.ctx.deadline - Date.now();
  }

  private bounded(ms: number): number {
    const left = this.remaining();
    if (left <= 0) throw new DeadlineExceeded();
    return Math.min(ms, left);
  }

  record(check: AgentHealthCheck): void {
    if (!this.ctx.selected(check.checkId)) return;
    this.checks.set(check.checkId, check);
    this.ctx.log(`${this.spec.tool}: ${check.checkId} ${check.status} — ${check.summary}`);
  }

  async look(): Promise<{ frame: string; clean: string; verdict: ScreenVerdict }> {
    const frame = await this.ctx.tmux.capture(this.name, this.spec.captureLines);
    this.lastFrame = frame;
    const result = detectSessionStatus(frame, this.spec.cliToolId);
    return {
      frame,
      clean: stripAnsi(frame),
      verdict: {
        status: result.status,
        reason: result.reason,
        hasActivePrompt: result.hasActivePrompt,
        evidence: result.evidence,
      },
    };
  }

  recordScreen(checkId: ScreenCheckId, verdict: ScreenVerdict, frame: string, note?: string): void {
    this.record({ checkId, ...evaluateScreen(checkId, verdict, frame, note) });
  }

  async start(command: string, workDir: string): Promise<void> {
    await this.ctx.tmux.newSession({
      sessionName: this.name,
      workingDirectory: workDir,
      width: this.spec.width,
      height: this.spec.height,
      command,
    });
  }

  /** Answer start-up dialogs, then return the first frame that stops changing. */
  async waitForStartup(): Promise<{ frame: string; verdict: ScreenVerdict }> {
    const startedAt = Date.now();
    const limit = startedAt + this.bounded(STARTUP_MAX_MS);
    const answered = new Map<string, number>();
    let previous: string | null = null;
    let stableSince = Date.now();
    let last = await this.look();
    while (Date.now() < limit) {
      await sleep(POLL_MS);
      last = await this.look();
      const dialog = this.spec.startupDialogs.find((d) => d.pattern.test(last.clean));
      if (dialog && (answered.get(dialog.id) ?? 0) < 3) {
        const keys = dialog.select ? selectionKeys(last.frame, dialog.select) : (dialog.keys ?? null);
        if (keys) {
          answered.set(dialog.id, (answered.get(dialog.id) ?? 0) + 1);
          this.ctx.log(`${this.spec.tool}: start-up dialog "${dialog.id}" → ${keys.join(' ')}`);
          for (const key of keys) {
            await this.ctx.tmux.sendKey(this.name, key);
            await sleep(300);
          }
          previous = null;
          continue;
        }
      }
      if (last.frame === previous) {
        if (Date.now() - stableSince >= 2 * POLL_MS && Date.now() - startedAt >= 4000) return last;
      } else {
        previous = last.frame;
        stableSince = Date.now();
      }
    }
    if (this.remaining() <= 0) throw new DeadlineExceeded();
    return last;
  }

  async submit(text: string): Promise<number> {
    if (text.includes('\n')) await this.ctx.tmux.pasteText(this.name, text);
    else await this.ctx.tmux.typeText(this.name, text);
    await sleep(TYPE_TO_ENTER_MS);
    const before = await this.ctx.tmux.capture(this.name, this.spec.captureLines);
    const sentAt = Date.now();
    await this.ctx.tmux.sendKey(this.name, 'Enter');
    await sleep(1500);
    const after = await this.ctx.tmux.capture(this.name, this.spec.captureLines);
    if (after === before) {
      // The Enter was swallowed (arrived while the TUI still treated the
      // input as a paste). One more, never more than one.
      this.ctx.log(`${this.spec.tool}: nothing moved after Enter — pressing Enter once more`);
      await this.ctx.tmux.sendKey(this.name, 'Enter');
    }
    return sentAt;
  }

  /**
   * Wait until the turn is over: the frame stopped changing and the detector
   * no longer says `running` (a frame that says running forever runs into the
   * limit and is judged anyway). Hooks are deliberately not consulted: the
   * screen checks must hold on a tool whose hooks are broken, too.
   *
   * @param onDialog - called once per new approval dialog; returns after
   *   refusing it
   * @param dialogBaseline - approval-dialog count before the request was
   *   sent (defaults to the count on the last frame looked at)
   */
  async waitForTurnEnd(
    sentAt: number,
    onDialog?: (seen: { frame: string; verdict: ScreenVerdict }) => Promise<void>,
    dialogBaseline?: number
  ): Promise<{ frame: string; verdict: ScreenVerdict }> {
    const limit = Date.now() + this.bounded(TURN_MAX_MS);
    const dialog = this.spec.approval.dialog;
    let baseline = dialogBaseline ?? countMatches(stripAnsi(this.lastFrame), dialog);
    let previous: string | null = null;
    let stableSince = Date.now();
    let last = await this.look();
    let refusals = 0;
    while (Date.now() < limit) {
      await sleep(POLL_MS);
      last = await this.look();
      const dialogs = countMatches(last.clean, dialog);
      if (onDialog && dialogs > baseline && refusals < 3) {
        refusals++;
        await sleep(700);
        const settled = await this.look();
        await onDialog(settled);
        last = await this.look();
        baseline = countMatches(last.clean, dialog);
        previous = null;
        continue;
      }
      baseline = Math.min(baseline, dialogs);
      if (last.frame === previous) {
        const quiet = Date.now() - stableSince >= 2 * POLL_MS;
        const old = Date.now() - sentAt >= 6000;
        if (quiet && old && last.verdict.status !== 'running') return last;
      } else {
        previous = last.frame;
        stableSince = Date.now();
      }
    }
    if (this.remaining() <= 0) throw new DeadlineExceeded();
    return last;
  }

  async refuse(): Promise<void> {
    for (const key of this.spec.approval.denyKeys) {
      await this.ctx.tmux.sendKey(this.name, key);
      await sleep(300);
    }
  }

  /** Raise the approval dialog with `prompt`, judge it, refuse it. */
  async approvalTurn(prompt: string): Promise<void> {
    const dialog = this.spec.approval.dialog;
    const baseline = countMatches(stripAnsi(this.lastFrame), dialog);
    const sentAt = await this.submit(prompt);
    const limit = Date.now() + this.bounded(DIALOG_APPEAR_MS);
    let seen: { frame: string; verdict: ScreenVerdict } | null = null;
    while (Date.now() < limit) {
      await sleep(POLL_MS);
      const now = await this.look();
      if (countMatches(now.clean, dialog) > baseline) {
        await sleep(700);
        seen = await this.look();
        break;
      }
    }
    if (seen) {
      this.recordScreen('screen-approval', seen.verdict, seen.frame, '承認ダイアログは画面に出ていた');
      await this.refuse();
    } else {
      this.record({
        checkId: 'screen-approval',
        status: 'fail',
        summary: `期待: 「${prompt}」で承認ダイアログ（${dialog.source}）が出る。実際: ${DIALOG_APPEAR_MS / 1000} 秒以内に出なかった`,
        evidence: paneEvidence(this.lastFrame),
      });
    }
    await this.waitForTurnEnd(sentAt, async () => this.refuse());
  }

  /** `sleep 20`: judge the running screen; where it asks first, judge that dialog too. */
  async runningTurn(): Promise<boolean> {
    const dialog = this.spec.approval.dialog;
    const baseline = countMatches(stripAnsi(this.lastFrame), dialog);
    const sentAt = await this.submit(this.spec.prompts.running);
    const limit = Date.now() + this.bounded(RUNNING_APPEAR_MS);
    let running: { frame: string; verdict: ScreenVerdict } | null = null;
    let last = await this.look();
    while (Date.now() < limit) {
      if (screenExpectationHolds('screen-running', last.verdict)) {
        running = last;
        break;
      }
      if (countMatches(last.clean, dialog) > baseline) break;
      await sleep(RUNNING_POLL_MS);
      last = await this.look();
    }
    const seen = running ?? last;
    this.recordScreen('screen-running', seen.verdict, seen.frame);

    let approvalJudged = false;
    await this.waitForTurnEnd(
      sentAt,
      async (atDialog) => {
      if (this.spec.approval.via === 'running-turn' && !approvalJudged) {
        approvalJudged = true;
        this.recordScreen(
          'screen-approval',
          atDialog.verdict,
          atDialog.frame,
          `「${this.spec.prompts.running}」で出た承認ダイアログ`
        );
      }
      await this.refuse();
      },
      baseline
    );
    this.runningWindow = { from: sentAt, to: Date.now() };
    return approvalJudged;
  }

  async quotedTurn(): Promise<void> {
    const sentAt = await this.submit(this.spec.prompts.quoted);
    const done = await this.waitForTurnEnd(sentAt);
    this.recordScreen('screen-quoted-dialog', done.verdict, done.frame);
  }

  async plainTurn(): Promise<void> {
    const sentAt = await this.submit('Reply with the single word OK.');
    await this.waitForTurnEnd(sentAt);
  }
}

/**
 * Run every selected check for one tool. `version` always runs; when it
 * fails, the rest are skipped.
 */
export async function probeTool(ctx: ProbeContext): Promise<ProbeOutcome> {
  const { spec } = ctx;
  const checks: AgentHealthCheck[] = [];

  const { version, error } = await readVersion(spec.executable, ctx.childEnv);
  if (version === null) {
    checks.push({
      checkId: 'version',
      status: 'fail',
      summary: `期待: \`${spec.executable} --version\` が版を返す。実際: 取得できなかった`,
      evidence: error ?? undefined,
    });
    for (const checkId of ['hook-correlation', 'screen-idle', 'screen-running', 'screen-approval', 'screen-quoted-dialog'] as const) {
      if (ctx.selected(checkId)) {
        checks.push({ checkId, status: 'skip', summary: 'version が取れないため実行しない', skipReason: 'version fail' });
      }
    }
    return { version: null, checks };
  }
  checks.push({ checkId: 'version', status: 'pass', summary: `\`${spec.executable} --version\` → ${version}` });

  const screens = (['screen-idle', 'screen-running', 'screen-approval', 'screen-quoted-dialog'] as const).filter(
    ctx.selected
  );
  const source = getAgentEventSource(spec.cliToolId);
  const mode = eventCheckMode(spec, source.capabilities);
  const wantHooks = ctx.selected('hook-correlation') && mode === 'hooks';
  const wantSse = ctx.selected('hook-correlation') && mode === 'server-sse';
  if (ctx.selected('hook-correlation') && mode === 'skip') {
    checks.push({
      checkId: 'hook-correlation',
      status: 'skip',
      summary: 'hook を使わないツール（configScope: none）',
      skipReason: `${spec.tool} は configScope: 'none'（イベントは hook ではなく自前の HTTP/SSE から読む）`,
    });
  }
  if (screens.length === 0 && !wantHooks && !wantSse) return { version, checks };

  const session = new ToolSession(ctx);
  const workDir = path.join(ctx.workRoot, spec.tool);
  fs.mkdirSync(workDir, { recursive: true });
  await execFileAsync('git', ['init', '-q'], { cwd: workDir, env: ctx.childEnv });

  const instanceId = probeInstanceId(spec.tool);
  const target = { worktreeId: PROBE_WORKTREE_ID, cliToolId: spec.cliToolId, instanceId };
  // The production order: port and password first, the launch line from both.
  const serverPort = spec.server ? await reserveProbeServer(target, workDir) : null;
  const plan = source.prepareLaunch({
    target,
    executablePath: spec.executable,
    worktreePath: workDir,
  });
  const rendered = renderAgentLaunchCommand(plan);
  if (spec.server) {
    const line = evaluateOpencodeV2LaunchLine(rendered);
    if (!line.ok || serverPort === null) {
      const reason = line.ok ? 'ポートを確保できなかった' : line.reason;
      ctx.log(`${spec.tool}: ${reason}`);
      await releaseProbeServer(target);
      const failed = (['hook-correlation', ...screens] as const).filter(ctx.selected);
      for (const checkId of failed) {
        checks.push({
          checkId,
          status: 'fail',
          summary: `期待: 本番と同じ launch.sh 経由の起動行。実際: ${reason}（本番と違う経路のため確認しない）`,
        });
      }
      return { version, checks };
    }
  }
  const command = buildProbeLaunchCommand(spec, rendered, workDir);
  ctx.log(`${spec.tool}: launching — ${command}`);

  let recorder: ServerEventRecorder | null = null;
  try {
    await session.start(command, workDir);
    // Before the idle screen: the TUI only starts once launch.sh saw the
    // server answer, so this also keeps waitForStartup from taking the blank
    // pane of a server still booting for the idle screen.
    if (serverPort !== null) recorder = await recordServerEvents(target, serverPort);
    const idle = await session.waitForStartup();
    session.recordScreen('screen-idle', idle.verdict, idle.frame);

    let turns = 0;
    let approvalJudged = false;
    if (ctx.selected('screen-running')) {
      approvalJudged = await session.runningTurn();
      turns++;
    }
    if (ctx.selected('screen-approval') && !approvalJudged) {
      if (spec.approval.via === 'none') {
        session.record({
          checkId: 'screen-approval',
          status: 'skip',
          summary: '承認ダイアログを出さないツール',
          skipReason: spec.approval.skipReason ?? `${spec.tool} は承認ダイアログを出さない`,
        });
      } else {
        await session.approvalTurn(spec.prompts.approval);
        turns++;
      }
    }
    if (ctx.selected('screen-quoted-dialog')) {
      await session.quotedTurn();
      turns++;
    }
    if ((wantHooks || wantSse) && turns === 0) await session.plainTurn();
  } catch (error) {
    const timedOut = error instanceof DeadlineExceeded;
    const reason = timedOut
      ? '時間切れ（--timeout-per-tool または全体の上限）'
      : `実行中の異常: ${error instanceof Error ? error.message : String(error)}`;
    ctx.log(`${spec.tool}: ${reason}`);
    for (const checkId of screens) {
      if (!session.checks.has(checkId)) {
        session.record({
          checkId,
          status: 'fail',
          summary: `期待: 確認を最後まで行う。実際: ${reason}`,
          evidence: paneEvidence(session.lastFrame),
        });
      }
    }
  } finally {
    // Closed first, so the server going away with the session is not taken
    // for a broken stream.
    await recorder?.stop();
    await ctx.tmux.killSession(session.name);
    await sleep(HOOK_GRACE_MS);
  }

  if (serverPort !== null) {
    if (wantSse) {
      const verdict = evaluateServerEvents(recorder?.events ?? [], {
        window: session.runningWindow ?? undefined,
        streamError: recorder?.error ?? null,
      });
      session.record({ checkId: 'hook-correlation', ...verdict });
    }
    const leftovers = await collectServerLeftovers(serverPort);
    await releaseProbeServer(target);
    const leftover = evaluateServerLeftovers(leftovers);
    if (leftover) {
      // Like the production-log leak in main.ts: reported whether or not the
      // check was selected, because the run itself left something behind.
      ctx.log(`${spec.tool}: ${leftover.summary}`);
      session.checks.set('hook-correlation', { checkId: 'hook-correlation', ...leftover });
    }
  }

  if (wantHooks) {
    const verdict = evaluateHookCorrelation(ctx.listener.forTool(spec.tool), {
      tool: spec.tool,
      worktreeId: PROBE_WORKTREE_ID,
      instanceId,
      expectedEvents: expectedHookEvents(source.capabilities.supportedEvents),
    });
    session.record({ checkId: 'hook-correlation', ...verdict });
  }

  return { version, checks: [...checks, ...session.checks.values()] };
}
