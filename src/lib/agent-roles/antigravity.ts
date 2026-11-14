/**
 * Reading Antigravity's screen for its role (Issue #4385,
 * `docs/design/agy-role-default-4385.md` D2). Pure functions: the driver reads
 * the pane and says which screen it is, this says what that screen proves.
 *
 * agy draws the agent it runs on its status row:
 * `auto · cm-role-x (Gemini 4 Hydrogen · high)  /agents` with a role,
 * `auto · Gemini 4 Hydrogen · high` without one (agy 1.5.8, measured on the trust
 * screen, `dev-reports/issue/agy-role-2026-11-14/evidence/4-tui.txt`). Only that
 * row of the current screen is read: never the transcript, the scrollback, a
 * quotation or an old `error:` row.
 *
 * @module lib/agent-roles/antigravity
 */

/** The agy version the role's screen and refusal were checked on (2026-11-14). */
export const ANTIGRAVITY_ROLE_VERIFIED_VERSION = '1.5.8';

/** Which screen the driver found, with the status row it read on it. */
export interface AntigravityRoleFrame {
  /**
   * - `input-box`: agy's input box is live (`isAntigravityReady`)
   * - `busy`: the input box is drawn and agy is still working (generating); its
   *   status row is the current one, but the box takes no body yet
   * - `trust`: the folder-trust question
   * - `other`: anything else (not drawn yet, a dialog or picker, a shell)
   */
  kind: 'input-box' | 'busy' | 'trust' | 'other';
  /** The current status row (ANSI stripped), '' when none is drawn; null for `other`. */
  statusRow: string | null;
}

/** Why a screen says plainly that the role is not on the process. */
export type AntigravityRoleCause =
  /** agy stopped on a tool name it does not register (`unknown component: tool "x"`, exit 3). */
  | 'unknown-tool'
  /** agy is not what holds the pane. */
  | 'not-started'
  /** agy runs, and its status row names no agent or another one. */
  | 'role-not-selected'
  /** Nothing confirmed it within the grace. */
  | 'grace-expired'
  /** No record of a confirmation for the process now running. */
  | 'no-record'
  /** The role settings could not be read. */
  | 'settings-unreadable'
  /** The role settings changed while the send was on its way. */
  | 'settings-changed'
  /** Another process took the session while the send waited. */
  | 'replaced';

/** What one screen proves. */
export type AntigravityRoleVerdict =
  | { kind: 'confirmed' }
  | { kind: 'not-applied'; cause: AntigravityRoleCause }
  | { kind: 'undetermined' };

/**
 * Whether a status row names `name` as the agent: ` · <name> (`, so a name that
 * only shares a prefix or a suffix does not count.
 */
export function statusRowNamesAgent(statusRow: string, name: string): boolean {
  if (name === '') return false;
  return statusRow.includes(` · ${name} (`);
}

/**
 * What a screen proves about the role named `name`. Whether the role is applied
 * is read apart from whether a body could be typed now (D2): the current status
 * row naming the agent confirms on any screen that has one, a busy box included.
 * Plainly without it is said only by a screen agy has finished drawing (its
 * ready input box or the trust question); anything else proves nothing yet.
 */
export function judgeAntigravityRoleFrame(frame: AntigravityRoleFrame, name: string): AntigravityRoleVerdict {
  if (frame.kind === 'other' || frame.statusRow === null) return { kind: 'undetermined' };
  if (statusRowNamesAgent(frame.statusRow, name)) return { kind: 'confirmed' };
  if (frame.kind === 'busy') return { kind: 'undetermined' };
  return { kind: 'not-applied', cause: 'role-not-selected' };
}

const TOOL_NAME = /^[a-z_][a-z0-9_]{0,63}$/;
const UNKNOWN_TOOL = /unknown component: tool "([^"\n]{1,64})"/g;
const VERSION = /^\d+\.\d+\.\d+$/;

/**
 * The tool name agy stopped on, read only from the rows after the last launch
 * line that named `name` (the whole screen when none is found), and only when it
 * looks like a tool name. The row itself is never quoted.
 */
export function findUnknownToolName(screen: string, name: string): string | null {
  const rows = screen.split('\n');
  let start = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (name !== '' && rows[i].includes(`--agent ${name}`)) {
      start = i + 1;
      break;
    }
  }
  let found: string | null = null;
  for (const match of rows.slice(start).join('\n').matchAll(UNKNOWN_TOOL)) {
    found = TOOL_NAME.test(match[1]) ? match[1] : null;
  }
  return found;
}

/** What a refusal may say, and nothing else (no row of agy's output, no role body). */
export interface AntigravityRoleRefusalDetail {
  cause: AntigravityRoleCause;
  toolName?: string | null;
  /** `agy --version`'s answer, said only when it looks like a version. */
  runningVersion?: string | null;
  artifactName?: string | null;
  artifactPath?: string | null;
}

const CAUSE_TEXT: Record<AntigravityRoleCause, string> = {
  'unknown-tool': 'agy stopped on a tool it does not register',
  'not-started': 'agy is not running in the pane',
  'role-not-selected': 'agy runs without the role',
  'grace-expired': 'the role was not confirmed in time',
  'no-record': 'there is no record of the role being confirmed for the process now running (it was stopped, the server restarted, or the role was set after it started)',
  'settings-unreadable': 'the role settings could not be read',
  'settings-changed': 'the role settings changed while this send was on its way',
  replaced: 'another process took the session while this send waited',
};

/**
 * The refusal's message: fixed words, the cause, and only names, a path and
 * versions that pass their shape. Never agy's own `error:` row.
 */
export function describeAntigravityRoleRefusal(detail: AntigravityRoleRefusalDetail): string {
  const parts = [CAUSE_TEXT[detail.cause]];
  if (detail.toolName && TOOL_NAME.test(detail.toolName)) parts.push(`tool "${detail.toolName}"`);
  if (detail.artifactName) parts.push(`agent ${detail.artifactName}`);
  if (detail.artifactPath) parts.push(`file ${detail.artifactPath}`);
  const running = detail.runningVersion && VERSION.test(detail.runningVersion) ? detail.runningVersion : 'unknown';
  parts.push(`agy ${running}, checked on ${ANTIGRAVITY_ROLE_VERIFIED_VERSION}`);
  return (
    'The role could not be confirmed for this Antigravity session, so nothing was sent. ' +
    `Stop the session and start it again. (${parts.join('; ')})`
  );
}
