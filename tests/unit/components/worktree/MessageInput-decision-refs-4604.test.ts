/**
 * Issue #4604 T-c (設計書 §3.1・§2.5, after #4607's T-c): the send's check reads no passive copy of
 * the draft's key either. The text and its key are one state (`draft {key, text}`), and the check reads
 * the store under the key of the text it sends (`draft.key`) — never `draftKeyRef`, which a passive
 * effect writes (between the commit of a key change and that effect it still names the previous
 * draft: W-1).
 *
 * The decision functions are read out of `MessageInput.tsx` with their comments taken out (#4607 r4
 * check P3-3: a comment's "await" is not the first await). Each passive copy one of them reads before
 * its first `await` must be on the list below for that function, with its reason:
 *
 * - `retargetTagsRef` — the tags this composer holds, keyed; `currentRetargetTags(key)` takes them only
 *   for the key it is given (the text's)
 * - `draftKeyRef` · `previewKeyRef` in `holdsUnconfirmedResend` only — #4503's resend mark (a send whose
 *   outcome is unknown), compared with its own target (no tool); it never says yes to a handed-back
 *   text (design §2.2: out of this design's range, kept as it is)
 *
 * Positive control: a decision that reads `draftKeyRef` is found (a source under `os.tmpdir()`).
 * Negative control: the same read after the first await (or in a comment) is not.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from '@tests/helpers/draft-store-fault-4604';

const MESSAGE_INPUT = path.resolve(__dirname, '../../../../src/components/worktree/MessageInput.tsx');

const DECISIONS = [
  'holdsRetargetedSend',
  'submitMessage',
  'sendWithBriefChoice',
  'confirmRetarget',
  'holdsUnconfirmedResend',
  'currentRetargetTags',
];

/** The passive copies each decision may read, and why. */
const ALLOWED: Record<string, Record<string, string>> = {
  holdsRetargetedSend: { retargetTagsRef: 'through currentRetargetTags(key): the held tags of the text\'s key only' },
  currentRetargetTags: { retargetTagsRef: 'the held tags, taken only when their key is the one given (the text\'s)' },
  holdsUnconfirmedResend: {
    draftKeyRef: '#4503: the resend mark of the draft on screen (not a handed-back text\'s check)',
    previewKeyRef: '#4503: the mark\'s own target (no tool)',
  },
  submitMessage: {},
  sendWithBriefChoice: {},
  confirmRetarget: {},
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
function passiveCopies(src: string): Set<string> {
  const refs = new Set<string>();
  for (const m of src.matchAll(/\buseEffect\(\s*\(\)\s*=>\s*\{/g)) {
    let body = blockAt(src, (m.index ?? 0) + m[0].length - 1);
    const cleanup = /return\s*\(\)\s*=>\s*\{/.exec(body);
    if (cleanup) {
      const open = cleanup.index + cleanup[0].length - 1;
      body = body.slice(0, cleanup.index) + body.slice(open + blockAt(body, open).length);
    }
    for (const a of body.matchAll(/(\w+Ref)\.current\s*(?:=(?!=)|\+=|-=|\+\+|--)/g)) refs.add(a[1]);
  }
  return refs;
}

/** Refs a decision function reads before its first `await`. */
function readsAtPress(src: string, name: string): Set<string> {
  const m = new RegExp(`const ${name} = useCallback\\(\\s*(?:async\\s*)?\\([^)]*\\)(?:\\s*:\\s*\\w+(?:\\[\\])?)?\\s*=>\\s*\\{`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  let body = blockAt(src, (m.index ?? 0) + m[0].length - 1);
  const firstAwait = body.search(/\bawait\b/);
  if (firstAwait >= 0) body = body.slice(0, firstAwait);
  return new Set([...body.matchAll(/(\w+Ref)\.current/g)].map((x) => x[1]));
}

function offending(source: string, names: string[], allowed: Record<string, Record<string, string>>): string[] {
  const src = stripComments(source);
  const copies = passiveCopies(src);
  const found: string[] = [];
  for (const name of names) {
    for (const ref of readsAtPress(src, name)) if (copies.has(ref) && !(ref in (allowed[name] ?? {}))) found.push(`${name}: ${ref}`);
  }
  return found.sort();
}

describe('[#4604] T-c: the send\'s check reads the key of the text it sends, not a passive copy', () => {
  const src = fs.readFileSync(MESSAGE_INPUT, 'utf8');

  it('every decision function is found (comments out)', () => {
    for (const name of DECISIONS) expect(() => readsAtPress(stripComments(src), name)).not.toThrow();
  });

  it('no decision reads a passive copy outside its own list — `draftKeyRef` only in #4503\'s resend check', () => {
    expect(offending(src, DECISIONS, ALLOWED)).toEqual([]);
  });

  it('the text and its key are one state, and the check is given the text\'s key', () => {
    const code = stripComments(src);
    expect(code).toMatch(/useState<\{ key: string; text: string \}>/);
    expect(code).toMatch(/holdsRetargetedSend\([^)]*draft\.key\)/);
    expect(code).toMatch(/currentRetargetTags\(draft\.key\)/);
    // A send whose text is another draft's (the key changed, the restore has not run) sends nothing.
    expect(code.match(/if \(draft\.key !== draftKey\) return;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  describe('controls on a source under os.tmpdir()', () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      dir = null;
    });
    function sample(check: string): string {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-refs-4604-'));
      const file = path.join(dir, 'Sample.tsx');
      fs.writeFileSync(
        file,
        [
          'function Sample({ draftKey }: { draftKey: string }) {',
          '  const draftKeyRef = useRef(draftKey);',
          '  useEffect(() => {',
          '    draftKeyRef.current = draftKey;',
          '  }, [draftKey]);',
          '  const submitMessage = useCallback(async () => {',
          check,
          '    await post();',
          '    if (draftKeyRef.current !== draftKey) return;',
          '  }, [draftKey]);',
          '}',
        ].join('\n'),
      );
      return fs.readFileSync(file, 'utf8');
    }

    it('positive: a decision reading `draftKeyRef` at the press is found', () => {
      expect(offending(sample('    readStore(draftKeyRef.current);'), ['submitMessage'], {})).toEqual(['submitMessage: draftKeyRef']);
    });

    it('negative: the read after the first await, or a comment that says "await" first, is not', () => {
      expect(offending(sample('    readStore(draftKey);'), ['submitMessage'], {})).toEqual([]);
      expect(offending(sample('    // await nothing\n    readStore(draftKeyRef.current);'), ['submitMessage'], {})).toEqual(['submitMessage: draftKeyRef']);
    });
  });
});
