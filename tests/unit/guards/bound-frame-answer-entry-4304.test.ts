/**
 * Issue #4304 F1-a, T10 (design `docs/design/capture-generation-binding-4304.md`
 * §4.3 / §6.1): the answer path's entries take a frame bound to its pane
 * generation, and nothing else.
 *
 * The types do most of it — `SendPromptAnswerParams['frame']` is `BoundFrame`,
 * whose brand only `captureBoundFrame` can produce, and the `@ts-expect-error`
 * cases in `tests/unit/session/bound-frame-4304.test.ts` fail `tsc` if a raw
 * string, a hand-made `{ frame, generation }` or a raw capture callback is ever
 * accepted again. What types cannot hold is pinned here, from the source text:
 *
 * 1. a `BoundFrame` is spelled by a cast in exactly two files — `cli-session.ts`
 *    (`captureBoundFrame`) and the test helper — so no module mints one;
 * 2. the answer path's modules read the pane only through `captureBoundFrame`:
 *    none of them takes the display cache (`captureSessionOutput`), a fresh
 *    unbound frame (`captureSessionOutputFresh`) or `capturePane` by the
 *    session's name;
 * 3. `captureSessionOutputFresh` writes nothing back to the display cache
 *    (§4.5, §6.4 (iv)).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/** The source without comments, so a sentence about a function is not a call of it. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function trackedTs(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'tests', 'scripts'], { cwd: ROOT, encoding: 'utf-8' })
    .split('\0')
    .filter((f) => /\.(ts|tsx)$/.test(f));
}

/** The answer path of F1-a (§5): R4, R5, R6, R7. */
const ANSWER_PATH = [
  'src/lib/prompt-answer-sender.ts',
  'src/lib/polling/auto-yes-poller-capture.ts',
  'src/app/api/worktrees/[id]/prompt-response/frame-verification.ts',
  'src/app/api/worktrees/[id]/prompt-response/plan-review.ts',
  'src/app/api/worktrees/[id]/prompt-response/answer-delivery.ts',
  'src/app/api/worktrees/[id]/respond/screen-at-send.ts',
  'src/app/api/worktrees/[id]/respond/route.ts',
  'src/lib/session/strict-prompt-answer-io.ts',
] as const;

describe('[#4304 F1-a] T10 — the answer entries take a BoundFrame only', () => {
  it('a BoundFrame is cast into being only by captureBoundFrame and the test helper', () => {
    const casting = trackedTs().filter((f) => /\bas\s+BoundFrame\b/.test(read(f)));
    expect(casting.sort()).toEqual(['src/lib/session/cli-session.ts', 'tests/unit/session/bound-frame-test-helper.ts']);
  });

  it.each(ANSWER_PATH)('%s reads the pane only through captureBoundFrame', (file) => {
    const source = code(file);
    expect(source).not.toMatch(/\bcaptureSessionOutputFresh\s*\(/);
    expect(source).not.toMatch(/\bcaptureSessionOutput\s*\(/);
    expect(source).not.toMatch(/\bcapturePane\s*\(/);
  });

  it('the sender’s frame, the plan review’s frame and re-read are bound', () => {
    expect(code('src/lib/prompt-answer-sender.ts')).toMatch(/\n\s*frame\?: BoundFrame;/);
    const planReview = code('src/app/api/worktrees/[id]/prompt-response/plan-review.ts');
    expect(planReview).toMatch(/\n\s*frame: BoundFrame;/);
    expect(planReview).toMatch(/recapture\?: \(expected: PaneGeneration\) => Promise<BoundCapture>;/);
    expect(code('src/app/api/worktrees/[id]/prompt-response/frame-verification.ts')).toMatch(/verifiedFrame: BoundFrame;/);
    expect(code('src/app/api/worktrees/[id]/respond/screen-at-send.ts')).toMatch(/frame: BoundFrame \| undefined;/);
  });

  it('negative control: the scan sees a call when there is one', () => {
    expect(code('src/lib/session/current-output-builder.ts')).toMatch(/\bcaptureSessionOutput\s*\(/);
  });
});

describe('[#4304 F1-a] §4.5 — the fresh capture is not written back', () => {
  it('captureSessionOutputFresh writes nothing to the display cache', () => {
    const source = code('src/lib/session/cli-session.ts');
    const start = source.indexOf('export async function captureSessionOutputFresh(');
    const end = source.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, end)).not.toMatch(/setCachedCapture/);
  });
});
