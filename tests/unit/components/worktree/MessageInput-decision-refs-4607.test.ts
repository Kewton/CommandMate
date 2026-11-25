/**
 * Issue #4607 r4 (T-c): the send's check reads no copy of the To written by a passive effect.
 *
 * The functions that decide whether a press sends (`holdsRetargetedSend`, `submitMessage`,
 * `sendWithBriefChoice`, `confirmRetarget`, `holdsUnconfirmedResend`, and `currentRetargetTags` that
 * the first one calls) are read out of `MessageInput.tsx`. Every `XxxRef.current` they read at the
 * press — before their first `await` — is listed, and of those, the refs a passive `useEffect` copies
 * a render's value into (in the effect's body; its clean-up's resets void an answer or an attempt and
 * are not a copy). A press between the commit of a To change and its passive effects sees the new
 * render's handler with the old copy (r3 P2-1, `sendTargetKeyRef`). Only the refs below, each for its
 * reason, may be such a copy; anything else is red.
 *
 * After the first `await` the passive effects of the render that pressed have run (the reads there —
 * `messageRef`, `attachedImagePathRef`, `planReviewActiveRef` — are G-PR6's checks after the wait).
 *
 * The scanner is shown to find such a read on a source written under `os.tmpdir()` (positive control)
 * and to leave a layout-effect copy and a clean-up reset alone (negative control).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MESSAGE_INPUT = path.resolve(__dirname, '../../../../src/components/worktree/MessageInput.tsx');

const DECISIONS = [
  'holdsRetargetedSend',
  'submitMessage',
  'sendWithBriefChoice',
  'confirmRetarget',
  'holdsUnconfirmedResend',
  'currentRetargetTags',
];

/** The passive copies a decision may read, and why each one may. */
const ALLOWED: Record<string, string> = {
  draftKeyRef:
    'the key of the draft whose text is in the composer: it changes with the text (the same passive effect sets both); a render copy would pair the new key\'s tags with the old text (W-1, #4604 D-1)',
  retargetTagsRef:
    'the tags of the draft in `draftKeyRef` (checked against it in `currentRetargetTags`); the store is read too at each send',
  previewKeyRef:
    '#4503\'s resend mark is compared with it (the mark\'s own target, no tool); it never says yes to a retargeted send',
};

function blockAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced block at ${open}`);
}

/** Refs a passive `useEffect` copies a value into, in its body (not in the clean-up it returns). */
export function passiveCopies(src: string): Set<string> {
  const refs = new Set<string>();
  for (const m of src.matchAll(/\buseEffect\(\s*\(\)\s*=>\s*\{/g)) {
    let body = blockAt(src, (m.index ?? 0) + m[0].length - 1);
    const cleanup = /return\s*\(\)\s*=>\s*\{/.exec(body);
    if (cleanup) {
      const open = cleanup.index + cleanup[0].length - 1;
      body = body.slice(0, cleanup.index) + body.slice(open + blockAt(body, open).length);
    }
    for (const a of body.matchAll(/(\w+Ref)\.current\s*(?:=(?!=)|\+=|-=|\+\+|--)/g)) refs.add(a[1]);
    for (const a of body.matchAll(/(?:\+\+|--)(\w+Ref)\.current/g)) refs.add(a[1]);
  }
  return refs;
}

/** Refs a decision function reads before its first `await`. */
export function readsAtPress(src: string, name: string): Set<string> {
  const m = new RegExp(`const ${name} = useCallback\\(\\s*(?:async\\s*)?\\([^)]*\\)(?:\\s*:\\s*\\w+(?:\\[\\])?)?\\s*=>\\s*\\{`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  let body = blockAt(src, (m.index ?? 0) + m[0].length - 1);
  const firstAwait = body.search(/\bawait\b/);
  if (firstAwait >= 0) body = body.slice(0, firstAwait);
  return new Set([...body.matchAll(/(\w+Ref)\.current/g)].map((x) => x[1]));
}

function offending(src: string, names: string[]): string[] {
  const copies = passiveCopies(src);
  const found = new Set<string>();
  for (const name of names) for (const ref of readsAtPress(src, name)) if (copies.has(ref)) found.add(ref);
  return [...found].filter((ref) => !(ref in ALLOWED)).sort();
}

describe('[#4607 r4] T-c: the send\'s check reads no passive copy of the To', () => {
  const src = fs.readFileSync(MESSAGE_INPUT, 'utf8');

  it('every decision function is found', () => {
    for (const name of DECISIONS) expect(() => readsAtPress(src, name)).not.toThrow();
  });

  it('the decision functions read no passive copy outside the allowed list', () => {
    expect(offending(src, DECISIONS)).toEqual([]);
  });

  it('there is no copy of the send target in a ref (the To compared is the render\'s `sendTargetKey`)', () => {
    expect(src.match(/\bsendTargetKeyRef\b/g) ?? []).toEqual([]);
  });

  it('the allowed list is still used (an entry nobody reads goes)', () => {
    const copies = passiveCopies(src);
    const read = new Set(DECISIONS.flatMap((name) => [...readsAtPress(src, name)]));
    for (const ref of Object.keys(ALLOWED)) {
      expect(copies.has(ref)).toBe(true);
      expect(read.has(ref)).toBe(true);
    }
  });

  describe('controls on a source under os.tmpdir()', () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      dir = null;
    });

    function sample(effect: string, check: string): string {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-refs-4607-'));
      const file = path.join(dir, 'Sample.tsx');
      fs.writeFileSync(
        file,
        [
          'function Sample({ to }: { to: string }) {',
          '  const targetRef = useRef(to);',
          '  const answerRef = useRef<string | null>(null);',
          effect,
          '  const submitMessage = useCallback(async () => {',
          check,
          '    await post(to);',
          '    if (targetRef.current !== to) return;',
          '  }, [to]);',
          '}',
        ].join('\n'),
      );
      return fs.readFileSync(file, 'utf8');
    }

    it('positive: a ref copied in a passive effect and read at the press is found', () => {
      const s = sample('  useEffect(() => {\n    targetRef.current = to;\n  }, [to]);', '    if (answerRef.current !== targetRef.current) return;');
      expect(offending(s, ['submitMessage'])).toEqual(['targetRef']);
    });

    it('negative: a layout-effect copy and a clean-up reset are not', () => {
      const s = sample(
        '  useLayoutEffect(() => {\n    targetRef.current = to;\n  }, [to]);\n  useEffect(() => {\n    return () => {\n      answerRef.current = null;\n    };\n  }, [to]);',
        '    if (answerRef.current !== targetRef.current) return;',
      );
      expect(offending(s, ['submitMessage'])).toEqual([]);
    });

    it('negative: a passive copy read only after the first await is not', () => {
      const s = sample('  useEffect(() => {\n    targetRef.current = to;\n  }, [to]);', '    if (answerRef.current !== to) return;');
      expect(offending(s, ['submitMessage'])).toEqual([]);
    });
  });
});
