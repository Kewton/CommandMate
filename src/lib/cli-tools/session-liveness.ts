/**
 * The tmux round trip behind "did the tool exit?" (Issue #2070).
 *
 * Split from `lib/detection/tool-liveness`, which holds the rule and is pure,
 * for the boundary §4 D4 draws: the detection layer never talks to a transport,
 * and `src/lib/cli-tools/**` is one of the two places that may (`.eslintrc.json`
 * `no-restricted-imports`). Putting the probe here is also what lets
 * `BaseCLITool` use it without a cycle — the tool layer owns both the
 * declaration and the reading of its own pane.
 *
 * @module lib/cli-tools/session-liveness
 */

import { capturePane } from '../tmux/tmux';
import { judgeToolLiveness } from '../detection/tool-liveness';
import { resolveLivenessSpec } from './liveness-spec';
import type { ToolLivenessSpec, ToolLivenessVerdict } from '../../types/cli-tool-contracts';
import type { CLIToolType } from './types';

/**
 * Capture the bottom of a pane and decide whether the tool is still on it.
 *
 * Never throws. A capture that fails is handed to the spec as an unreadable
 * frame, which claude has always called unhealthy (`capture error`) and every
 * tool added by this Issue calls alive — see
 * {@link ToolLivenessSpec.unreadableIsExited} for why the two answers differ.
 *
 * @param sessionName - tmux session name
 * @param spec - The tool's liveness declaration
 * @returns Whether the tool is there, and — when it is not — why not
 */
export async function probeSessionLiveness(
  sessionName: string,
  spec: ToolLivenessSpec
): Promise<ToolLivenessVerdict> {
  let output: unknown;
  try {
    output = await capturePane(sessionName, { startLine: -spec.probeCaptureLines });
  } catch {
    output = undefined;
  }
  // `unknown` and re-checked rather than trusting the declared `Promise<string>`:
  // this function's contract is that it never throws, and a transport that hands
  // back a non-string (a stub, a JavaScript caller) must reach the spec's
  // unreadable branch rather than a TypeError inside `stripAnsi`.
  if (typeof output !== 'string') {
    return spec.unreadableIsExited
      ? { alive: false, reason: 'capture error' }
      : { alive: true };
  }
  return judgeToolLiveness(output, spec);
}

/**
 * {@link probeSessionLiveness} for a tool named by id.
 *
 * The entry point for callers that hold a `CLIToolType` and must not
 * instantiate the tool graph to ask one question — `worktree-status-helper`'s
 * status poll is the reason it exists, exactly as `resolveCaptureSpec` is.
 *
 * @param sessionName - tmux session name
 * @param cliToolId - CLI tool identifier
 * @returns Whether the tool is there, and — when it is not — why not
 */
export async function probeToolSessionLiveness(
  sessionName: string,
  cliToolId: CLIToolType
): Promise<ToolLivenessVerdict> {
  return probeSessionLiveness(sessionName, resolveLivenessSpec(cliToolId));
}
