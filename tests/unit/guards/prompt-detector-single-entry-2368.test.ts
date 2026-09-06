/**
 * One frame, one reading: the direct callers of `detectPrompt` are a fixed,
 * named set (Issue #2368).
 *
 * ## What happened
 *
 * Four things read the same tmux frame and each has to reach the same verdict
 * about it: the status detector (`/current-output`, the chat surface, `cmate
 * wait`), the response poller (the stored `prompt` row and its push
 * notification), the `prompt-response` route (PromptPanel's Submit and
 * `cmate respond`), and the Auto-Yes poller (the keystrokes an unattended
 * pipeline sends on the operator's behalf).
 *
 * Issue #2364 gave antigravity its own dialog reader — agy wraps a long command
 * inside an option LABEL with no indentation, and the generic multiple-choice
 * parser reads one row per option — and wired it into three of those four. The
 * fourth, `auto-yes-poller.ts`, kept its own `detectPrompt(cleanOutput,
 * buildDetectPromptOptions(cliToolId))`. Nothing failed: every suite stayed
 * green, `tsc` had nothing to say, and the defect was only visible on a live
 * agy session, as a worker that went quiet for 70+ seconds on a screen the
 * status API was simultaneously publishing as an answerable four-option prompt.
 *
 * A call site left behind is invisible precisely because it still compiles and
 * still returns a plausible answer. So the thing worth pinning is not "the agy
 * reader is called" — #2368's own suites do that — but the SHAPE that let one
 * consumer drift: whoever may call the generic detector directly.
 *
 * ## What this pins
 *
 * Every `src/` file that imports `detectPrompt` from `detection/prompt-detector`
 * AND calls it. The list below is that set, with the reason each entry is on it.
 * Adding a new direct caller — or putting `auto-yes-poller.ts` back on one —
 * turns this red and makes the author say, in this file, why their consumer is
 * allowed to read a frame differently from the other three.
 *
 * ## Why a text scan and not a type-level rule
 *
 * `detectPrompt` is a plain exported function; nothing in the type system
 * distinguishes "called from the shared entry" from "called from a poller". An
 * ESLint `no-restricted-imports` rule could express it, but its `overrides`
 * allowlist would then need this same pin to stop it being widened silently
 * (that is exactly the argument in `tmux-import-allowlist.test.ts`), so the list
 * would exist either way. It lives here, next to the reasons.
 *
 * The scanner is exercised against fixtures below — a single-line import, a
 * multi-line import, a comment-only mention, a same-named local — because a
 * matcher that quietly matches nothing is a guard that guards nothing.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();

/**
 * The shared entry every consumer of a frame is supposed to read it through.
 *
 * `detectPromptOnCleanFrame` takes an already-stripped capture (the Auto-Yes
 * poller cleans once per tick and reuses the string) and
 * `detectPromptWithOptions` wraps it for callers holding a raw one. Both are in
 * this file, and this file is the only one allowed to combine
 * `buildDetectPromptOptions` with a tool's own dialog reader.
 */
const SHARED_ENTRY = 'src/lib/polling/response-checker.ts';

/**
 * Files that may call `detectPrompt` directly, and why.
 *
 * Grouped by the reason, because the reasons are not the same and a future
 * reader deciding whether to add a sixth entry needs to know which group it
 * would join. The set as a whole is asserted; the groups are documentation that
 * the assertion enforces.
 */
const ALLOWED: readonly { file: string; why: string }[] = [
  {
    file: SHARED_ENTRY,
    why:
      'The entry itself. `detectPromptOnCleanFrame` is where a tool-specific dialog '
      + 'reader runs ahead of the generic pass, so every consumer downstream of it '
      + 'gets one reading of one frame.',
  },
  {
    file: 'src/lib/detection/tools/run-detection.ts',
    why:
      'Priority 1 of the per-tool status chain. It is UPSTREAM of the entry, not a '
      + 'second copy of it: this is the call whose result `detectSessionStatus` '
      + 'publishes, and a tool module that wants its own reading overrides the chain '
      + 'rather than calling the detector again.',
  },
  {
    file: 'src/lib/detection/tools/codex/detect.ts',
    why:
      "codex's own hook (#1160 stale approvals, #1628 the `Press enter to confirm` "
      + 'dialog, the pager). It re-runs the detector over a DIFFERENT slice of the '
      + 'frame than the chain handed it, which is a tool-module decision by design '
      + '(`docs/design/multi-agent-state-architecture.md` §4 D2).',
  },
  {
    file: 'src/lib/detection/tools/copilot/detect.ts',
    why:
      'Same seam as codex: copilot decides between its status bar and a dialog '
      + '(#1885 / #1895) before the chain would, and re-reads the frame to do it.',
  },
  {
    file: 'src/app/api/worktrees/[id]/prompt-response/route.ts',
    why:
      'Issue #161 re-verification, on the way to sending a human answer. It composes '
      + "the agy reader with the generic pass by hand (`toolDialog ?? detectPrompt(…)`) "
      + 'rather than calling the entry, which is duplication #2368 did not remove '
      + 'because this route is outside its scope — the duplicate is listed here so it '
      + 'is a known debt rather than a place a fifth reading can appear unnoticed.',
  },
] as const;

/**
 * The consumers whose absence is the point.
 *
 * These read frames on the polling path and must go through the shared entry.
 * Asserted by name as well as by the set equality below, so a failure names the
 * regression instead of only printing a diff of paths.
 */
const MUST_NOT_CALL_DIRECTLY: readonly string[] = [
  'src/lib/auto-yes-poller.ts',
  'src/lib/detection/status-detector.ts',
  'src/lib/session/current-output-builder.ts',
];

/** Tracked `src/` sources. `git ls-files` keeps `.next`, `dist` and friends out. */
function trackedSources(): string[] {
  return execFileSync('git', ['ls-files', '-z', 'src'], { cwd: REPO_ROOT, encoding: 'utf-8' })
    .split('\0')
    .filter((f) => /\.tsx?$/.test(f));
}

/**
 * Does this source import `detectPrompt` from the prompt detector AND call it?
 *
 * Both halves are required. The import alone is satisfied by a re-export, and a
 * bare `detectPrompt(` alone is satisfied by a local of the same name or by a
 * mention inside a comment — which every module in `src/lib/detection` has,
 * because the comments are where the reasoning lives.
 */
export function callsDetectPromptDirectly(source: string): boolean {
  // `[\s\S]` on purpose: the import lists in these files span several lines.
  const imported = /import\s*(?:type\s*)?\{[\s\S]*?\bdetectPrompt\b[\s\S]*?\}\s*from\s*['"][^'"]*prompt-detector['"]/.test(
    source,
  );
  if (!imported) return false;
  // Strip comments before looking for the call, so a `detectPrompt(` written
  // inside a docstring is not counted as one.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return /(^|[^\w.])detectPrompt\s*\(/m.test(code);
}

describe('[#2368] `detectPrompt` has a fixed set of direct callers', () => {
  const actual = trackedSources().filter((f) =>
    callsDetectPromptDirectly(readFileSync(join(REPO_ROOT, f), 'utf-8')),
  );

  it('is exactly the allowlist', () => {
    expect([...actual].sort()).toEqual(ALLOWED.map((e) => e.file).sort());
  });

  it.each(MUST_NOT_CALL_DIRECTLY)('does not include %s', (file) => {
    // The #2368 regression itself: `auto-yes-poller.ts` back on the generic
    // detector reads agy's wrapped Bash approval as `isPrompt: false` and
    // answers nothing, while `/current-output` publishes it as waiting.
    expect(actual).not.toContain(file);
  });

  it('has no stale allowlist entry', () => {
    // A renamed or deleted file would otherwise leave a permission behind that
    // silently re-authorises the next file to take its path.
    for (const { file } of ALLOWED) {
      expect(existsSync(join(REPO_ROOT, file)), `${file} is allowlisted but missing`).toBe(true);
      expect(actual, `${file} is allowlisted but no longer calls detectPrompt`).toContain(file);
    }
  });

  it('states a reason for every entry', () => {
    for (const { file, why } of ALLOWED) {
      expect(why.length, `${file} needs a reason`).toBeGreaterThan(60);
    }
  });
});

describe('[#2368] the scanner is not vacuous', () => {
  it('catches a single-line import and call', () => {
    expect(
      callsDetectPromptDirectly(
        "import { detectPrompt } from '@/lib/detection/prompt-detector';\n"
          + 'const r = detectPrompt(clean, opts);\n',
      ),
    ).toBe(true);
  });

  it('catches a multi-line import list — the shape these files actually use', () => {
    expect(
      callsDetectPromptDirectly(
        "import {\n  detectPrompt,\n  type PromptDetectionResult,\n} from '../../prompt-detector';\n"
          + 'export const r = () => detectPrompt(frame);\n',
      ),
    ).toBe(true);
  });

  it('ignores a file that only names it in prose', () => {
    // Every detection module does this, which is why the call check exists.
    expect(
      callsDetectPromptDirectly(
        "import { detectPrompt } from '@/lib/detection/prompt-detector';\n"
          + '/** Deliberately not calling detectPrompt(output) here. */\n'
          + 'export const unused = detectPrompt;\n',
      ),
    ).toBe(false);
  });

  it('ignores a method of the same name on some other object', () => {
    expect(
      callsDetectPromptDirectly('const r = reader.detectPrompt(clean);\n'),
    ).toBe(false);
  });

  it('found the shared entry, so the scan reached real files', () => {
    // Positive control on the walk itself: a `git ls-files` that returned
    // nothing would make the set-equality assertion above pass vacuously only
    // if the allowlist were empty, but an over-narrow extension filter would
    // still shrink it silently.
    expect(trackedSources()).toContain(SHARED_ENTRY);
    expect(trackedSources().length).toBeGreaterThan(200);
  });
});
