/**
 * Which {@link PromptObservationKind} a frame is (Issue #3755).
 *
 * Reading is delegated to the tool's own readers — agy's numbered-dialog reader
 * (`detection/tools/antigravity/dialog.ts`, the one every producer of agy's
 * `multiple_choice` prompt uses) and its arrow-screen reader
 * (`detection/tools/antigravity/screens.ts`), plus agy 1.4's `/model` picker
 * (`./antigravity-model-picker`, Issue #3797). What this module owns is the
 * mapping onto the observation's own kinds, and the rule that a screen no
 * measured reader names is `unknown` — never a measured kind, and never
 * "nothing is asking" while the status layer says something is.
 *
 * The status layer's flags are read for exactly one thing: whether SOMETHING
 * waits on a human. Their reason (`antigravity_selection_list`, …) is never
 * mapped to a kind.
 *
 * @module lib/prompt-observation/classify
 */

import { stripAnsi, stripBoxDrawing, isAntigravityNumberedDialog } from '@/lib/detection/cli-patterns';
import { detectAntigravityNumberedDialogPrompt } from '@/lib/detection/tools/antigravity/dialog';
import { ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN } from '@/lib/detection/tools/antigravity/patterns';
import {
  readAntigravityArrowScreen,
  type AntigravityArrowScreenKind,
} from '@/lib/detection/tools/antigravity/screens';
import { isAnswerablePromptData, type LivePromptData } from '@/types/models';
import { readAntigravityModelPicker } from './antigravity-model-picker';
import type { PromptObservationKind } from './kinds';

/** The fields of a `current-output` payload the classification reads. */
export interface ScreenSnapshot {
  cliToolId: string;
  /** The frame the status was judged on, ANSI included. */
  fullOutput?: string;
  sessionStatus: string;
  isPromptWaiting?: boolean;
  promptData?: LivePromptData | null;
  isSelectionListActive?: boolean;
  isPagerActive?: boolean;
  isDismissablePanelActive?: boolean;
  isUnclassifiedActive?: boolean;
}

/** What {@link classifyScreen} read off the frame. */
export interface ClassifiedScreen {
  kind: PromptObservationKind;
  question: string | null;
  approvalTarget: string | null;
  options: string[];
  /** Index into {@link options} of the highlighted row, or -1. */
  selectedIndex: number;
}

const ARROW_SCREEN_KIND: Record<AntigravityArrowScreenKind, PromptObservationKind> = {
  trust: 'antigravity-trust',
  'model-picker': 'antigravity-model-picker',
  'slash-menu': 'antigravity-slash-menu',
};

const EMPTY: Omit<ClassifiedScreen, 'kind'> = {
  question: null,
  approvalTarget: null,
  options: [],
  selectedIndex: -1,
};

/**
 * The footer every measured agy permission dialog ends on: `↑/↓ Navigate ·
 * tab Amend · f full diff` (file creation), `… · tab Amend · ctrl+g
 * edit/expand command[ · ctrl+r Review]` (command execution)
 * (`tests/fixtures/antigravity-live-2364/dialog-*.txt`).
 */
const PERMISSION_FOOTER_PATTERN = /↑\/↓\s*Navigate\s*·\s*tab Amend\b/;

/** Whether the last `↑/↓ Navigate` row of the frame is a permission dialog's footer. */
function hasPermissionFooter(text: string): boolean {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ANTIGRAVITY_NAVIGATE_FOOTER_PATTERN.test(lines[i])) return PERMISSION_FOOTER_PATTERN.test(lines[i]);
  }
  return false;
}

/** agy's measured screens, or null when the frame is none of them. */
function classifyAntigravity(frame: string): ClassifiedScreen | null {
  const text = stripAnsi(frame);

  // The numbered dialog first, as `detect.ts` reads it: a frame that passes
  // the structural test and still fails to read is `unknown`, not a picker.
  const boxless = stripBoxDrawing(text);
  if (isAntigravityNumberedDialog(boxless)) {
    // Every measured permission dialog ends on a `tab Amend` footer; agy's
    // numbered login-method screen (`↑/↓ Navigate · enter Select`, Issue
    // #3797) passes the structural test too and is not one.
    if (!hasPermissionFooter(boxless)) return { kind: 'unknown', ...EMPTY };
    const detected = detectAntigravityNumberedDialogPrompt(boxless);
    const prompt = detected?.promptData;
    if (prompt?.type !== 'multiple_choice') return { kind: 'unknown', ...EMPTY };
    return {
      kind: 'antigravity-permission',
      question: prompt.question,
      approvalTarget: prompt.approvalTarget ?? null,
      options: prompt.options.map(option => option.label),
      selectedIndex: prompt.options.findIndex(option => option.isDefault),
    };
  }

  const arrow = readAntigravityArrowScreen(text);
  if (arrow === null) {
    // agy 1.4's picker (search box over the models, Issue #3797), read by
    // its whole shape only: anything short of it stays unmeasured.
    const picker = readAntigravityModelPicker(text);
    if (picker === null) return null;
    return {
      kind: 'antigravity-model-picker',
      question: picker.question,
      approvalTarget: null,
      options: [...picker.options],
      selectedIndex: picker.selectedIndex,
    };
  }
  return {
    kind: ARROW_SCREEN_KIND[arrow.screen],
    question: arrow.question,
    approvalTarget: arrow.approvalTarget,
    options: [...arrow.options],
    selectedIndex: arrow.selectedIndex,
  };
}

/** Whether the status layer says something on the frame waits on a human. */
function somethingWaits(snapshot: ScreenSnapshot): boolean {
  return Boolean(
    snapshot.isPromptWaiting ||
      snapshot.isSelectionListActive ||
      snapshot.isPagerActive ||
      snapshot.isDismissablePanelActive ||
      snapshot.isUnclassifiedActive
  );
}

/**
 * What the parsed prompt says, for an `unknown` screen: shown so a human can
 * read it, never promoted to a kind.
 */
function fromPromptData(promptData: LivePromptData | null | undefined): Omit<ClassifiedScreen, 'kind'> {
  if (!isAnswerablePromptData(promptData)) return EMPTY;
  const approvalTarget = promptData.approvalTarget ?? null;
  if (promptData.type === 'yes_no') {
    return {
      question: promptData.question,
      approvalTarget,
      options: [...promptData.options],
      selectedIndex: promptData.defaultOption ? promptData.options.indexOf(promptData.defaultOption) : -1,
    };
  }
  return {
    question: promptData.question,
    approvalTarget,
    options: promptData.options.map(option => option.label),
    selectedIndex: promptData.options.findIndex(option => option.isDefault),
  };
}

/**
 * Classify one frame.
 *
 * Order: a measured reader of the tool → `unknown` when the status layer says
 * something waits (a flag, or a `waiting` status with no flag set) → `composer`
 * when the agent is at its input box (`ready`) → `none`.
 */
export function classifyScreen(snapshot: ScreenSnapshot): ClassifiedScreen {
  if (snapshot.cliToolId === 'antigravity' && snapshot.fullOutput) {
    const measured = classifyAntigravity(snapshot.fullOutput);
    if (measured !== null) return measured;
  }
  // `waiting` with every flag false is still something waiting on a human:
  // never "nothing asks".
  if (somethingWaits(snapshot) || snapshot.sessionStatus === 'waiting') return { kind: 'unknown', ...fromPromptData(snapshot.promptData) };
  if (snapshot.sessionStatus === 'ready') return { kind: 'composer', ...EMPTY };
  return { kind: 'none', ...EMPTY };
}
