/**
 * Reading OpenCode V2's approvals and questions (Issue #2945, Epic #2370
 * Phase 2).
 *
 * The v2 counterpart of `../opencode/payloads`: both shapes are parsed into
 * the vocabulary the tool-independent layers already speak
 * ({@link PermissionRequestPayload}, {@link AskUserQuestionSpec},
 * {@link PendingDecision}), so the adjudicator, `agent-event-state`, the
 * `/respond` route and `commandmate respond` need no v2 branch.
 *
 * ## Approvals (`permission.asked`, `Permission.Request`)
 *
 * Measured on 2.0.18 (#2370 Phase 0): `{id: "per_…", sessionID, action,
 * resources, save, metadata: {files: [{file, patch, status, additions,
 * deletions}]}, source}`. Unlike v1 the approval names what it is for — the
 * `action` (`edit`, `shell`, …) — so there is no tool-call correlation table
 * here. And it carries the diff, which is what the approval card shows
 * ({@link describeOpencodeV2Permission}).
 *
 * ## Questions (`form.created`, `Form.Info`)
 *
 * `form.created` carries the form under `data.form` (measured on 2.0.18); the
 * list endpoints answer it bare. Either way it is
 * `{id: "frm_…", sessionID, title, metadata: {kind: "question"}, fields:
 * [{key, title, description, type, options: [{value, label, description}],
 * custom}]}`. One field is one question. A field is representable as a
 * question with choices when it offers options (`string` with `options`,
 * `multiselect`) or is a `boolean` (two synthesised choices); a form with any
 * other visible field (a bare number, a free-text string, an external link) is
 * not parsed, and the human answers it in the TUI. A form with several fields
 * is parsed field by field, but `resolveStructuredQuestionAnswer` refuses a
 * multi-question answer, so only a one-field form is answerable from a surface
 * — the same bound v1's multi-question calls have.
 *
 * The answer goes back as `{answer: {<key>: <value>}}`, and the value is the
 * option's `value`, not its label: {@link buildOpencodeV2FormAnswer} maps the
 * labels a verdict carries back through the same form the question was read
 * from.
 *
 * @module lib/hooks/sources/opencode-v2/payloads
 */

import {
  MAX_ASK_USER_QUESTION_LABEL_LENGTH,
  parseAskUserQuestionToolInput,
  type AskUserQuestionSpec,
} from '@/lib/hooks/ask-user-question-payload';
import type { PermissionRequestPayload } from '@/lib/hooks/permission-request-payload';
import { isPlainObject, readStringField } from '../event-mapper';
import type { PendingDecision } from '../types';

/**
 * The object an approval or a question lives in.
 *
 * Two callers hand this module two shapes: the SSE frame `{id, type, data}`,
 * and the bare object the list endpoints return. Unwrapping here lets the
 * list path reuse the live path's parsing.
 */
export function unwrapOpencodeV2Payload(payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof payload.type === 'string' && isPlainObject(payload.data)) {
    // `form.created` nests the form one level further — `data.form` (measured
    // on 2.0.18); `permission.asked` does not.
    return isPlainObject(payload.data.form) ? payload.data.form : payload.data;
  }
  return payload;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// =============================================================================
// Approvals
// =============================================================================

/**
 * Read a `permission.asked` frame, or an entry of `GET /api/permission/request`.
 *
 * @returns What the adjudicator judges, or null when this is not an approval
 *   the server can address (no `per_…` id or no session) — which every caller
 *   treats as "leave it for the human"
 */
export function parseOpencodeV2PermissionRequest(
  payload: Record<string, unknown>
): PermissionRequestPayload | null {
  const data = unwrapOpencodeV2Payload(payload);
  const permissionId = readStringField(data, 'id');
  const sessionId = readStringField(data, 'sessionID');
  // Both are in the reply URL: `/api/session/{sessionID}/permission/{id}/reply`.
  if (!permissionId || !sessionId) return null;
  // A form shares nothing with an approval but the envelope; never judge one.
  if (Array.isArray(data.fields)) return null;

  const action = readStringField(data, 'action');
  const metadata = isPlainObject(data.metadata) ? data.metadata : {};

  return {
    // The approval names its own kind (`edit`, `shell`, …); v1 had to borrow
    // the tool name from a separate frame.
    toolName: action ?? 'permission',
    // `metadata` verbatim — a `shell` approval's command, an `edit`'s files and
    // patches — plus what is being asked for. What the deny patterns see.
    toolInput: {
      action,
      resources: readStringArray(data.resources),
      ...metadata,
    },
    promptId: permissionId,
    sessionId,
    permissionMode: null,
    // `save` is the rule `Always allow` would store. Recorded, never judged.
    permissionSuggestions: Array.isArray(data.save) ? data.save : null,
  };
}

/** Turn an approval into a {@link PendingDecision}. */
export function toOpencodeV2PendingPermission(
  payload: Record<string, unknown>,
  askedAt: number
): PendingDecision | null {
  const parsed = parseOpencodeV2PermissionRequest(payload);
  if (!parsed || !parsed.promptId) return null;
  return {
    kind: 'permission',
    id: parsed.promptId,
    conversationId: parsed.sessionId,
    subject: { kind: 'permission', toolName: parsed.toolName, toolInput: parsed.toolInput },
    raw: payload,
    askedAt,
  };
}

/**
 * What an approval is about, for the approval card (Issue #2945 D1).
 *
 * `toolName` is the action and `patterns` is `save` — the rule `Always allow`
 * would store, which is what the card shows beside that button (the same slot
 * v1 fills from `patterns`, #2031). Null when the payload is not an approval.
 */
export function readOpencodeV2PermissionSubject(
  payload: Record<string, unknown>
): { toolName: string | null; patterns: readonly string[] } | null {
  const parsed = parseOpencodeV2PermissionRequest(payload);
  if (!parsed) return null;
  return {
    toolName: parsed.toolName,
    patterns: readStringArray(parsed.permissionSuggestions),
  };
}

/**
 * Lines of a unified diff that carry no change: the `Index:` / `====` banner
 * and the `---` / `+++` file headers the card already names.
 */
const PATCH_HEADER_LINE = /^(Index: |={3,}$|--- |\+\+\+ )/;

/** A patch with its file headers removed, trailing newline trimmed. */
export function stripOpencodeV2PatchHeaders(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => !PATCH_HEADER_LINE.test(line))
    .join('\n')
    .replace(/\n+$/, '');
}

/**
 * The approval card's text: what is asked for, then the diff (Issue #2945 D1).
 *
 * ```
 * edit hello.txt
 * @@ -0,0 +1,1 @@
 * +hi
 * ```
 *
 * The first line is the action and its resources; then, per file in
 * `metadata.files`, the file name (when there is more than one) and its patch
 * without the header lines. A `shell` approval, which carries a command rather
 * than files, reads `shell <command>`. Unbounded here — the caller cuts it to
 * the record's message bound, and a cut diff is still the head of the diff.
 *
 * @returns The text, or null when the payload is not an approval
 */
export function describeOpencodeV2Permission(payload: Record<string, unknown>): string | null {
  const parsed = parseOpencodeV2PermissionRequest(payload);
  if (!parsed) return null;
  const input = parsed.toolInput;
  const subject =
    typeof input.command === 'string' && input.command !== ''
      ? input.command
      : readStringArray(input.resources).join(', ');
  const lines = [subject === '' ? parsed.toolName : `${parsed.toolName} ${subject}`];

  const files = Array.isArray(input.files) ? input.files.filter(isPlainObject) : [];
  for (const file of files) {
    const patch = typeof file.patch === 'string' ? stripOpencodeV2PatchHeaders(file.patch) : '';
    if (patch === '') continue;
    if (files.length > 1 && typeof file.file === 'string') lines.push(file.file);
    lines.push(patch);
  }
  return lines.join('\n');
}

// =============================================================================
// Questions
// =============================================================================

/** One choice of a form field, with the value the answer carries for it. */
interface FieldChoice {
  label: string;
  description: string | null;
  value: string | boolean;
}

/** One form field read as a question. */
interface FormQuestionField {
  key: string;
  question: string;
  /** The field's `title`, shown as the question's heading. */
  header: string | null;
  multiSelect: boolean;
  /** Whether a free-text answer is accepted (`custom: true`). */
  custom: boolean;
  choices: FieldChoice[];
}

/**
 * The two choices a `boolean` field is offered as. Untranslated for the reason
 * the approval verdicts are: the label is also what `commandmate respond`
 * accepts, and a locale-dependent word would make the same command work on one
 * machine and not another.
 */
const BOOLEAN_FIELD_CHOICES: readonly FieldChoice[] = [
  // eslint-disable-next-line no-restricted-syntax -- CLI answer vocabulary, not display text
  { label: 'Yes', description: null, value: true },
  // eslint-disable-next-line no-restricted-syntax -- CLI answer vocabulary, not display text
  { label: 'No', description: null, value: false },
];

/** The label as `parseAskUserQuestionToolInput` keeps it, for matching back. */
function normalizeLabel(label: string): string {
  return label.trim().slice(0, MAX_ASK_USER_QUESTION_LABEL_LENGTH);
}

function readFieldChoices(options: unknown): FieldChoice[] | null {
  if (!Array.isArray(options) || options.length === 0) return null;
  const choices: FieldChoice[] = [];
  for (const option of options) {
    if (!isPlainObject(option)) return null;
    const value = readStringField(option, 'value');
    const label = readStringField(option, 'label') ?? value;
    if (value === null || label === null) return null;
    choices.push({ label, description: readStringField(option, 'description'), value });
  }
  return choices;
}

/**
 * The form's visible fields as questions, or null when one of them cannot be
 * offered as a choice (see the module comment).
 */
function readFormQuestionFields(form: Record<string, unknown>): FormQuestionField[] | null {
  if (!Array.isArray(form.fields)) return null;
  const formTitle = readStringField(form, 'title');
  const fields: FormQuestionField[] = [];
  for (const raw of form.fields) {
    if (!isPlainObject(raw)) return null;
    if (raw.hidden === true) continue;
    const key = readStringField(raw, 'key');
    if (key === null) return null;
    const type = readStringField(raw, 'type');
    const choices =
      type === 'boolean' ? [...BOOLEAN_FIELD_CHOICES] : type === 'string' || type === 'multiselect'
        ? readFieldChoices(raw.options)
        : null;
    if (choices === null) return null;
    // Measured on 2.0.18: the question tool puts the question in `description`
    // (`Which colour do you like?`) and a heading in `title` (`Favourite colour`).
    const question =
      readStringField(raw, 'description') ?? readStringField(raw, 'title') ?? formTitle;
    if (question === null) return null;
    fields.push({
      key,
      question,
      header: readStringField(raw, 'title') ?? formTitle,
      multiSelect: type === 'multiselect',
      custom: raw.custom === true && type !== 'boolean',
      choices,
    });
  }
  return fields.length > 0 ? fields : null;
}

/**
 * Read a form (`form.created` data, or an entry of `GET …/form`) as a question.
 *
 * @returns The spec — `promptId` is the `frm_…` id — or null when the form is
 *   not one a surface can offer choices for
 */
export function parseOpencodeV2Form(payload: Record<string, unknown>): AskUserQuestionSpec | null {
  const form = unwrapOpencodeV2Payload(payload);
  const formId = readStringField(form, 'id');
  if (!formId) return null;
  const fields = readFormQuestionFields(form);
  if (fields === null) return null;

  const questions = parseAskUserQuestionToolInput({
    questions: fields.map((field) => ({
      question: field.question,
      header: field.header,
      multiSelect: field.multiSelect,
      options: field.choices.map((choice) => ({
        label: choice.label,
        ...(choice.description ? { description: choice.description } : {}),
      })),
    })),
  });
  if (questions === null) return null;
  // Issue #2951: a field that takes a typed answer says so, so the surfaces
  // can offer an input for it. `questions` is `fields` one-to-one.
  const withCustom = questions.map((entry, index) =>
    fields[index]?.custom ? { ...entry, custom: true as const } : entry
  );
  return { questions: withCustom, promptId: formId };
}

/** Turn a form into a {@link PendingDecision}; `raw` keeps the form for the reply. */
export function toOpencodeV2PendingQuestion(
  payload: Record<string, unknown>,
  askedAt: number
): PendingDecision | null {
  const form = unwrapOpencodeV2Payload(payload);
  const spec = parseOpencodeV2Form(form);
  if (!spec || !spec.promptId) return null;
  return {
    kind: 'question',
    id: spec.promptId,
    conversationId: readStringField(form, 'sessionID'),
    subject: { kind: 'question', spec },
    raw: form,
    askedAt,
  };
}

/**
 * The `answer` object a form reply carries, built from a verdict's `answers`
 * (one array per question, in field order).
 *
 * Each entry is matched to the field's choices by label (then by value), and
 * the choice's `value` is sent — `true` / `false` for a boolean. An entry that
 * matches no choice is sent as typed only where the field accepts free text
 * (`custom: true`); anywhere else the whole answer is refused, because the
 * server would refuse it (`FormInvalidAnswerError`) and a partial answer is not
 * the operator's.
 *
 * @returns The object, or null when the answer does not fit the form
 */
export function buildOpencodeV2FormAnswer(
  form: Record<string, unknown>,
  answers: readonly (readonly string[])[]
): Record<string, unknown> | null {
  const fields = readFormQuestionFields(unwrapOpencodeV2Payload(form));
  if (fields === null || answers.length !== fields.length) return null;

  const answer: Record<string, unknown> = {};
  for (const [index, field] of fields.entries()) {
    const values: (string | boolean)[] = [];
    for (const given of answers[index]) {
      const wanted = normalizeLabel(given);
      const choice =
        field.choices.find((candidate) => normalizeLabel(candidate.label) === wanted) ??
        field.choices.find((candidate) => candidate.value === given);
      if (choice) values.push(choice.value);
      else if (field.custom && given.trim() !== '') values.push(given.trim());
      else return null;
    }
    if (field.multiSelect) {
      answer[field.key] = values.map(String);
    } else {
      if (values.length !== 1) return null;
      answer[field.key] = values[0];
    }
  }
  return answer;
}
