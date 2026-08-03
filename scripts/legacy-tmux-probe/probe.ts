/**
 * Issue #1641: run the REAL reading-mode code against a REAL old tmux.
 *
 * #1623 shipped a `display-popup` capability probe and covered both of its
 * branches with mocked return values. A mock cannot tell you whether the probe
 * asks tmux the right question, so the acceptance item "no-op on tmux < 3.2"
 * stayed unverified. This entry point exists to answer it by execution: it is
 * bundled with esbuild and run INSIDE a container whose tmux is older than 3.2
 * (see `scripts/verify-legacy-tmux-readmode.sh`).
 *
 * Everything it measures comes from `src/lib/tmux/`, never from a re-typed
 * paraphrase — importing the shipped functions is the whole point.
 *
 * ## Isolation
 *
 * The production modules take no socket argument, so they follow `$TMUX`. The
 * harness points `$TMUX` at a `-L` private server and this probe REFUSES TO RUN
 * unless that redirect is in place and names the expected socket. That check is
 * the container-side half of the rule in
 * `tests/unit/config/tmux-live-test-safety.test.ts`; the host never runs tmux at
 * all (the docker container does).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync } from 'fs';
import {
  DEFAULT_READ_MODE_KEY,
  buildBindKeyArgs,
  getPagerScriptPath,
  initReadMode,
  quoteForTmuxCommand,
  readExistingBinding,
  reconcileReadModeBinding,
  supportsDisplayPopup,
} from '@/lib/tmux/read-mode';
import { capturePane } from '@/lib/tmux/tmux';
import { squeezeTranscript } from '@/lib/tmux/transcript-squeeze';
import { TUI_PANE_HEIGHT } from '@/config/tmux-pane-config';

const execFileAsync = promisify(execFile);

/** Raw outcome of one tmux invocation, recorded verbatim as evidence. */
interface RawRun {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Everything one container run measured; serialized to JSON for the harness. */
interface ProbeReport {
  tmuxVersion: string;
  socketRedirect: string;
  /** `tmux list-commands display-popup` exactly as the probe issues it. */
  listCommandsDisplayPopup: RawRun;
  /** Same call for a command that exists in every tmux, to expose usage errors. */
  listCommandsCapturePane: RawRun;
  /** The conflict check's own tmux call, recorded because it can degrade too. */
  listKeysPrefixKey: RawRun;
  supportsDisplayPopup: boolean;
  bindingBefore: string | undefined;
  reconcile: { installed: boolean; outcome: string; key: string; detail?: string };
  bindingAfter: string | undefined;
  /** What `prefix+g` would have run, executed directly to show the damage avoided. */
  displayPopupDirect: RawRun;
  /** Plan B: `capture --pane` reads the same session without any popup. */
  planB: {
    ok: boolean;
    error?: string;
    rawLines: number;
    squeezedLines: number;
    /** Proof the capture is the session's content, not an empty frame. */
    containsMarker: boolean;
    tailSample: string[];
  };
}

/** Run tmux and keep the failure, because a non-zero exit IS the measurement. */
async function runTmux(argv: string[]): Promise<RawRun> {
  try {
    const { stdout, stderr } = await execFileAsync('tmux', argv, { timeout: 10000 });
    return { argv, exitCode: 0, stdout, stderr };
  } catch (error: unknown) {
    const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      argv,
      exitCode: typeof e.code === 'number' ? e.code : -1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}

async function main(): Promise<void> {
  const [reportPath, sessionName, expectedSocket, marker] = process.argv.slice(2);
  if (!reportPath || !sessionName || !expectedSocket || !marker) {
    throw new Error('usage: probe <report.json> <session-name> <expected-socket> <marker>');
  }

  // Isolation assert, not a formality: without it every tmux call below would
  // land on whatever server the ambient environment happens to point at.
  const tmuxEnv = process.env.TMUX ?? '';
  if (!tmuxEnv.split(',')[0].endsWith(expectedSocket)) {
    throw new Error(`TMUX must be redirected to ${expectedSocket}, got "${tmuxEnv}"`);
  }

  const version = await runTmux(['-V']);
  const listPopup = await runTmux(['list-commands', 'display-popup']);
  const listCapture = await runTmux(['list-commands', 'capture-pane']);

  const listKeys = await runTmux(['list-keys', '-T', 'prefix', DEFAULT_READ_MODE_KEY]);

  const supported = await supportsDisplayPopup();
  const bindingBefore = await readExistingBinding(DEFAULT_READ_MODE_KEY);

  // The shipped startup path, logging included — the "no-op reason in the log"
  // half of the acceptance item comes from initReadMode's own logger line.
  const status = await initReadMode();
  const reconciled = await reconcileReadModeBinding(); // idempotency, second pass
  const bindingAfter = await readExistingBinding(DEFAULT_READ_MODE_KEY);

  // Execute the popup command the binding would have fired, with the pager
  // replaced by /bin/true. No client is attached, so this fails everywhere — but
  // it fails DIFFERENTLY, and the difference is the evidence: `unknown command`
  // on < 3.2 (the user-visible false-positive symptom) versus a client/target
  // complaint on 3.2+, which only a tmux that HAS the command can produce.
  const quoted = quoteForTmuxCommand(getPagerScriptPath()) ?? "''";
  const popupArgs = buildBindKeyArgs(DEFAULT_READ_MODE_KEY, quoted);
  const popupCommand = popupArgs[popupArgs.length - 1].split(' ');
  const displayPopupDirect = await runTmux([...popupCommand.slice(0, -1), '/bin/true']);

  const planB: ProbeReport['planB'] = {
    ok: false,
    rawLines: 0,
    squeezedLines: 0,
    containsMarker: false,
    tailSample: [],
  };
  try {
    const raw = await capturePane(sessionName, TUI_PANE_HEIGHT);
    const squeezed = squeezeTranscript(raw, { tail: 5 });
    planB.ok = true;
    planB.rawLines = raw === '' ? 0 : raw.split('\n').length;
    planB.squeezedLines = squeezeTranscript(raw).lines;
    planB.containsMarker = raw.includes(marker);
    planB.tailSample = squeezed.text.split('\n');
  } catch (error: unknown) {
    planB.error = error instanceof Error ? error.message : String(error);
  }

  const report: ProbeReport = {
    tmuxVersion: version.stdout.trim(),
    socketRedirect: tmuxEnv,
    listCommandsDisplayPopup: listPopup,
    listCommandsCapturePane: listCapture,
    listKeysPrefixKey: listKeys,
    supportsDisplayPopup: supported,
    bindingBefore,
    reconcile: {
      installed: status.installed,
      outcome: status.outcome,
      key: status.key,
      detail: status.detail,
    },
    bindingAfter,
    displayPopupDirect,
    planB,
  };

  // A second reconcile must converge: same outcome, or `installed` settling into
  // `already-installed`. Anything else means restarting the server churns the
  // user's global key table.
  const converged =
    reconciled.outcome === status.outcome ||
    (status.outcome === 'installed' && reconciled.outcome === 'already-installed');
  if (!converged) {
    report.reconcile.detail = `NON-IDEMPOTENT: second pass gave ${reconciled.outcome}`;
  }

  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  // Echo back so the harness log carries the evidence even if the file is lost.
  process.stdout.write(readFileSync(reportPath, 'utf-8') + '\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`probe failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
