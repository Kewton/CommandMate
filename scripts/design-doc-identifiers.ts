/**
 * Audit the identifiers a design document names against the code that exists
 * (Issue #1995).
 *
 * A design policy document under `docs/design/` is the 正本 an implementation
 * Issue is written from (#1915 / Epic #1921). When it names a function, a type,
 * a constant or a file that is not there, a worker either stops at "I cannot
 * find it" or builds a second one beside the real thing. That is not
 * hypothetical: #1900 renamed `readOpencodeEventStream` to
 * `openOpencodeEventStream` and left §10.4 / §13.2 pointing at the old name;
 * #1933 deleted `getStatusCaptureLines` and left four sections asking a future
 * Phase 3 to migrate it.
 *
 * ## What this can and cannot decide
 *
 * It cannot tell **陳腐化**（the code moved and the doc did not）from
 * **未実装**（the doc describes something still to build）. Both look identical
 * from outside: absent. Prose markers do not separate them either —「新設する」
 * sits in the same table as「既存の」, and #1939's move of `src/lib/__tests__/**`
 * falsified a sentence that said 既存.
 *
 * So it does not try. It reports the classification and leaves the judgement to
 * the caller, who writes it down **once** in an allowlist. What is mechanical —
 * and what the caller's guard pins — is the **transition**:
 *
 *   resolved → unresolved   a rename or a deletion just landed. This is the
 *                           moment staleness is born, and it can be a red build
 *                           at the commit that creates it rather than a
 *                           discovery two Epics later.
 *   unresolved → resolved   something planned has landed, so the document's
 *                           tense (and usually a `- [ ]`) is behind the tree.
 *
 * ## Classification
 *
 * - `ok`           — named in code outside comments. Not reported.
 * - `test-only`    — named only under `tests/`. Real, but not a production symbol.
 * - `comment-only` — named ONLY inside comments. This is the signature a removal
 *                    leaves behind: both #1900 and #1933 left exactly it. It is
 *                    also the signature of a design term a comment quotes before
 *                    it exists, so it is reported, never judged.
 * - `missing`      — nowhere at all.
 *
 * Usage:
 *   npx tsx scripts/design-doc-identifiers.ts docs/design/<name>.md [--json]
 *
 * @module scripts/design-doc-identifiers
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Where a symbol may live. Order matters: `src` decides `ok` vs `test-only`. */
const CODE_ROOTS = ['src', 'scripts', 'tests'] as const;
type CodeRoot = (typeof CODE_ROOTS)[number];

/** Where a path reference may resolve. Broader than CODE_ROOTS — docs cite docs. */
const PATH_ROOTS = ['src', 'tests', 'scripts', 'docs', '.github', '.commandmate', '.claude'];

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * This module and its guard are excluded from their own corpus.
 *
 * Both name the identifiers they exist to talk about — `readOpencodeEventStream`
 * is in the header above — and a guard that reads its own prose as evidence
 * resolves exactly the names it was written to catch.
 */
const SELF = [
  'scripts/design-doc-identifiers.ts',
  'tests/unit/docs/design-doc-identifier-audit.test.ts',
];

/**
 * A backtick span is a path when it has a separator and a file extension.
 * `@/lib/tmux/**` has neither an extension nor a file behind it — it is an
 * import glob for a lint rule, not a reference to something on disk.
 */
const PATH_SEPARATOR = /[/\\]/;
const PATH_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|sh|txt|css)(\b|$)/;

/**
 * Not repository references: a home path, a shell variable, a URL, or a path
 * written with a leading ellipsis. The last one matters: §16 uses
 * `.../i/route.ts` as an illustration of a path minimatch would wrongly produce,
 * so its non-existence is the point being made.
 */
const NOT_REPO = /^(~|\$|https?:|\.\.\.)/;

/**
 * `dev-reports/` is generated per Issue and deliberately untracked, so citing
 * one of its files is never a defect here.
 */
const UNTRACKED_PREFIX = /^dev-reports\//;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export type FindingStatus = 'test-only' | 'comment-only' | 'missing';
export type SpanKind = 'path' | 'function' | 'member' | 'type' | 'constant' | 'symbol' | 'code';

export interface Finding {
  /** The backtick span exactly as the document wrote it. */
  text: string;
  kind: SpanKind;
  status: FindingStatus;
  /** 1-based line numbers the span appears on. */
  lines: number[];
  /** Where it was found, when it was found somewhere unconvincing. */
  detail: string;
}

interface CorpusFile {
  file: string;
  raw: string;
  bare: string;
}

export interface Corpus {
  code: Record<CodeRoot, CorpusFile[]>;
  index: string[];
}

/** Every file under `dir`, skipping the directories no source lives in. */
function walk(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, acc);
    else acc.push(path);
  }
  return acc;
}

/**
 * Remove comments so a name that survives only in prose does not read as code.
 *
 * Deliberately textual. A name that a regex literal or a `//` inside a string
 * happens to hide gets reported rather than resolved, and the caller's allowlist
 * absorbs it with a reason. Erring toward reporting is the safe direction — the
 * opposite error hides a real removal, which is the whole defect class here.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** `x/{a,b}.ts` → `x/a.ts`, `x/b.ts`. Recursive, so two groups expand to four. */
export function expandBraces(spec: string): string[] {
  const match = spec.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!match) return [spec];
  return match[2].split(',').flatMap((alt) => expandBraces(match[1] + alt.trim() + match[3]));
}

/**
 * `*`, `**` and a `<tool>`-style placeholder all mean "some segment goes here".
 * §11 writes `tests/unit/detection/tools/<tool>/fixtures.test.ts` for three real
 * files; matching that literally would report all three as missing.
 */
function toSuffixMatcher(spec: string): RegExp {
  const escaped = spec.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replace(/<[^>]+>/g, '[^/]+')
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*');
  return new RegExp(`(^|/)${pattern}$`);
}

/**
 * Resolve one path span, returning the first variant that resolved to nothing.
 *
 * A document cites `auto-yes/route.ts` for
 * `src/app/api/worktrees/[id]/auto-yes/route.ts`, so the resolution rule is a
 * suffix match on a `/` boundary, not string equality.
 */
export function resolvePath(spec: string, index: string[]): string | null {
  for (const variant of expandBraces(spec)) {
    const bare = variant.replace(/^@\//, 'src/').replace(/^\.\//, '');
    if (!/[*<]/.test(bare)) {
      try {
        statSync(join(REPO_ROOT, bare));
        continue;
      } catch {
        /* not a literal path in the tree; try the suffix match below */
      }
    }
    const matcher = toSuffixMatcher(bare);
    if (!index.some((file) => matcher.test(file))) return variant;
  }
  return null;
}

/**
 * Every backtick span in the document, mapped to the lines it appears on.
 *
 * Fenced blocks are read too, but only for what they *declare* or name in *type
 * position*. A sketch's body is prose about code that does not exist yet, while
 * `detect(frame): ToolStatusVerdict` names a return type the reader is meant to
 * go and find.
 */
export function extractSpans(markdown: string): Map<string, number[]> {
  const lines = markdown.split('\n');
  const spans = new Map<string, number[]>();
  const add = (text: string, line: number): void => {
    const key = text.trim();
    if (!key) return;
    const seen = spans.get(key);
    if (!seen) spans.set(key, [line]);
    else if (!seen.includes(line)) seen.push(line);
  };

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      const declared = line.match(/\b(?:interface|class|enum)\s+([A-Z][A-Za-z0-9_]*)/);
      if (declared) add(declared[1], i + 1);
      const typed = line.match(/:\s*([A-Z][A-Za-z0-9_]*)\s*[;)|]/);
      if (typed) add(typed[1], i + 1);
      continue;
    }
    const inline = /`([^`\n]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = inline.exec(line)) !== null) add(match[1], i + 1);
  }
  return spans;
}

/**
 * Classify one span, or return null when it is not a repository reference at
 * all — prose, a literal value, or a single lowercase word (`ready`, `running`,
 * `wait`) whose meaning is a status value or a command name, not a symbol.
 */
export function classifySpan(text: string): { kind: SpanKind; key: string } | null {
  if (NOT_REPO.test(text) || UNTRACKED_PREFIX.test(text)) return null;
  if (PATH_SEPARATOR.test(text) && PATH_EXT.test(text)) return { kind: 'path', key: text };

  const call = text.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\(\s*(?:\.\.\.|…)?\s*\)$/);
  if (call) return { kind: 'function', key: call[1] };

  const member = text.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)(\(\s*\))?$/);
  if (member) return { kind: 'member', key: member[2] };

  if (!IDENT.test(text)) return null;
  if (/^[A-Z][A-Z0-9_]+$/.test(text)) return { kind: 'constant', key: text };
  if (/^[A-Z][A-Za-z0-9]*$/.test(text)) return { kind: 'type', key: text };
  /* A reason code (`port_identity_changed`) is a published string literal, and
     it goes stale exactly the way a function name does. */
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(text)) return { kind: 'code', key: text };
  if (/^[a-z$_][A-Za-z0-9_$]*$/.test(text) && /[A-Z]/.test(text)) return { kind: 'symbol', key: text };
  return null;
}

/** Read the tree once, so a caller auditing several documents pays for it once. */
export function loadCorpus(): Corpus {
  const code = { src: [], scripts: [], tests: [] } as Record<CodeRoot, CorpusFile[]>;
  for (const root of CODE_ROOTS) {
    for (const path of walk(join(REPO_ROOT, root))) {
      if (!CODE_EXT.test(path)) continue;
      const file = relative(REPO_ROOT, path);
      if (SELF.includes(file)) continue;
      const raw = readFileSync(path, 'utf8');
      code[root].push({ file, raw, bare: stripComments(raw) });
    }
  }

  const index: string[] = [];
  for (const root of PATH_ROOTS) {
    if (!existsSync(join(REPO_ROOT, root))) continue;
    for (const path of walk(join(REPO_ROOT, root))) index.push(relative(REPO_ROOT, path));
  }
  for (const entry of readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (entry.isFile()) index.push(entry.name);
  }
  return { code, index };
}

/**
 * Audit one design document.
 *
 * @returns one finding per span that did not resolve to production code, sorted
 *          by `text` so a caller's allowlist is a stable, reviewable list.
 */
export function auditDesignDoc(docPath: string, corpus: Corpus = loadCorpus()): Finding[] {
  const markdown = readFileSync(resolve(REPO_ROOT, docPath), 'utf8');
  const findings: Finding[] = [];

  for (const [text, lines] of extractSpans(markdown)) {
    const span = classifySpan(text);
    if (!span) continue;

    if (span.kind === 'path') {
      const unresolved = resolvePath(span.key, corpus.index);
      if (unresolved) findings.push({ text, kind: 'path', status: 'missing', lines, detail: unresolved });
      continue;
    }

    const word = new RegExp(`\\b${span.key.replace(/\$/g, '\\$')}\\b`);
    const hits = (root: CodeRoot, field: 'raw' | 'bare'): string[] =>
      corpus.code[root].filter((f) => word.test(f[field])).map((f) => f.file);

    if (hits('src', 'bare').length > 0 || hits('scripts', 'bare').length > 0) continue;

    const inTests = hits('tests', 'bare');
    const inComments = [...hits('src', 'raw'), ...hits('tests', 'raw'), ...hits('scripts', 'raw')];
    const status: FindingStatus =
      inTests.length > 0 ? 'test-only' : inComments.length > 0 ? 'comment-only' : 'missing';

    findings.push({
      text,
      kind: span.kind,
      status,
      lines,
      detail: (inTests.length > 0 ? inTests : inComments).slice(0, 2).join(', '),
    });
  }

  return findings.sort((a, b) => a.text.localeCompare(b.text));
}

/* -------------------------------------------------------------------------- */

/**
 * CLI mode. Reporting only — it never sets a non-zero exit code, because the
 * judgement of whether a given unresolved name is 未実装 or 陳腐化 lives in the
 * caller's allowlist (see `tests/unit/docs/design-doc-identifier-audit.test.ts`),
 * not here.
 */
function main(argv: string[]): void {
  const asJson = argv.includes('--json');
  const targets = argv.filter((arg) => !arg.startsWith('--'));
  if (targets.length === 0) {
    console.error('usage: npx tsx scripts/design-doc-identifiers.ts <doc.md> [...] [--json]');
    process.exitCode = 2;
    return;
  }
  const corpus = loadCorpus();
  const all = targets.flatMap((target) => auditDesignDoc(target, corpus).map((f) => ({ doc: target, ...f })));
  if (asJson) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }
  for (const f of all) {
    const where = f.lines.slice(0, 5).join(',');
    console.log(`${f.status.padEnd(12)} ${f.kind.padEnd(9)} ${f.text.padEnd(50)} L${where}  ${f.detail}`);
  }
  console.error(`\n${all.length} unresolved reference(s) across ${targets.length} document(s).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
