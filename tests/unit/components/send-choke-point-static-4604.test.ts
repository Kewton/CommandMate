/**
 * Issue #4604＋#4606 r3c・r4: every `POST /send` the page makes from a tile or a composer goes through one
 * gate — counted statically, so a new exit that skips the gate is red here even if no row of the exits
 * table (`send-exits-invariant-4604.test.tsx`) reaches it.
 *
 * How it counts (r4, by position — the review b's MS1・MS2 and the review a's forms were not counted by
 * the r3c version). Every `.ts`/`.tsx` file under `src/` is read with its comments blanked.
 *
 * 1. In the tile and the composer (`SessionTile.tsx`・`MessageInput.tsx`), every **reference** — called or
 *    not — to a sender is a position: `worktreeApi`, `sendMessageForHandoffPage`, `handoffApi`, `sendText`,
 *    `useOptimisticPaneMessages(`, a `sendMessage` property or name (`.sendMessage`, `?.sendMessage`,
 *    `['sendMessage']`, `{ sendMessage }`), and a URL ending in `/send` (or `/send?…`). Each must lie inside
 *    the file's gate function (its whole body, braces matched) — the import line itself is not a position,
 *    but an import that renames a sender (`as`) is red (an alias would hide every later position).
 * 2. The wiring: the tile's pending layer is given the tile's gate as its only `sendFn`; the tile hands the
 *    composer the function that reads its holds when called (`isSendHeld`, INV-P2) and its optimistic
 *    layer (`onOptimisticSend={sendOptimistic}`); the composer's gate calls `isSendHeld`.
 * 3. Everywhere else under `src/` (not the CLI, not the API routes — their `'api/send'` logger names are not
 *    requests), the call positions of the senders are pinned by file and count, each with why (below). A
 *    new one anywhere is red.
 *
 * The pinned places:
 * - `src/lib/api-client.ts` — `worktreeApi.sendMessage` builds the URL: 1 (the layer every UI call ends in).
 * - `src/lib/handoff/page-owner.ts` — `sendMessageForHandoffPage` is that call with the page's gate: 2.
 * - `src/lib/handoff/screen-client.ts` — the handoff screen's `sendText` URL: 1.
 * - `src/components/mem/SessionHandoffDialog.tsx` — that screen's `sendText` calls (its own dialog, not a tile
 *   or a composer; opened from the detail route only): 3.
 * - `src/lib/new-task/send-new-task.ts` — the new-task dialog's launch URL: 1.
 * - `src/hooks/useOptimisticPaneMessages.ts` — the worktree screen's optimistic layer: 1 (the composer's
 *   checks run before it hands the send over; that screen has no hold, and its retries keep the To and
 *   text the composer checked).
 * - `src/components/worktree/MobileTerminalTab.tsx` — the model picker's fixed command (no draft): 1.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const SRC = join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** The source with its comments blanked (kept the same length, so offsets stay). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
}

/** Plain string literals blanked ('…' and "…"; a template keeps its text — a URL is built in one). */
function stripStrings(code: string): string {
  return code.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0]);
}

/** The forms of a reference to a sender (rule 1). `code` forms are read with the plain strings blanked. */
const REFERENCE_FORMS: Array<[string, RegExp, 'code' | 'raw']> = [
  ['worktreeApi', /\bworktreeApi\b/g, 'code'],
  ['sendMessageForHandoffPage', /\bsendMessageForHandoffPage\b/g, 'code'],
  ['handoffApi', /\bhandoffApi\b/g, 'code'],
  ['sendText', /\bsendText\b/g, 'code'],
  ['useOptimisticPaneMessages(', /\buseOptimisticPaneMessages\s*\(/g, 'code'],
  ['sendMessage', /(?:\.|\?\.|\{\s*|,\s*)sendMessage\b/g, 'code'],
  ["['sendMessage']", /\[\s*['"`]sendMessage['"`]\s*\]/g, 'raw'],
  ['url /send', /\/send(?:[`'"?])/g, 'raw'],
];
const SENDER_NAMES = ['worktreeApi', 'sendMessageForHandoffPage', 'handoffApi', 'sendText', 'useOptimisticPaneMessages', 'sendMessage'];

/** The call forms (rule 3). */
const CALL_FORMS: Array<[string, RegExp]> = [
  ['url /send', /\/send(?:[`'"?])/g],
  ['worktreeApi.sendMessage(', /worktreeApi\s*(?:\?\.|\.)\s*sendMessage\s*(?:\?\.)?\(/g],
  ['sendMessageForHandoffPage(', /\bsendMessageForHandoffPage\s*\(/g],
  ['sendText(', /\bsendText\s*(?:\?\.)?\(/g],
];

/** [start, end) of the statement `import … from '…';` around each import, so positions in them are skipped. */
function importSpans(code: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /^import\s[\s\S]*?from\s*['"][^'"]+['"];?/gm;
  for (let m = re.exec(code); m; m = re.exec(code)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/** The whole extent of `const <name> = …` up to the end of its body (braces matched from the first `{` of the body). */
function functionExtent(code: string, name: string): [number, number] | null {
  const start = code.search(new RegExp(`const\\s+${name}\\s*=`));
  if (start < 0) return null;
  const arrow = code.indexOf('=>', start);
  if (arrow < 0) return null;
  const open = code.indexOf('{', arrow);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return [start, i + 1];
    }
  }
  return null;
}

interface Gated {
  file: string;
  gate: string;
}
const GATED: Gated[] = [
  { file: 'src/components/sessions/SessionTile.tsx', gate: 'sendThroughStaleTargetGate' },
  { file: 'src/components/worktree/MessageInput.tsx', gate: 'postThroughGate' },
];

/** Rule 1 on one source: the positions of a sender outside the gate, and the renaming imports. */
function outsideGate(source: string, gate: string): string[] {
  const code = stripComments(source);
  const extent = functionExtent(code, gate);
  const found: string[] = [];
  if (!extent) return [`no gate ${gate}`];
  const imports = importSpans(code);
  for (const [start, end] of imports) {
    const text = code.slice(start, end);
    for (const name of SENDER_NAMES) {
      if (new RegExp(`\\b${name}\\s+as\\s+\\w+`).test(text)) found.push(`import renames ${name}`);
    }
  }
  const inImport = (i: number) => imports.some(([s, e]) => i >= s && i < e);
  const noStrings = stripStrings(code);
  for (const [form, re, read] of REFERENCE_FORMS) {
    const text = read === 'code' ? noStrings : code;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (inImport(m.index)) continue;
      if (m.index > extent[0] && m.index < extent[1]) continue;
      const line = code.slice(0, m.index).split('\n').length;
      found.push(`${form} at line ${line}`);
    }
  }
  return found;
}

function callSites(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of walk(SRC)) {
    const file = relative(ROOT, path).split('\\').join('/');
    if (file.startsWith('src/cli/') || file.startsWith('src/app/api/')) continue;
    if (GATED.some((g) => g.file === file)) continue;
    const code = stripComments(readFileSync(path, 'utf8'));
    for (const [, re] of CALL_FORMS) {
      re.lastIndex = 0;
      for (let m = re.exec(code); m; m = re.exec(code)) {
        // The declaration of a sender is not a call of it (`function sendMessageForHandoffPage(`, `sendText: (`).
        const before = code.slice(Math.max(0, m.index - 20), m.index);
        if (/function\s+$/.test(before)) continue;
        counts.set(file, (counts.get(file) ?? 0) + 1);
      }
    }
  }
  return counts;
}

const PINNED: Record<string, number> = {
  'src/lib/api-client.ts': 1,
  'src/lib/handoff/page-owner.ts': 2,
  'src/lib/handoff/screen-client.ts': 1,
  'src/components/mem/SessionHandoffDialog.tsx': 3,
  'src/lib/new-task/send-new-task.ts': 1,
  'src/hooks/useOptimisticPaneMessages.ts': 1,
  'src/components/worktree/MobileTerminalTab.tsx': 1,
};

describe('[#4604+#4606 r4] every `/send` from a tile or a composer goes through its gate (static count)', () => {
  it.each(GATED.map((g) => [g.file, g.gate] as const))('%s: no reference to a sender outside %s', (file, gate) => {
    expect(outsideGate(readFileSync(join(ROOT, file), 'utf8'), gate)).toEqual([]);
  });

  it('the tile\'s wiring: one `sendFn` (its gate), `isSendHeld` and its optimistic layer handed to the composer', () => {
    const tile = stripComments(readFileSync(join(ROOT, 'src/components/sessions/SessionTile.tsx'), 'utf8'));
    expect(tile.match(/\bsendFn\s*:/g) ?? []).toHaveLength(1);
    expect(tile).toMatch(/\bsendFn\s*:\s*sendThroughStaleTargetGate\b/);
    expect(tile).toMatch(/onOptimisticSend=\{sendOptimistic\}/);
    expect(tile).toMatch(/isSendHeld=\{/);
  });

  it('the composer\'s gate reads the hold when it is called (`isSendHeld`, INV-P2), not a render\'s copy', () => {
    const input = stripComments(readFileSync(join(ROOT, 'src/components/worktree/MessageInput.tsx'), 'utf8'));
    const extent = functionExtent(input, 'checkGate');
    expect(extent).not.toBeNull();
    const body = input.slice(extent![0], extent![1]);
    expect(body).toMatch(/\bisSendHeld\b/);
    expect(body).not.toMatch(/sendBlockedReasonRef/);
  });

  it('[#4606 r4e] the tile\'s record of holds is the first value: every write to `staleHoldsRef.current` starts from it, never a render\'s list', () => {
    const tile = stripComments(readFileSync(join(ROOT, 'src/components/sessions/SessionTile.tsx'), 'utf8'));
    // The right-hand side of each `staleHoldsRef.current =` (not `==`), up to the end of its statement.
    const writes = [...tile.matchAll(/\bstaleHoldsRef\.current\s*=(?!=)([^;]*);/g)].map((m) => m[1].trim());
    expect(writes.length).toBeGreaterThan(0);
    for (const rhs of writes) {
      expect(rhs, rhs).toMatch(/^(?:withHold|nextStaleTargetHolds)\(\s*staleHoldsRef\.current\b/);
      expect(rhs, rhs).not.toMatch(/\b(?:keptHolds|staleHolds)\b/);
    }
  });

  it('elsewhere in `src/`: the call positions are the pinned ones, by file and count', () => {
    expect(Object.fromEntries(callSites())).toEqual(PINNED);
  });

  describe('controls (sources made here, not files of the repository)', () => {
    const GATE = [
      "import { worktreeApi } from '@/lib/api-client';",
      'function Tile() {',
      '  const sendThroughStaleTargetGate = useCallback(async (c: string, o: Options) => {',
      '    if (held()) return SEND_HELD_BY_GATE;',
      '    return await worktreeApi.sendMessage(id, c, o);',
      '  }, [id]);',
      '  const other = useCallback(() => {',
      '  }, []);',
      '__EXTRA__',
      '}',
    ].join('\n');
    const withExtra = (extra: string) => GATE.replace('__EXTRA__', extra);

    it('negative: the call inside the gate only — nothing outside', () => {
      expect(outsideGate(withExtra(''), 'sendThroughStaleTargetGate')).toEqual([]);
    });

    it.each([
      ['MS1: a sender held as a value', '  const sendRaw = worktreeApi.sendMessage;\n  sendRaw(id, c, o);'],
      ['MS2: the handoff sender', "  handoffApi.sendText(id, c, o);"],
      ['destructured', '  const { sendMessage } = worktreeApi;\n  sendMessage(id, c, o);'],
      ['by index', "  worktreeApi['sendMessage'](id, c, o);"],
      ['optional call', '  worktreeApi.sendMessage?.(id, c, o);'],
      ['a URL with a query', "  fetch(`/api/worktrees/${id}/send?x=1`, { method: 'POST' });"],
      ['the worktree screen\'s layer', '  useOptimisticPaneMessages({ worktreeId: id });'],
      ['a function after the gate (not inside it)', '  function later() { return worktreeApi.sendMessage(id, c, o); }'],
    ])('positive (%s): found outside the gate', (_name, extra) => {
      expect(outsideGate(withExtra(extra), 'sendThroughStaleTargetGate').length).toBeGreaterThan(0);
    });

    it('positive: an import that renames a sender', () => {
      const source = withExtra('').replace("import { worktreeApi } from '@/lib/api-client';", "import { worktreeApi as api } from '@/lib/api-client';");
      expect(outsideGate(source, 'sendThroughStaleTargetGate')).toContain('import renames worktreeApi');
    });
  });
});
