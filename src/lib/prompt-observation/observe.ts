/**
 * One prompt observation, assembled (Issue #3755).
 *
 * Pure: the route gathers the inputs (the `current-output` payload of one
 * capture, the session generation, the contract policy) and this module turns
 * them into the {@link PromptObservation} payload. Kept pure so every rule
 * below is pinned by a unit test rather than by a live pane.
 *
 * ## The two Auto-Yes items, kept apart (#3746 Q7)
 *
 * `pollerRecord` is what the poller (or the permission hook) last recorded as
 * withheld, with its age — and with how it relates to THIS screen, which is
 * `unknown` unless it can be shown not to be about it. `contractEvaluation` is
 * the contract's policy evaluated now against the screen. `wait` reads a record
 * under a minute old as "the reason this prompt is unanswered" from its time
 * alone; neither item here says that, and a missing record is published as a
 * missing record — not as "Auto-Yes can answer".
 *
 * @module lib/prompt-observation/observe
 */

import type { CurrentOutputPayload } from '@/lib/session/current-output-types';
import { resolveAutoAnswerWithPolicy, type AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';
import { derivePromptView } from '@/lib/session/prompt-view';
import { isAnswerablePromptData } from '@/types/models';
import { classifyScreen, type ClassifiedScreen } from './classify';
import { isDecisionKind, PROMPT_OBSERVATION_SCHEMA_VERSION } from './kinds';
import { issueObservationToken, observationTokenExpiresAt, type ObservationTokenBinding } from './token';
import type {
  PollerRecordScreenCorrelation,
  PromptObservation,
  PromptObservationAnswerVia,
  PromptObservationContract,
  PromptObservationContractEvaluation,
  PromptObservationPollerRecord,
  PromptObservationScreen,
} from './types';

/** The `current-output` fields an observation reads. */
export type ObservationPayload = Pick<
  CurrentOutputPayload,
  | 'isRunning'
  | 'sessionName'
  | 'sessionStatus'
  | 'sessionStatusReason'
  | 'fullOutput'
  | 'isPromptWaiting'
  | 'promptData'
  | 'promptView'
  | 'isSelectionListActive'
  | 'isPagerActive'
  | 'isDismissablePanelActive'
  | 'isUnclassifiedActive'
  | 'startingSince'
  | 'autoYes'
  | 'serverPollerActive'
>;

/** Everything one observation is built from. */
export interface ObservationInput {
  worktreeId: string;
  cliToolId: string;
  /** The resolved instance; the primary's is its tool id. */
  instanceId: string;
  resolvedBy: string | null;
  payload: ObservationPayload;
  sessionGeneration: number | null;
  /** The contract governing the instance, as the poller's policy cache reads it. */
  contract: { policy: AutoYesPolicy | null; taskId: string | null };
  now: number;
}

/** The token binding of an observed screen — what #3756 rebuilds to verify a token. */
export function observationTokenBinding(
  input: Pick<ObservationInput, 'worktreeId' | 'cliToolId' | 'instanceId' | 'sessionGeneration'> & {
    sessionName: string;
  },
  screen: Pick<ClassifiedScreen, 'kind' | 'question' | 'options' | 'approvalTarget'>
): ObservationTokenBinding {
  return {
    worktreeId: input.worktreeId,
    cliToolId: input.cliToolId,
    instanceId: input.instanceId,
    sessionName: input.sessionName,
    sessionGeneration: input.sessionGeneration,
    kind: screen.kind,
    question: screen.question,
    options: screen.options,
    approvalTarget: screen.approvalTarget,
  };
}

/** How the screen is answered today; `none` when nothing asks. */
function answerViaFor(classified: ClassifiedScreen, payload: ObservationPayload): PromptObservationAnswerVia {
  if (!isDecisionKind(classified.kind)) return 'none';
  // agy's arrow screens are published as selection lists: no prompt, so
  // `respond` has nothing to answer and a human drives them at the pane.
  const view = payload.promptView ?? derivePromptView(payload.promptData ?? null);
  if (view?.kind === 'screen-choices') return 'screen';
  if (view?.kind === 'api-choices') return 'api';
  return 'terminal';
}

function correlate(
  promptType: string,
  classified: ClassifiedScreen,
  payload: ObservationPayload
): PollerRecordScreenCorrelation {
  if (!isDecisionKind(classified.kind)) return 'no-prompt-on-screen';
  if (isAnswerablePromptData(payload.promptData) && payload.promptData.type !== promptType) {
    return 'type-mismatch';
  }
  // Same type, or a screen with no parsed prompt to compare with: the record
  // names no screen, so nothing ties it to this one.
  return 'unknown';
}

function pollerRecordOf(
  payload: ObservationPayload,
  classified: ClassifiedScreen,
  now: number
): PromptObservationPollerRecord | null {
  const record = payload.autoYes?.lastSuppression;
  if (!record) return null;
  return {
    reason: record.reason,
    mode: record.mode,
    promptType: record.promptType,
    ...(record.pattern !== undefined && { pattern: record.pattern }),
    at: record.at,
    // A negative age is clock skew, not a record from the future.
    ageSeconds: Math.max(0, Math.round((now - record.at) / 1000)),
    screenCorrelation: correlate(record.promptType, classified, payload),
  };
}

function evaluateContract(
  input: ObservationInput,
  classified: ClassifiedScreen | null
): PromptObservationContractEvaluation {
  const { policy, taskId } = input.contract;
  const contract: PromptObservationContract | null = policy ? { taskId, mode: policy.mode } : null;
  if (classified === null) return { state: 'not-evaluated', because: 'session-not-running', contract };

  const promptData = input.payload.promptData;
  if (!isDecisionKind(classified.kind) || !isAnswerablePromptData(promptData)) {
    return { state: 'not-evaluated', because: 'no-parsed-prompt', contract };
  }
  const resolution = resolveAutoAnswerWithPolicy(promptData, policy);
  if (resolution.suppressedBy !== null) {
    return {
      state: 'policy-withholds',
      reason: resolution.suppressedBy,
      ...(resolution.pattern !== undefined && { pattern: resolution.pattern }),
      contract,
    };
  }
  if (resolution.answer === null) return { state: 'no-base-answer', contract };
  return { state: 'policy-permits', contract };
}

/** Build one observation. */
export function buildPromptObservation(input: ObservationInput): PromptObservation {
  const { payload, now } = input;
  const target = {
    worktreeId: input.worktreeId,
    cliToolId: input.cliToolId,
    instanceId: input.instanceId,
    sessionName: payload.sessionName,
    resolvedBy: input.resolvedBy,
  };
  const session = {
    running: payload.isRunning,
    starting: typeof payload.startingSince === 'number',
    generation: input.sessionGeneration,
  };

  const classified = payload.isRunning
    ? classifyScreen({
        cliToolId: input.cliToolId,
        fullOutput: payload.fullOutput,
        sessionStatus: payload.sessionStatus,
        isPromptWaiting: payload.isPromptWaiting,
        promptData: payload.promptData,
        isSelectionListActive: payload.isSelectionListActive,
        isPagerActive: payload.isPagerActive,
        isDismissablePanelActive: payload.isDismissablePanelActive,
        isUnclassifiedActive: payload.isUnclassifiedActive,
      })
    : null;

  let screen: PromptObservationScreen | null = null;
  if (classified !== null) {
    const token = isDecisionKind(classified.kind)
      ? issueObservationToken(
          observationTokenBinding({ ...input, sessionName: payload.sessionName }, classified),
          now
        )
      : null;
    screen = {
      kind: classified.kind,
      token,
      tokenExpiresAt: token === null ? null : observationTokenExpiresAt(now),
      question: classified.question,
      approvalTarget: classified.approvalTarget,
      options: classified.options.map((label, index) => ({ position: index + 1, label })),
      selectedPosition: classified.selectedIndex >= 0 ? classified.selectedIndex + 1 : null,
      answerVia: answerViaFor(classified, payload),
      sessionStatus: payload.sessionStatus,
      sessionStatusReason: payload.sessionStatusReason,
    };
  }

  const autoYes = payload.autoYes;
  return {
    schemaVersion: PROMPT_OBSERVATION_SCHEMA_VERSION,
    observedAt: now,
    target,
    session,
    status: classified === null ? 'unavailable' : 'observed',
    unavailableReason: classified === null ? 'session-not-running' : null,
    screen,
    autoYes: {
      enabled: autoYes ? autoYes.enabled : null,
      expiresAt: autoYes?.expiresAt ?? null,
      stopReason: autoYes?.stopReason ?? null,
      pollerActive: typeof payload.serverPollerActive === 'boolean' ? payload.serverPollerActive : null,
      pollerRecord: classified === null ? null : pollerRecordOf(payload, classified, now),
      contractEvaluation: evaluateContract(input, classified),
    },
  };
}
