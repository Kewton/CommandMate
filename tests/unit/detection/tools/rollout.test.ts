/**
 * The D1 idle-evidence rollout: table, kill switch, observe mode
 * (Issue #1927, §4 D1 決定 1 / §13.1 DR3-016 / §11).
 *
 * §4 D1 says the rule lands one tool at a time, and §13.1 asks for two operator
 * controls around that: a kill switch that puts one tool back to the old reading
 * without a redeploy, and an observation mode that measures the rollout before
 * it is turned on (「倒す前に観測だけで走らせる」). Both are behaviour, so both
 * are pinned here rather than described in a comment.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IDLE_EVIDENCE_DEFAULT_MODE,
  IDLE_EVIDENCE_ENV_VAR,
  resolveIdleEvidenceMode,
} from '@/config/detection-evidence-config';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import {
  getIdleEvidenceObservations,
  resetIdleEvidenceObservations,
} from '@/lib/detection/idle-evidence-observation';
import { buildClaudeIdleComposerFrame } from '../../../fixtures/claude-idle-composer';

/** A claude frame that reads `ready`/`input_prompt` with NO completion marker. */
const UNVOUCHED_IDLE_FRAME = buildClaudeIdleComposerFrame('  it stopped mid-sentence');
/** The same frame with Claude's measured completion marker on it. */
const VOUCHED_IDLE_FRAME = buildClaudeIdleComposerFrame();

const originalEnv = process.env[IDLE_EVIDENCE_ENV_VAR];

beforeEach(() => {
  delete process.env[IDLE_EVIDENCE_ENV_VAR];
  resetIdleEvidenceObservations();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[IDLE_EVIDENCE_ENV_VAR];
  else process.env[IDLE_EVIDENCE_ENV_VAR] = originalEnv;
});

describe('[#1927] the rollout table', () => {
  it('enforces only the three tools with a measured rule and fixtures', () => {
    // The complete table, pinned by equality rather than by spot checks: adding
    // a tool to the rollout has to be a visible diff to this line, because
    // §4 D1 決定 1 forbids flipping a tool whose rule was not read off its own
    // frames (the mistake #1979 had to correct for copilot).
    expect(IDLE_EVIDENCE_DEFAULT_MODE).toEqual({
      // Issue #2011: claude is `observe`, not `enforce`. #1927 shipped it
      // straight to `enforce` without the §11 measurement, and the live rate
      // measured afterwards was 7 idle panes in 8 answering `'none'`. The rule
      // goes back to counting until it can cover a legitimately idle pane with
      // no completion marker on it (`/model`, `/clear`, startup, Esc).
      claude: 'observe',
      copilot: 'enforce',
      opencode: 'enforce',
      codex: 'legacy',
      gemini: 'legacy',
      antigravity: 'legacy',
      'vibe-local': 'legacy',
      // Issue #2250: Command Code's module declares no `readIdleEvidence`
      // either, so `enforce` here would state a rollout that does not exist.
      'command-code': 'legacy',
    });
  });

  it('leaves a tool with no measured rule reading `positive`, whatever the table says', () => {
    // codex is `legacy` in the table AND declares no `readIdleEvidence`, so its
    // idle row keeps the pre-#1927 reading either way. Belt and braces on
    // purpose: DR2-002's failure mode is a tool being flipped by accident.
    const codexIdle = ['› ', 'gpt-5.4 · 92% left · ~/work'].join('\n');
    const result = detectSessionStatus(codexIdle, 'codex');

    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(result.evidence).toBe('positive');
  });
});

describe('[#1927] the kill switch', () => {
  it('is off by default — and claude`s shipped default is `observe`, so the frame reads positive', () => {
    const result = detectSessionStatus(UNVOUCHED_IDLE_FRAME, 'claude');

    // Issue #2011. `observe` is byte-identical to `legacy` on the wire, so with
    // no env var set an unvouched claude frame publishes `'positive'` — the
    // pre-#1927 reading. What separates the two is the tally, asserted below.
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(result.evidence).toBe('positive');
  });

  it('turns the rule on for one tool without a redeploy', () => {
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=enforce';

    const result = detectSessionStatus(UNVOUCHED_IDLE_FRAME, 'claude');

    // The switch runs in both directions, which is what makes it the control
    // §13.1 asks for rather than a one-way undo.
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(result.evidence).toBe('none');
  });

  it('puts one tool back to the pre-#1927 reading', () => {
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=legacy';

    const result = detectSessionStatus(UNVOUCHED_IDLE_FRAME, 'claude');

    // The old behaviour, exactly: a composer row on screen is treated as
    // completion evidence. This is the escape hatch §13.1 asks for — an
    // operator who sees the rollout misfire can undo it without a redeploy.
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(result.evidence).toBe('positive');
  });

  it('does not disturb the frames that had evidence anyway', () => {
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=legacy';

    expect(detectSessionStatus(VOUCHED_IDLE_FRAME, 'claude').evidence).toBe('positive');
  });

  it('is read on every call, so flipping it does not need a restart', () => {
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=enforce';
    expect(detectSessionStatus(UNVOUCHED_IDLE_FRAME, 'claude').evidence).toBe('none');
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=legacy';
    expect(detectSessionStatus(UNVOUCHED_IDLE_FRAME, 'claude').evidence).toBe('positive');
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=enforce';
    expect(detectSessionStatus(UNVOUCHED_IDLE_FRAME, 'claude').evidence).toBe('none');
  });

  it('takes a wildcard, and a tool entry beats it in either order', () => {
    const envWith = (value: string): NodeJS.ProcessEnv =>
      ({ [IDLE_EVIDENCE_ENV_VAR]: value }) as unknown as NodeJS.ProcessEnv;
    const env = envWith('*=legacy');
    expect(resolveIdleEvidenceMode('claude', env)).toBe('legacy');
    expect(resolveIdleEvidenceMode('opencode', env)).toBe('legacy');

    for (const spelling of ['*=legacy,claude=enforce', 'claude=enforce,*=legacy']) {
      const mixed = envWith(spelling);
      expect(resolveIdleEvidenceMode('claude', mixed)).toBe('enforce');
      expect(resolveIdleEvidenceMode('copilot', mixed)).toBe('legacy');
    }
  });

  it('ignores a typo rather than throwing on the polling path', () => {
    // This is read once per status poll. A malformed env var must degrade to
    // the shipped default, not take the detector down.
    for (const junk of ['claude=enfroce', 'claude', '=,=,=', '   ']) {
      expect(
        resolveIdleEvidenceMode('claude', { [IDLE_EVIDENCE_ENV_VAR]: junk } as unknown as NodeJS.ProcessEnv),
      ).toBe(IDLE_EVIDENCE_DEFAULT_MODE.claude);
    }
  });
});

describe('[#1927] observe mode — the pre-rollout measurement §11 asks for', () => {
  it('computes the verdict, counts it, and publishes the old one', () => {
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=observe';

    const unvouched = detectSessionStatus(UNVOUCHED_IDLE_FRAME, 'claude');
    const vouched = detectSessionStatus(VOUCHED_IDLE_FRAME, 'claude');

    // Behaviour is byte-identical to `legacy` — that is what makes it safe to
    // run in production before the flip.
    expect(unvouched.evidence).toBe('positive');
    expect(vouched.evidence).toBe('positive');

    // …and the tally says what enforcing WOULD have done: one frame would have
    // gained `isUnclassifiedActive: true`. That count against the current
    // `unclassified_frames` record rate is the rollout condition.
    expect(getIdleEvidenceObservations().claude).toEqual({
      mode: 'observe',
      positive: 1,
      none: 1,
    });
  });

  it('counts under enforce as well, so before and after are comparable', () => {
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=enforce';

    detectSessionStatus(UNVOUCHED_IDLE_FRAME, 'claude');
    detectSessionStatus(UNVOUCHED_IDLE_FRAME, 'claude');
    detectSessionStatus(VOUCHED_IDLE_FRAME, 'claude');

    expect(getIdleEvidenceObservations().claude).toEqual({
      mode: 'enforce',
      positive: 1,
      none: 2,
    });
  });

  it('records nothing at all while a tool is killed back to legacy', () => {
    process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=legacy';

    detectSessionStatus(UNVOUCHED_IDLE_FRAME, 'claude');

    // `legacy` does not run the rule, so there is nothing to count — and a
    // counter that kept moving would misreport the switch as having no effect.
    expect(getIdleEvidenceObservations().claude).toBeUndefined();
  });
});
