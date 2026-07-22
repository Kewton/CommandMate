/**
 * skill command guards — confirmation contract and typed error mapping
 * Issue #1237: `commandmate skill` is a thin client over the Skill APIs, so the
 * only safety logic that belongs here is the part the server cannot enforce:
 * whether *this invocation* is allowed to ask for a write at all.
 */

import * as readline from 'readline';
import { ExitCode, SkillExitCode } from '../types';
import { ApiError } from '../utils/api-client';
import { isInteractive } from '../utils/prompt';

/** Mirrors: src/lib/skills/constants.ts SKILL_ID_PATTERN / SKILL_ID_MAX_LENGTH. */
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_ID_MAX_LENGTH = 64;

/**
 * Validate a Skill ID before it is interpolated into a request path.
 * The server validates it again; this only turns a typo into exit 2 instead of
 * a request carrying an arbitrary path segment.
 */
export function isValidSkillId(id: string): boolean {
  return id.length > 0 && id.length <= SKILL_ID_MAX_LENGTH && SKILL_ID_PATTERN.test(id);
}

/**
 * Print a refusal on stderr and set the process exit code.
 *
 * Callers must `return` immediately afterwards: process.exit is stubbed in
 * tests, so anything written after this line would still run — and, for a write
 * command, would still reach the API.
 */
export function refuse(message: string, exitCode: number): void {
  console.error(`Error: ${message}`);
  process.exit(exitCode);
}

/**
 * Exit code for each typed Skill API error.
 *
 * The point of the table is the split the Issue asks for: a bad request or a
 * missing Skill (fix the argv) must not look like a worktree that refused the
 * write (fix the files, then re-plan), and neither may look like the Catalog
 * being unreachable (retry later).
 */
const SKILL_ERROR_EXIT_CODES: Readonly<Record<string, number>> = {
  // The request was wrong. Nothing about the worktree needs to change.
  SKILL_PLAN_INPUT_REJECTED: ExitCode.CONFIG_ERROR,
  SKILL_PLAN_INVALID_BODY: ExitCode.CONFIG_ERROR,
  SKILL_INSTALL_INVALID_BODY: ExitCode.CONFIG_ERROR,
  SKILL_UNINSTALL_INVALID_BODY: ExitCode.CONFIG_ERROR,
  SKILL_PLAN_TARGET_UNSAFE: ExitCode.CONFIG_ERROR,
  SKILL_NOT_FOUND: ExitCode.CONFIG_ERROR,
  SKILL_VERSION_NOT_FOUND: ExitCode.CONFIG_ERROR,
  SKILL_UNINSTALL_NOT_INSTALLED: ExitCode.CONFIG_ERROR,

  // The target refused. Resolve the named path, or re-plan, then retry.
  SKILL_PLAN_STALE: SkillExitCode.BLOCKED,
  SKILL_PLAN_EXPIRED: SkillExitCode.BLOCKED,
  SKILL_PLAN_CONSUMED: SkillExitCode.BLOCKED,
  SKILL_PLAN_BINDING_MISMATCH: SkillExitCode.BLOCKED,
  SKILL_PLAN_NOT_INSTALLABLE: SkillExitCode.BLOCKED,
  SKILL_INSTALL_DESTINATION_EXISTS: SkillExitCode.BLOCKED,
  SKILL_INSTALL_DESTINATION_UNMANAGED: SkillExitCode.BLOCKED,
  SKILL_INSTALL_TARGET_UNSAFE: SkillExitCode.BLOCKED,
  SKILL_INSTALL_LOCKED: SkillExitCode.BLOCKED,
  SKILL_INSTALL_IDEMPOTENCY_CONFLICT: SkillExitCode.BLOCKED,
  SKILL_INSTALL_IN_PROGRESS: SkillExitCode.BLOCKED,
  SKILL_UNINSTALL_BLOCKED: SkillExitCode.BLOCKED,
  SKILL_UNINSTALL_TARGET_UNSAFE: SkillExitCode.BLOCKED,
  SKILL_UNINSTALL_LOCKED: SkillExitCode.BLOCKED,
  SKILL_UNINSTALL_IDEMPOTENCY_CONFLICT: SkillExitCode.BLOCKED,
  SKILL_UNINSTALL_IN_PROGRESS: SkillExitCode.BLOCKED,

  // An acknowledgement was missing, not a file.
  SKILL_PLAN_RISK_NOT_ACKNOWLEDGED: SkillExitCode.CONFIRMATION_REQUIRED,
};

/** Statuses that mean "the dependency is unavailable", not "your request was wrong". */
const AVAILABILITY_STATUSES: readonly number[] = [502, 503, 504];

/** Exit code for a failed Skill API call. */
export function skillExitCode(error: ApiError): number {
  const mapped = error.apiCode ? SKILL_ERROR_EXIT_CODES[error.apiCode] : undefined;
  if (mapped !== undefined) return mapped;
  if (error.statusCode !== undefined && AVAILABILITY_STATUSES.includes(error.statusCode)) {
    return ExitCode.DEPENDENCY_ERROR;
  }
  return error.exitCode;
}

/**
 * Report a failed skill subcommand.
 *
 * Everything goes to stderr, including the typed code and any blocker paths, so
 * a `--json` run that fails emits nothing at all on stdout rather than a
 * half-written or error-shaped document.
 */
export function handleSkillCommandError(error: unknown): void {
  if (error instanceof ApiError) {
    const detail = error.payload?.error ?? error.message;
    console.error(error.apiCode ? `Error: ${detail} [${error.apiCode}]` : `Error: ${detail}`);
    for (const blocker of error.payload?.blockers ?? []) {
      console.error(`  - ${blocker.code}${blocker.path ? `: ${blocker.path}` : ''}`);
    }
    process.exit(skillExitCode(error));
    return;
  }
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(ExitCode.UNEXPECTED_ERROR);
}

/**
 * Ask a yes/no question on stderr.
 *
 * The shared confirm() in utils/prompt.ts writes to stdout, which would land
 * inside the document a `--json` run is expected to emit. Skill writes own their
 * prompt so stdout carries the result and nothing else, in every mode.
 */
async function confirmOnStderr(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolvePromise) => {
      rl.question(`${question} (y/N): `, resolvePromise);
    });
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

/** How the confirmation requirement was settled. Only `confirmed` may write. */
export type ConfirmationOutcome = 'confirmed' | 'declined' | 'non_interactive';

/**
 * Decide whether this invocation may proceed to a write.
 *
 * A non-TTY without `--yes` is refused rather than assumed: an environment that
 * cannot show a prompt is exactly the one where an implicit yes would install
 * something nobody watched.
 */
export async function resolveWriteConfirmation(
  question: string,
  options: { yes?: boolean }
): Promise<ConfirmationOutcome> {
  if (options.yes) return 'confirmed';
  if (!isInteractive()) return 'non_interactive';
  return (await confirmOnStderr(question)) ? 'confirmed' : 'declined';
}

/**
 * Whether `--ack-risk` names exactly this Skill and version.
 *
 * Deliberately an exact value rather than a flag: `--yes` is a blanket "don't
 * prompt me" that a wrapper script sets once and forgets, so it must not be
 * able to carry a high-risk install with it. Typing the id and version is the
 * acknowledgement.
 */
export function riskAcknowledgementMatches(
  ackRisk: string | undefined,
  skillId: string,
  version: string
): boolean {
  return ackRisk !== undefined && ackRisk.trim() === `${skillId}@${version}`;
}
