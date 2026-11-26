/**
 * Issue #4604＋#4606 r3c: every `POST /send` the page makes from a tile or a composer goes through one
 * gate — counted statically, so a new exit that skips the gate is red here even if no row of the exits
 * table (`send-exits-invariant-4604.test.tsx`) reaches it.
 *
 * How it counts. Every `.ts`/`.tsx` file under `src/` is read with its comments stripped, and each place
 * a `/send` request can start is found by these forms (the only ways `src/` builds one today — looked up
 * with `git grep` when this was written):
 * - the URL itself: a string or template ending in `/send` (`` `/api/worktrees/${id}/send` ``, `${base}/send`);
 * - `worktreeApi.sendMessage(` — the page's client of that URL (`src/lib/api-client.ts`);
 * - `sendMessageForHandoffPage(` — the same call as a page's operation (`src/lib/handoff/page-owner.ts`).
 *
 * The allowed places, each with why (anything else is red):
 * - `src/lib/api-client.ts` — `worktreeApi.sendMessage` builds the URL: the layer every UI call ends in.
 * - `src/lib/handoff/page-owner.ts` — `sendMessageForHandoffPage` is that call with the page's gate.
 * - `src/lib/handoff/screen-client.ts` — the handoff screen's `sendText` (its own screen, not a tile or a composer).
 * - `src/lib/new-task/send-new-task.ts` — the new-task dialog's launch (not a tile or a composer).
 * - `src/hooks/useOptimisticPaneMessages.ts` — the worktree screen's optimistic layer (the composer's
 *   checks run before it hands the send over; the tile has its own layer, below).
 * - `src/components/worktree/MobileTerminalTab.tsx` — the model picker's fixed command (no draft, no To change).
 * - `src/cli/` — the CLI (not the page).
 * - `src/components/sessions/SessionTile.tsx` — exactly one call, inside its gate `sendThroughStaleTargetGate`
 *   (every POST of the tile's pending layer: a new send, [retry], the automatic resend).
 * - `src/components/worktree/MessageInput.tsx` — exactly one call, inside its gate `postThroughGate`
 *   (the awaited send and the brief's choice).
 * The gate's extent is from its declaration to the next `const … = useCallback(` (the files' style).
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

const FORMS: Array<[string, RegExp]> = [
  ['url', /\/send[`'"]/g],
  ['worktreeApi.sendMessage', /worktreeApi\.sendMessage\(/g],
  ['sendMessageForHandoffPage', /\bsendMessageForHandoffPage\(/g],
];

interface Site {
  file: string;
  form: string;
  index: number;
}

function sites(): Site[] {
  const found: Site[] = [];
  for (const path of walk(SRC)) {
    const file = relative(ROOT, path).split('\\').join('/');
    const code = stripComments(readFileSync(path, 'utf8'));
    for (const [form, re] of FORMS) {
      re.lastIndex = 0;
      for (let m = re.exec(code); m; m = re.exec(code)) {
        // The declaration of the function itself is not a call of it.
        const before = code.slice(Math.max(0, m.index - 20), m.index);
        if (/function\s+$/.test(before)) continue;
        found.push({ file, form, index: m.index });
      }
    }
  }
  return found;
}

const ALLOWED_ANYWHERE = new Set([
  'src/lib/api-client.ts',
  'src/lib/handoff/page-owner.ts',
  'src/lib/handoff/screen-client.ts',
  'src/lib/new-task/send-new-task.ts',
  'src/hooks/useOptimisticPaneMessages.ts',
  'src/components/worktree/MobileTerminalTab.tsx',
]);
const GATED: Record<string, string> = {
  'src/components/sessions/SessionTile.tsx': 'sendThroughStaleTargetGate',
  'src/components/worktree/MessageInput.tsx': 'postThroughGate',
};

function gateExtent(file: string, gate: string): [number, number] | null {
  const code = stripComments(readFileSync(join(ROOT, file), 'utf8'));
  const start = code.search(new RegExp(`const\\s+${gate}\\s*=`));
  if (start < 0) return null;
  const rest = code.slice(start + 1);
  const next = rest.search(/\n\s*const\s+\w+\s*=\s*useCallback\(/);
  return [start, next < 0 ? code.length : start + 1 + next];
}

describe('[#4604+#4606 r3c] every `/send` from a tile or a composer goes through its gate (static count)', () => {
  const all = sites();

  it('finds the `/send` call sites at all (the forms still match the code)', () => {
    expect(all.some((site) => site.file === 'src/lib/api-client.ts' && site.form === 'url')).toBe(true);
    expect(all.some((site) => site.file === 'src/components/sessions/SessionTile.tsx')).toBe(true);
    expect(all.some((site) => site.file === 'src/components/worktree/MessageInput.tsx')).toBe(true);
  });

  it('no `/send` call outside the allowed places', () => {
    const outside = all
      .filter((site) => !site.file.startsWith('src/cli/') && !site.file.startsWith('src/app/api/'))
      .filter((site) => !ALLOWED_ANYWHERE.has(site.file) && !(site.file in GATED))
      .map((site) => `${site.file} (${site.form})`);
    expect(outside).toEqual([]);
  });

  it.each(Object.entries(GATED))('%s: exactly one `/send` call, inside %s', (file, gate) => {
    const inFile = all.filter((site) => site.file === file);
    expect(inFile.map((site) => site.form)).toHaveLength(1);
    const extent = gateExtent(file, gate);
    expect(extent).not.toBeNull();
    const [start, end] = extent!;
    expect(inFile[0].index).toBeGreaterThan(start);
    expect(inFile[0].index).toBeLessThan(end);
  });
});
