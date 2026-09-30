/**
 * The Auto-Yes dialog gate for OpenCode V2 (Issue #2984).
 *
 * The screen path runs for v2 like for every tool: `pollAutoYes` captures the
 * pane and `detectAndRespondToPrompt` reads it with `detectPromptOnCleanFrame`,
 * whose generic parser gets v2's default options (`requireDefaultIndicator:
 * true`). A reply that quotes a dialog — `❯ 1. Yes / 2. No` — satisfies that
 * parser, and under `legacy` Auto-Yes typed `1` + Enter into the composer for it:
 * #1896 on v2. These frames were captured from opencode2 2.0.18
 * (`tests/fixtures/opencode-v2-dialogs-2984/README.md`).
 *
 * The two properties, as in `auto-yes-dialog-gate.test.ts`:
 *
 *  1. **It stops the quoted list** — refused through the gate, and only
 *     because of it (the kill switch puts the answer back).
 *  2. **It takes nothing away** — none of v2's own dialogs, live, is a
 *     candidate of the screen path at all, so no answer the poller could send
 *     before is withheld now. They are answered over the API (#2945 / #2951).
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import {
  AUTO_YES_DIALOG_GATE_ENV_VAR,
  assessPromptAnswerability,
  evaluateAutoYesDialogGate,
  evaluateDialogPresence,
  resolveAutoYesDialogGateMode,
} from '@/lib/polling/auto-yes-dialog-gate';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const DIR_2984 = path.join(FIXTURES, 'opencode-v2-dialogs-2984');

function read(dir: string, name: string): string {
  return fs.readFileSync(path.join(dir, `${name}.txt`), 'utf8');
}

/** What `capturePollerFrame` hands `detectAndRespondToPrompt` as `cleanOutput`. */
function asAutoYesSees(raw: string): string {
  return stripBoxDrawing(stripAnsi(raw));
}

/** The poller's own reading of a frame (`detectAndRespondToPrompt` step 1). */
function pollerReads(raw: string) {
  return detectPromptOnCleanFrame(asAutoYesSees(raw), 'opencode-v2', undefined, raw);
}

const originalEnv = process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];

beforeEach(() => {
  delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[AUTO_YES_DIALOG_GATE_ENV_VAR];
  else process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = originalEnv;
});

describe('[#2984] a v2 reply that quotes a dialog is not answered', () => {
  it('ships enforced', () => {
    expect(resolveAutoYesDialogGateMode('opencode-v2')).toBe('enforce');
  });

  it('is a multiple_choice candidate of the poller, so the path really runs', () => {
    // Non-vacuity: without this the refusal below would prove nothing.
    const detection = pollerReads(read(DIR_2984, 'quoted-dialog-reply'));
    expect(detection.isPrompt).toBe(true);
    expect(detection.promptData?.type).toBe('multiple_choice');
  });

  it('is refused by the gate', () => {
    const verdict = evaluateAutoYesDialogGate(
      'opencode-v2',
      'multiple_choice',
      asAutoYesSees(read(DIR_2984, 'quoted-dialog-reply')),
    );
    expect(verdict).toMatchObject({ allowed: false, gated: true, dialog: null, mode: 'enforce' });
  });

  it('would have been answered under legacy, which is what the kill switch restores', () => {
    process.env[AUTO_YES_DIALOG_GATE_ENV_VAR] = 'opencode-v2=legacy';
    const verdict = evaluateAutoYesDialogGate(
      'opencode-v2',
      'multiple_choice',
      asAutoYesSees(read(DIR_2984, 'quoted-dialog-reply')),
    );
    expect(verdict).toMatchObject({ allowed: true, gated: false });
  });

  it('is refused by `/prompt-response` as no prompt, rather than typed into the composer', () => {
    const assessment = assessPromptAnswerability('opencode-v2', read(DIR_2984, 'quoted-dialog-reply'));
    expect(assessment.promptCheck.isPrompt).toBe(true);
    expect(assessment.refusal?.reason).toBe('prompt_no_longer_active');
  });
});

describe('[#2984] enforcing takes nothing away from v2', () => {
  // Every live v2 frame in the repository: #2945's approval and question,
  // #2971's dialogs, and this Issue's captures.
  const LIVE: ReadonlyArray<readonly [string, string]> = [
    ...['opencode-v2-live-2945', 'opencode-v2-live-2971', 'opencode-v2-dialogs-2984'].flatMap(dir =>
      fs
        .readdirSync(path.join(FIXTURES, dir))
        .filter(file => file.endsWith('.txt'))
        .sort()
        .map(file => [dir, file.replace(/\.txt$/, '')] as const),
    ),
  ];

  it('covers the dialogs', () => {
    const ids = LIVE.map(([dir, name]) => `${dir}/${name}`);
    for (const id of [
      'opencode-v2-live-2945/permission-required',
      'opencode-v2-live-2945/question',
      'opencode-v2-live-2971/select-model',
      'opencode-v2-dialogs-2984/permission',
      'opencode-v2-dialogs-2984/question',
      'opencode-v2-dialogs-2984/commands',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('finds exactly one frame the poller would answer: the quoted dialog', () => {
    // So no v2 dialog was ever answered through this path, and the gate cannot
    // have taken such an answer away.
    const candidates = LIVE.filter(([dir, name]) => pollerReads(read(path.join(FIXTURES, dir), name)).isPrompt).map(
      ([dir, name]) => `${dir}/${name}`,
    );
    expect(candidates).toEqual(['opencode-v2-dialogs-2984/quoted-dialog-reply']);
  });
});

describe('[#2984] controls, composed outside the repository', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-2984-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** The quoted reply with the live approval strip's bottom rows put under it. */
  function composeStripUnderQuotedReply(): string {
    const reply = read(DIR_2984, 'quoted-dialog-reply').replace(/\n+$/, '').split('\n');
    const strip = read(DIR_2984, 'permission').replace(/\n+$/, '').split('\n');
    const stripRow = strip.findIndex(row => /Allow once {2,}Always allow/.test(row));
    const composed = [...reply, ...strip.slice(stripRow - 1, stripRow + 2)].join('\n');
    const file = path.join(tmp, 'strip-under-quoted-reply.txt');
    fs.writeFileSync(file, composed);
    return fs.readFileSync(file, 'utf8');
  }

  it('negative control: the quoted reply alone is no dialog, as captured', () => {
    const raw = read(DIR_2984, 'quoted-dialog-reply');
    fs.writeFileSync(path.join(tmp, 'quoted.txt'), raw);
    const copy = fs.readFileSync(path.join(tmp, 'quoted.txt'), 'utf8');
    expect(evaluateDialogPresence('opencode-v2', 'multiple_choice', copy)).toMatchObject({
      present: false,
      dialog: null,
      gated: true,
    });
  });

  it('positive control: the same reply with the approval strip open under it IS a dialog, and still gets no digit', () => {
    const composed = composeStripUnderQuotedReply();

    // Presence reads the capture as captured: the strip is there.
    const presence = evaluateDialogPresence('opencode-v2', 'multiple_choice', composed);
    expect(presence.present).toBe(true);
    expect(presence.dialog).toMatchObject({ kind: 'permission', answerMode: 'keys' });

    // A digit does nothing to the strip (measured: permission-after-digit), so
    // Auto-Yes still sends nothing; the approval goes over the API.
    expect(
      evaluateAutoYesDialogGate('opencode-v2', 'multiple_choice', asAutoYesSees(composed)).allowed,
    ).toBe(false);
  });

  it('positive control: the question form is vouched for as a digit-answered dialog', () => {
    const raw = read(DIR_2984, 'question-under-quoted-dialog');
    fs.writeFileSync(path.join(tmp, 'question.txt'), raw);
    const copy = fs.readFileSync(path.join(tmp, 'question.txt'), 'utf8');

    const presence = evaluateDialogPresence('opencode-v2', 'multiple_choice', copy);
    expect(presence).toMatchObject({ present: true, gated: true });
    expect(presence.dialog).toMatchObject({ kind: 'question', answerMode: 'numbered', submitMode: 'answer_only' });
  });
});
