/**
 * The shape of the strict choice's claim (Issue #4227 pr3f, the invariant S-B-commit, design
 * `docs/design/mem-ui-4227.md` §3.2, root-cause `pm-rootcause-4227-sb.md` §4 "構造のガード").
 *
 * A `full` / `decline` send types the `text` of `commitStrict`'s answer and nothing else. What would
 * let a forgotten way out type the body is kept out of the strict methods by their source:
 *  - `claimStrict` never names the operator's body (`this.input.content`) nor a `??` default — the
 *    text is the commit's;
 *  - none of the strict methods calls D1's fail-open parts (`skip`, `skipped`, `claimInStretch`) or
 *    the plan's stop (`refuse`), or reads a flag beside the answer (`this.aborted`);
 *  - every `catch` in them answers an abort (`abort(`) — none swallows a failure into a type.
 *
 * Reads the module's source only. Its own controls run the reader on sources written here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const SOURCE = readFileSync(path.join(process.cwd(), 'src/lib/session/session-brief.ts'), 'utf8');

/** The strict road, in order. A method renamed or removed fails the first check. */
const STRICT_METHODS = ['claimStrict', 'commitInFinalStretch', 'finalStretch', 'finalReading', 'commitStrict', 'reserveStrict', 'claimRowStrict'];

/** Strip comments (a name in prose is not a call). */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/**
 * The body of a class method (`private name(` / `private async name(` … its braces), or null. The body
 * opens at the first ` {` ending a line after the parameters (a return type's braces stay inline).
 */
function methodBody(source: string, name: string): string | null {
  const head = new RegExp(`\\n\\s*(?:private |public )?(?:async )?${name}\\(`).exec(source);
  if (!head) return null;
  let i = source.indexOf('(', head.index);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) break;
  }
  const open = source.indexOf(' {\n', i) + 1;
  if (open <= 0) return null;
  depth = 0;
  let end = open;
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++;
    else if (source[end] === '}' && --depth === 0) break;
  }
  return source.slice(open, end + 1);
}

/** Each `catch (…) { … }` block of a body. */
function catchBlocks(body: string): string[] {
  const blocks: string[] = [];
  for (const match of body.matchAll(/catch\s*(?:\([^)]*\))?\s*\{/g)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < body.length; end++) {
      if (body[end] === '{') depth++;
      else if (body[end] === '}' && --depth === 0) break;
    }
    blocks.push(body.slice(match.index, end + 1));
  }
  return blocks;
}

interface Breach {
  method: string;
  what: string;
}

/** The reader: the strict methods of a source against the invariant's shape. */
function read(source: string, methods: string[]): Breach[] {
  const body = code(source);
  const breaches: Breach[] = [];
  for (const method of methods) {
    const text = methodBody(body, method);
    if (text === null) {
      breaches.push({ method, what: 'missing' });
      continue;
    }
    if (method === 'claimStrict') {
      if (/this\.input\.content/.test(text)) breaches.push({ method, what: 'names the body' });
      if (/\?\?/.test(text)) breaches.push({ method, what: '?? default' });
    }
    for (const part of ['this.skip(', 'this.skipped(', 'this.claimInStretch(', 'this.refuse(', 'this.aborted']) {
      if (text.includes(part)) breaches.push({ method, what: part });
    }
    for (const block of catchBlocks(text)) {
      if (!/\babort\(/.test(block)) breaches.push({ method, what: 'a catch with no abort' });
    }
  }
  return breaches;
}

describe('[#4227 pr3f] the strict claim is one road: the commit’s answer, and every failure an abort', () => {
  it('the module’s strict methods', () => {
    expect(read(SOURCE, STRICT_METHODS)).toEqual([]);
  });

  it('every strict method was found, and each has its catch (the reader is not reading nothing)', () => {
    const body = code(SOURCE);
    for (const method of STRICT_METHODS) expect(methodBody(body, method), method).not.toBeNull();
    for (const method of ['commitInFinalStretch', 'finalStretch', 'reserveStrict', 'claimRowStrict']) {
      expect(catchBlocks(methodBody(body, method)!).length, method).toBeGreaterThan(0);
    }
  });
});

describe('the reader’s own controls (sources written here)', () => {
  const wrap = (method: string, inner: string) => `class A {\n  private async ${method}(): Promise<string> {\n${inner}\n  }\n}\n`;

  it('positive: the body as a default in claimStrict is found (P3-2 `typedText ?? this.input.content`)', () => {
    const source = wrap('claimStrict', '    const typedText = await f();\n    return typedText ?? this.input.content;');
    expect(read(source, ['claimStrict'])).toEqual([
      { method: 'claimStrict', what: 'names the body' },
      { method: 'claimStrict', what: '?? default' },
    ]);
  });

  it('positive: a catch that swallows (the old `skip`) and a call into D1’s parts are found', () => {
    const source = wrap('commitStrict', "    try {\n      write();\n    } catch (error) {\n      warn(error);\n    }\n    this.skip(row, 'empty', 'claim.consume');\n    return 'x';");
    expect(read(source, ['commitStrict'])).toEqual([
      { method: 'commitStrict', what: 'this.skip(' },
      { method: 'commitStrict', what: 'a catch with no abort' },
    ]);
  });

  it('positive: a flag read beside the answer is found; a method gone is reported missing', () => {
    const source = wrap('finalStretch', '    if (this.aborted) throw this.aborted;\n    return x;');
    expect(read(source, ['finalStretch', 'commitStrict'])).toEqual([
      { method: 'finalStretch', what: 'this.aborted' },
      { method: 'commitStrict', what: 'missing' },
    ]);
  });

  it('negative: a catch answering an abort, and a return type with braces, are read through', () => {
    const source =
      "class A {\n  private reading(db: D): { type: 'pass'; row: R } | StrictAbort {\n    try {\n      return read(db);\n    } catch (error) {\n      return abort('claim_failed');\n    }\n  }\n}\n";
    expect(read(source, ['reading'])).toEqual([]);
  });
});
