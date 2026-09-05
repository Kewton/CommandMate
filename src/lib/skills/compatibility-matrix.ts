/**
 * Measured Agent discovery matrix (Issue #1246)
 *
 * What a Skill package *declares* about an Agent and what CommandMate has
 * actually *measured* are different claims. `compatibility.ts` carries the
 * declaration; this module carries the measurement, so the UI can show both and
 * never present one as the other.
 *
 * Two axes, not one. A single `native`/`unsupported` value cannot describe
 * Codex CLI 0.145.0, which discovers a Skill from `.agents/skills` but does not
 * expose it as a slash command. Collapsing that into one value would either
 * promise an invocation route that does not exist or deny a discovery that does.
 * So discovery and invocation are recorded separately and only discovery feeds
 * the support verdict; invocation becomes a stated limitation.
 *
 * Pure data and pure functions: no filesystem, no network, no clock. `now` is
 * always an explicit argument so a staleness verdict is reproducible.
 *
 * Evidence provenance: the 2026-07-26 measurements were taken in an isolated
 * environment (dedicated port, dedicated database, a fresh repository with no
 * Skills installed) against CommandMate 0.15.0. They are recorded here rather
 * than re-derived at runtime — CommandMate does not drive a CLI to answer a
 * catalog request.
 *
 * @module lib/skills/compatibility-matrix
 */

import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import {
  SKILL_CLAUDE_INSTALL_ROOT_PREFIX,
  SKILL_INSTALL_ROOT_PREFIX,
} from '@/lib/skills/constants';
import type { SkillAgentSupport } from '@/types/skills';

// =============================================================================
// Vocabulary
// =============================================================================

/**
 * The two independently observable behaviors.
 *
 * - `discovery`: the Agent finds the package and can read its instructions.
 * - `invocation`: the Agent offers it as a slash command in its own palette.
 */
export type SkillAgentAxis = 'discovery' | 'invocation';

/** Outcome of one axis. `unknown` means unmeasured, never "works". */
export type SkillAgentAxisOutcome = 'verified' | 'unsupported' | 'unknown';

/**
 * How strong the evidence behind an outcome is.
 *
 * `self_report` is the Agent answering a question about itself. It is real
 * evidence and it is weaker than a palette match, so it is labelled rather than
 * quietly folded into `mechanical`.
 */
export type SkillEvidenceKind = 'mechanical' | 'self_report' | 'not_measured';

export const SKILL_AGENT_AXIS_OUTCOMES: readonly SkillAgentAxisOutcome[] = [
  'verified',
  'unsupported',
  'unknown',
];

export const SKILL_EVIDENCE_KINDS: readonly SkillEvidenceKind[] = [
  'mechanical',
  'self_report',
  'not_measured',
];

/** i18n keys naming each axis, shared by UI and CLI (UX-05). */
export const AGENT_AXIS_LABEL_KEYS: Record<SkillAgentAxis, string> = {
  discovery: 'skills.compatibility.axis.discovery',
  invocation: 'skills.compatibility.axis.invocation',
};

export const AGENT_AXIS_OUTCOME_LABEL_KEYS: Record<SkillAgentAxisOutcome, string> = {
  verified: 'skills.compatibility.axisOutcome.verified',
  unsupported: 'skills.compatibility.axisOutcome.unsupported',
  unknown: 'skills.compatibility.axisOutcome.unknown',
};

export const AGENT_EVIDENCE_KIND_LABEL_KEYS: Record<SkillEvidenceKind, string> = {
  mechanical: 'skills.compatibility.evidenceKind.mechanical',
  self_report: 'skills.compatibility.evidenceKind.selfReport',
  not_measured: 'skills.compatibility.evidenceKind.notMeasured',
};

/** One axis of one Agent, with the strength and the caveats of its evidence. */
export interface SkillAgentAxisEvidence {
  outcome: SkillAgentAxisOutcome;
  evidenceKind: SkillEvidenceKind;
  /** i18n key for {@link outcome}. */
  labelKey: string;
  /** i18n key for {@link evidenceKind}. */
  evidenceKindKey: string;
  /** i18n key stating a known limitation of this outcome, or null. */
  limitationKey: string | null;
}

/** One Agent's measured behavior against the install roots CommandMate writes. */
export interface SkillAgentMatrixEntry {
  agent: CLIToolType;
  /**
   * Install root prefixes this Agent was measured to read. Empty when
   * unmeasured — never a guess, because a wrong root reads as "installed and
   * invisible".
   */
  discoveryRoots: readonly string[];
  discovery: SkillAgentAxisEvidence;
  invocation: SkillAgentAxisEvidence;
  /** CLI version the measurement ran against, or null when unmeasured. */
  testedVersion: string | null;
  /** `YYYY-MM-DD` the measurement was taken, or null when unmeasured. */
  testedDate: string | null;
  /** Public reference to the evidence. Never a machine path, token or URL secret. */
  evidenceSource: string | null;
  /** i18n key for how to make this Agent pick up a freshly installed Skill. */
  reloadKey: string;
  /** i18n key explaining why the Agent is unmeasured, or null when measured. */
  skipReasonKey: string | null;
}

/**
 * How long a measurement stays quotable before the UI flags it.
 *
 * Agent CLIs ship far faster than CommandMate re-measures them, so evidence
 * that is merely old is presented as old rather than silently trusted.
 */
export const SKILL_EVIDENCE_MAX_AGE_DAYS = 180;

const NOT_MEASURED_AXIS: SkillAgentAxisEvidence = {
  outcome: 'unknown',
  evidenceKind: 'not_measured',
  labelKey: AGENT_AXIS_OUTCOME_LABEL_KEYS.unknown,
  evidenceKindKey: AGENT_EVIDENCE_KIND_LABEL_KEYS.not_measured,
  limitationKey: null,
};

const NOT_MEASURED_SKIP_REASON_KEY = 'skills.compatibility.skipReason.notMeasured';

/** Reload guidance keys. Keyed by behavior, not by Agent, so they stay reusable. */
export const AGENT_RELOAD_MESSAGE_KEYS = {
  SESSION_RESTART: 'skills.compatibility.reload.sessionRestart',
  SESSION_RESTART_NO_SLASH: 'skills.compatibility.reload.sessionRestartNoSlash',
  UNKNOWN: 'skills.compatibility.reload.unknown',
} as const;

/** Known limitation keys attached to an axis outcome. */
export const AGENT_LIMITATION_MESSAGE_KEYS = {
  NO_SLASH_COMMAND: 'skills.compatibility.limitation.noSlashCommand',
} as const;

/** Evidence reference for the 2026-07-26 isolated-environment measurement. */
const G4_EVIDENCE_SOURCE =
  'https://github.com/Kewton/CommandMate/issues/1513#issuecomment-5083878264';

const MEASURED_DATE_2026_07_26 = '2026-07-26';

/**
 * Evidence reference for the opencode 1.18.22 measurement (Issue #2037).
 *
 * The design note is the primary record — it carries the harness, the controls
 * and the raw endpoint output, which an issue comment cannot.
 */
const OPENCODE_EVIDENCE_SOURCE =
  'https://github.com/Kewton/CommandMate/blob/main/docs/design/opencode-server-live-verification.md#11-issue-2036--2037-opencode-11822-2026-08-25';

const MEASURED_DATE_2026_08_25 = '2026-08-25';

/**
 * Evidence reference for the Command Code 1.49.0 measurement (Issue #2302).
 *
 * The reference doc carries the harness, both controls and the raw CLI output,
 * which is the half of a row a reader can actually check.
 */
const COMMAND_CODE_EVIDENCE_SOURCE =
  'https://github.com/Kewton/CommandMate/blob/main/docs/reference/skill-agent-compatibility.md#8-command-code-probe-log-issue-2302';

const MEASURED_DATE_2026_09_05 = '2026-09-05';

/**
 * Evidence reference for the Copilot 1.0.83 measurement (Issue #2302).
 *
 * The same probe log also carries a Gemini 0.58.0 discovery measurement that is
 * deliberately *not* recorded as a row — see the `gemini` entry below.
 */
const OTHER_AGENTS_EVIDENCE_SOURCE =
  'https://github.com/Kewton/CommandMate/blob/main/docs/reference/skill-agent-compatibility.md#9-gemini--copilot-probe-log-issue-2302';

function unmeasuredEntry(agent: CLIToolType): SkillAgentMatrixEntry {
  return {
    agent,
    discoveryRoots: [],
    discovery: NOT_MEASURED_AXIS,
    invocation: NOT_MEASURED_AXIS,
    testedVersion: null,
    testedDate: null,
    evidenceSource: null,
    reloadKey: AGENT_RELOAD_MESSAGE_KEYS.UNKNOWN,
    skipReasonKey: NOT_MEASURED_SKIP_REASON_KEY,
  };
}

// =============================================================================
// The matrix
// =============================================================================

/**
 * Every Agent CommandMate knows about, measured or not.
 *
 * The unmeasured entries are listed rather than omitted: an Agent missing from
 * the table would render as no statement at all, which a reader completes as
 * "presumably fine". An explicit `unknown` with a skip reason is the honest
 * shape of "we did not test this".
 */
const AGENT_DISCOVERY_MATRIX: readonly SkillAgentMatrixEntry[] = [
  {
    agent: 'claude',
    // Measured to read `.claude/skills` and *not* `.agents/skills`. The official
    // catalog's older entries credited `.agents/skills` for Claude support; the
    // conclusion was right and the reason was wrong — it works because #1460
    // installs into `.claude/skills` too.
    discoveryRoots: [SKILL_CLAUDE_INSTALL_ROOT_PREFIX],
    discovery: {
      outcome: 'verified',
      evidenceKind: 'mechanical',
      labelKey: AGENT_AXIS_OUTCOME_LABEL_KEYS.verified,
      evidenceKindKey: AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical,
      limitationKey: null,
    },
    invocation: {
      outcome: 'verified',
      evidenceKind: 'mechanical',
      labelKey: AGENT_AXIS_OUTCOME_LABEL_KEYS.verified,
      evidenceKindKey: AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical,
      limitationKey: null,
    },
    testedVersion: '2.1.220',
    testedDate: MEASURED_DATE_2026_07_26,
    evidenceSource: G4_EVIDENCE_SOURCE,
    reloadKey: AGENT_RELOAD_MESSAGE_KEYS.SESSION_RESTART,
    skipReasonKey: null,
  },
  {
    agent: 'codex',
    discoveryRoots: [SKILL_INSTALL_ROOT_PREFIX],
    discovery: {
      // The Agent named the absolute SKILL.md path under `.agents/skills` when
      // asked without tools. That is evidence, and it is the Agent describing
      // itself, so it is recorded as a self report rather than as a match.
      outcome: 'verified',
      evidenceKind: 'self_report',
      labelKey: AGENT_AXIS_OUTCOME_LABEL_KEYS.verified,
      evidenceKindKey: AGENT_EVIDENCE_KIND_LABEL_KEYS.self_report,
      limitationKey: null,
    },
    invocation: {
      // Ruled out as a placement problem by control: `/mo` matched `/model`, so
      // the palette works, and a Skill already sitting in `~/.codex/skills` did
      // not match either. This CLI version does not expose Skills as slash
      // commands wherever they are placed.
      outcome: 'unsupported',
      evidenceKind: 'mechanical',
      labelKey: AGENT_AXIS_OUTCOME_LABEL_KEYS.unsupported,
      evidenceKindKey: AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical,
      limitationKey: AGENT_LIMITATION_MESSAGE_KEYS.NO_SLASH_COMMAND,
    },
    testedVersion: '0.145.0',
    testedDate: MEASURED_DATE_2026_07_26,
    evidenceSource: G4_EVIDENCE_SOURCE,
    reloadKey: AGENT_RELOAD_MESSAGE_KEYS.SESSION_RESTART_NO_SLASH,
    skipReasonKey: null,
  },
  // Issue #2302 *did* measure gemini 0.58.0 — `gemini skills list --all`
  // returns `.agents/skills` with an absolute path, and `.claude/skills`
  // planted at the same moment does not appear. It is still recorded as
  // unmeasured here, on purpose: the invocation axis could not be measured at
  // all (sign-in fails with "This client is no longer supported for Gemini Code
  // Assist for individuals", so the TUI never reaches a composer), and landing
  // the half-row is a change to `tests/integration/skills-agent-discovery-probe.test.ts`,
  // which pins gemini as its example of an Agent with no measurement. The
  // probe log is kept so the next pass starts from evidence rather than zero:
  // `docs/reference/skill-agent-compatibility.md` §9.1.
  unmeasuredEntry('gemini'),
  unmeasuredEntry('vibe-local'),
  {
    agent: 'opencode',
    // Measured, not read off the docs. The docs do say opencode scans
    // `.claude/skills` and `.agents/skills`, and Issue #2037 said outright that
    // this would probably come back `native` — neither is why this row is what
    // it is. Six probe Skills were planted, one per candidate root, each told to
    // answer a unique token; `GET /skill` returned all six with their absolute
    // SKILL.md paths, including both roots below.
    discoveryRoots: [SKILL_INSTALL_ROOT_PREFIX, SKILL_CLAUDE_INSTALL_ROOT_PREFIX],
    discovery: {
      outcome: 'verified',
      evidenceKind: 'mechanical',
      labelKey: AGENT_AXIS_OUTCOME_LABEL_KEYS.verified,
      evidenceKindKey: AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical,
      limitationKey: null,
    },
    invocation: {
      // Submitting `/probe-agents-root` loaded that Skill's instructions and the
      // agent answered `PROBE_OK_probe-agents-root`; `.claude/skills` answered
      // its own token the same way. That is a slash command that runs, so this
      // is `verified` rather than codex's `unsupported`.
      //
      // The limitation is narrower than "no slash command" and is recorded as
      // one anyway: opencode's *own* palette does not offer Skills (typing the
      // full name shows "No matching items" — positive control `/status` matched
      // its own row, negative control `/zzzznotacommand` matched nothing), so
      // without CommandMate's palette the route is invisible. The `/skills`
      // picker is opencode's own way in, and it inserts exactly this `/name`.
      outcome: 'verified',
      evidenceKind: 'mechanical',
      labelKey: AGENT_AXIS_OUTCOME_LABEL_KEYS.verified,
      evidenceKindKey: AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical,
      limitationKey: AGENT_LIMITATION_MESSAGE_KEYS.NO_SLASH_COMMAND,
    },
    testedVersion: '1.18.22',
    testedDate: MEASURED_DATE_2026_08_25,
    evidenceSource: OPENCODE_EVIDENCE_SOURCE,
    // Also measured: the server scans commands and Skills once at boot and
    // caches them, so a freshly installed Skill appears only after a restart.
    reloadKey: AGENT_RELOAD_MESSAGE_KEYS.SESSION_RESTART,
    skipReasonKey: null,
  },
  {
    agent: 'copilot',
    // Issue #2302, GitHub Copilot CLI 1.0.83. The only Agent so far measured to
    // read *both* CommandMate install roots from one listing: `copilot skill
    // list` returns `.github/skills` (positive control), `.agents/skills` and
    // `.claude/skills`, and the byte-identical dual-root install appears once
    // rather than twice.
    //
    // `copilot skill --help` claims those roots too. That claim is not the
    // evidence — the probe Skills are, one per root with its own token.
    discoveryRoots: [SKILL_INSTALL_ROOT_PREFIX, SKILL_CLAUDE_INSTALL_ROOT_PREFIX],
    discovery: {
      outcome: 'verified',
      evidenceKind: 'mechanical',
      labelKey: AGENT_AXIS_OUTCOME_LABEL_KEYS.verified,
      evidenceKindKey: AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical,
      limitationKey: null,
    },
    invocation: {
      // Typing `/probe` in Copilot's own composer offers all four planted
      // Skills, `.claude/skills` included. Controls: `/zzzznotacommand` matched
      // nothing and `/hel` matched the built-in commands, so the palette was
      // filtering rather than listing everything.
      //
      // Measured at the palette, which is what this axis is — the same standard
      // the Claude row was measured to. The model was not signed in during the
      // probe, so a Skill actually running end to end is *not* claimed here.
      outcome: 'verified',
      evidenceKind: 'mechanical',
      labelKey: AGENT_AXIS_OUTCOME_LABEL_KEYS.verified,
      evidenceKindKey: AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical,
      limitationKey: null,
    },
    testedVersion: '1.0.83',
    testedDate: MEASURED_DATE_2026_09_05,
    evidenceSource: OTHER_AGENTS_EVIDENCE_SOURCE,
    // Whether a Skill added mid-session is picked up was not measured.
    reloadKey: AGENT_RELOAD_MESSAGE_KEYS.UNKNOWN,
    skipReasonKey: null,
  },
  // CommandMate's own slash palette serves `.agents/skills` entries to
  // antigravity sessions (#1504). That is CommandMate injecting a command, not
  // the Agent discovering a Skill, so it is not evidence for this table.
  unmeasuredEntry('antigravity'),
  {
    agent: 'command-code',
    // Issue #2250 left this row unmeasured; Issue #2302 measured it on 1.49.0.
    //
    // Of CommandMate's two install roots, Command Code reads `.agents/skills`
    // and does not read `.claude/skills`. `cmd skills list -d` names the roots
    // it looks in — project `.commandcode/skills` and `.agents/skills`, the same
    // pair under `$HOME` — and `.claude/skills` is not among them. A probe Skill
    // was planted in each root at the same moment, so the split is the Agent's
    // and not the install's: `.commandcode/skills` is the positive control and
    // came back listed, `.claude/skills` is the negative control and did not.
    //
    // The dual-root install (#1460) is therefore half-read and still correct:
    // one byte-identical payload in both roots is listed exactly once, from
    // `.agents/skills`. Naming the unread root here would render as "installed
    // and invisible" for anyone reading the table to decide where to look.
    discoveryRoots: [SKILL_INSTALL_ROOT_PREFIX],
    discovery: {
      outcome: 'verified',
      evidenceKind: 'mechanical',
      labelKey: AGENT_AXIS_OUTCOME_LABEL_KEYS.verified,
      evidenceKindKey: AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical,
      limitationKey: null,
    },
    invocation: {
      // The axis codex and opencode both fail, and Command Code passes: typing
      // `/probe` in its own composer offers the installed Skills as `[skill]`
      // rows, and `/skills` lists them under "Project skills" with an
      // `[.agents]` badge. So no limitation is attached here — CommandMate's
      // palette is a convenience for this Agent, not the only route in.
      //
      // Headless is where it was machine-checked: `cmd -p "/<name>"` emits
      // `{"type":"skill_loaded","name":"<name>"}` before the run starts and the
      // model then answers the Skill's token. `--no-skills` is the control that
      // makes that event mean discovery rather than prompt text — same prompt,
      // no event.
      outcome: 'verified',
      evidenceKind: 'mechanical',
      labelKey: AGENT_AXIS_OUTCOME_LABEL_KEYS.verified,
      evidenceKindKey: AGENT_EVIDENCE_KIND_LABEL_KEYS.mechanical,
      limitationKey: null,
    },
    testedVersion: '1.49.0',
    testedDate: MEASURED_DATE_2026_09_05,
    evidenceSource: COMMAND_CODE_EVIDENCE_SOURCE,
    // Also measured: a Skill planted into a *running* session shows up in the
    // `/skills` picker, which rescans when opened, but not in the composer's
    // slash completion, which is built once at session start. A restart is what
    // makes both agree, so that is the instruction.
    reloadKey: AGENT_RELOAD_MESSAGE_KEYS.SESSION_RESTART,
    skipReasonKey: null,
  },
];

/** The measured matrix, in CLI-tool declaration order. */
export function getSkillAgentMatrix(): readonly SkillAgentMatrixEntry[] {
  return AGENT_DISCOVERY_MATRIX;
}

/** The entry for one Agent, or null when the id is not a known CLI tool. */
export function findSkillAgentMatrixEntry(agent: string): SkillAgentMatrixEntry | null {
  return AGENT_DISCOVERY_MATRIX.find((entry) => entry.agent === agent) ?? null;
}

/** Whether CommandMate has any measurement at all for this Agent. */
export function isAgentMeasured(entry: SkillAgentMatrixEntry): boolean {
  return entry.discovery.evidenceKind !== 'not_measured';
}

/**
 * The four-valued support verdict implied by the measurement.
 *
 * Only the discovery axis decides it. An Agent that finds and can run a Skill
 * supports it natively even when its palette does not list it, so a failed
 * invocation axis is reported as a limitation instead of demoting the verdict
 * to `unsupported` — which would read as "this will not work".
 *
 * `commandmate_runtime` is never produced here: the Runtime is not shipped, and
 * inventing that verdict would promise a fallback that does not exist.
 */
export function deriveMatrixAgentSupport(entry: SkillAgentMatrixEntry): SkillAgentSupport {
  switch (entry.discovery.outcome) {
    case 'verified':
      return 'native';
    case 'unsupported':
      return 'unsupported';
    case 'unknown':
      return 'unknown';
  }
}

// =============================================================================
// Staleness
// =============================================================================

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MEASURED_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whole days between the measurement and `now`, or null when unmeasured or when
 * the recorded date is unusable. A measurement dated in the future yields 0
 * rather than a negative age.
 */
export function evidenceAgeInDays(entry: SkillAgentMatrixEntry, now: Date): number | null {
  if (entry.testedDate === null || !MEASURED_DATE_PATTERN.test(entry.testedDate)) return null;
  const measured = Date.parse(`${entry.testedDate}T00:00:00Z`);
  const current = now.getTime();
  if (Number.isNaN(measured) || Number.isNaN(current)) return null;
  return Math.max(0, Math.floor((current - measured) / MS_PER_DAY));
}

/**
 * Whether the measurement is old enough to warn about.
 *
 * An unmeasured Agent is not stale — it is unknown, which the UI already states
 * more strongly. Marking it stale as well would imply a measurement had expired.
 */
export function isEvidenceStale(
  entry: SkillAgentMatrixEntry,
  now: Date,
  maxAgeDays: number = SKILL_EVIDENCE_MAX_AGE_DAYS
): boolean {
  const age = evidenceAgeInDays(entry, now);
  return age !== null && age > maxAgeDays;
}

// =============================================================================
// Coverage
// =============================================================================

/** CLI tools with no measurement, in matrix order. */
export function unmeasuredAgents(): CLIToolType[] {
  return AGENT_DISCOVERY_MATRIX.filter((entry) => !isAgentMeasured(entry)).map(
    (entry) => entry.agent
  );
}

/** CLI tool ids the matrix does not mention. Empty in a consistent build. */
export function agentsMissingFromMatrix(): CLIToolType[] {
  return CLI_TOOL_IDS.filter((id) => findSkillAgentMatrixEntry(id) === null);
}
