/**
 * Appending a decision's block to a document (Issue #4225, design §3.3・§3.4・§5.3):
 * T5b・T5c・T5d・T5e・T12 and the block search of T21, against real files in a
 * `mkdtemp` sandbox (removed after each test). Each positive control runs the shape
 * the design rejected, inline, and shows it losing what E keeps.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { checkDocPath, docBaseFingerprint } from '@/lib/promote/destination';
import { docBlockOf, findDocBlock, reclaimDocLeftovers, reconcileDocBlock, tempNameOf, writeDocBlock } from '@/lib/promote/doc-write';
import { sha256 } from '@/lib/promote/render';

const OP = '11111111-2222-4333-8444-555555555555';
const OP2 = '22222222-3333-4444-8555-666666666666';
const BODY = '<!-- commandmate-promote:op=x; item=i -->\n決定\n```\ntext\n```';

let dir: string;
let root: string;
const file = (rel: string) => path.join(root, rel);

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'promote-doc-4225-'));
  root = path.join(dir, 'wt');
  mkdirSync(path.join(root, 'docs'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, hooks = {}, op = OP, leftovers: Map<string, string | null> = new Map()) =>
  writeDocBlock({ root, rel, operationId: op, body: BODY, baseFingerprint: docBaseFingerprint(file(rel)), leftovers }, hooks);

describe('an existing document: append only (T5b)', () => {
  it('(control) nothing else writes → the content is exactly base + block, no concurrent edit', () => {
    writeFileSync(file('docs/d.md'), '# 既存\n');
    const out = write('docs/d.md');
    expect(out).toMatchObject({ result: 'success', concurrentEdit: false });
    expect(readFileSync(file('docs/d.md'), 'utf8')).toBe(`# 既存\n${docBlockOf(OP, BODY)}`);
  });

  it('another process rewrites the document after the last read → all of its content stays, one block added, concurrent_edit', () => {
    writeFileSync(file('docs/d.md'), '# 既存\n');
    const out = write('docs/d.md', { beforeAppend: (abs: string) => writeFileSync(abs, '# 他者が書き換えた\n本文\n') });
    expect(out).toMatchObject({ result: 'success', concurrentEdit: true });
    const after = readFileSync(file('docs/d.md'), 'utf8');
    expect(after.startsWith('# 他者が書き換えた\n本文\n')).toBe(true);
    expect(findDocBlock(after, OP, sha256(BODY))).toBe('found');
  });

  it('(positive control) the 2nd edition (temp file + rename of the old content + block) loses that change', () => {
    writeFileSync(file('docs/d.md'), '# 既存\n');
    const base = readFileSync(file('docs/d.md'), 'utf8');
    writeFileSync(file('docs/d.md'), '# 他者が書き換えた\n'); // between the last read and the rename
    writeFileSync(file('docs/.tmp'), base + docBlockOf(OP, BODY));
    renameSync(file('docs/.tmp'), file('docs/d.md'));
    expect(readFileSync(file('docs/d.md'), 'utf8')).not.toContain('他者が書き換えた');
  });

  it('a content that changed since the diff → not written (base_changed)', () => {
    writeFileSync(file('docs/d.md'), 'a\n');
    const base = docBaseFingerprint(file('docs/d.md'));
    writeFileSync(file('docs/d.md'), 'b\n');
    const out = writeDocBlock({ root, rel: 'docs/d.md', operationId: OP, body: BODY, baseFingerprint: base, leftovers: new Map() });
    expect(out).toEqual({ result: 'not_written', reason: 'base_changed', refusal: true });
    expect(readFileSync(file('docs/d.md'), 'utf8')).toBe('b\n');
  });

  it('a content without a final LF gets one before the block', () => {
    writeFileSync(file('docs/d.md'), 'no newline');
    write('docs/d.md');
    expect(readFileSync(file('docs/d.md'), 'utf8')).toBe(`no newline\n${docBlockOf(OP, BODY)}`);
  });
});

describe('T5c: a hard link is refused', () => {
  it('a document with two links (one outside the repository) → not written, the outside file unchanged', () => {
    writeFileSync(path.join(dir, 'outside.md'), 'outside\n');
    linkSync(path.join(dir, 'outside.md'), file('docs/d.md'));
    expect(write('docs/d.md')).toMatchObject({ result: 'not_written', reason: 'hardlink' });
    expect(readFileSync(path.join(dir, 'outside.md'), 'utf8')).toBe('outside\n');
  });

  it('(positive control) without the descriptor check the same open appends to the outside inode', () => {
    writeFileSync(path.join(dir, 'outside.md'), 'outside\n');
    linkSync(path.join(dir, 'outside.md'), file('docs/d.md'));
    const fd = openSync(file('docs/d.md'), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    writeSync(fd, 'leaked\n');
    closeSync(fd);
    expect(readFileSync(path.join(dir, 'outside.md'), 'utf8')).toContain('leaked');
  });
});

describe('T5d: a new document appears whole, by link', () => {
  it('(control) nothing else → the document holds exactly the block, no temporary name is left', () => {
    const out = write('docs/new.md');
    expect(out).toMatchObject({ result: 'success', concurrentEdit: false });
    expect(readFileSync(file('docs/new.md'), 'utf8')).toBe(docBlockOf(OP, BODY));
    expect(readdirSync(file('docs'))).toEqual(['new.md']);
    expect(statSync(file('docs/new.md')).nlink).toBe(1);
  });

  it('(a) another process makes the document before the link → EEXIST, not written, its content alone, the temporary name gone', () => {
    const out = write('docs/new.md', { beforeLink: (abs: string) => writeFileSync(abs, 'theirs\n') });
    expect(out).toEqual({ result: 'not_written', reason: 'base_changed', refusal: true });
    expect(readFileSync(file('docs/new.md'), 'utf8')).toBe('theirs\n');
    expect(readdirSync(file('docs'))).toEqual(['new.md']);
  });

  it('(positive control a) creating an empty file and writing at position 0 overwrites a write made in between', () => {
    const fd = openSync(file('docs/new.md'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    writeFileSync(file('docs/new.md'), 'theirs, written between the create and the write\n');
    writeSync(fd, docBlockOf(OP, BODY), 0);
    closeSync(fd);
    expect(readFileSync(file('docs/new.md'), 'utf8')).not.toContain('theirs, written between');
  });

  it('(b) another process appends after the link → its append stays, the block is found', () => {
    const out = write('docs/new.md', { afterLink: (abs: string) => appendFileSync(abs, 'appended by another\n') });
    expect(out).toMatchObject({ result: 'success', concurrentEdit: true });
    expect(readFileSync(file('docs/new.md'), 'utf8')).toBe(`${docBlockOf(OP, BODY)}appended by another\n`);
  });

  it('(c) a symlink put at the destination → EEXIST, the link target unchanged', () => {
    writeFileSync(path.join(dir, 'target.md'), 'target\n');
    const out = write('docs/new.md', { beforeLink: (abs: string) => symlinkSync(path.join(dir, 'target.md'), abs) });
    expect(out).toMatchObject({ result: 'not_written', reason: 'base_changed' });
    expect(readFileSync(path.join(dir, 'target.md'), 'utf8')).toBe('target\n');
    expect(lstatSync(file('docs/new.md')).isSymbolicLink()).toBe(true);
  });
});

describe('T5e: an ending between link and unlink, another append, then the next write (re-review R4)', () => {
  const crashAfterLink = () => {
    expect(() =>
      write('docs/new.md', {
        afterLink: () => {
          throw new Error('the process ended here');
        },
      })
    ).toThrow('the process ended here');
  };

  it('the reconcile finds the block and takes the temporary name back; a second item then appends', () => {
    crashAfterLink();
    const temp = file(`docs/${tempNameOf(OP)}`);
    expect(statSync(file('docs/new.md')).nlink).toBe(2);
    appendFileSync(file('docs/new.md'), 'appended by another\n');
    const leftovers = new Map([[OP, docBlockOf(OP, BODY)]]);
    expect(reconcileDocBlock(root, 'docs/new.md', OP, sha256(BODY), leftovers)).toBe('found');
    expect(existsSync(temp)).toBe(false);
    expect(statSync(file('docs/new.md')).nlink).toBe(1);
    const second = write('docs/new.md', {}, OP2, leftovers);
    expect(second).toMatchObject({ result: 'success', concurrentEdit: false });
    const after = readFileSync(file('docs/new.md'), 'utf8');
    expect(after).toContain('appended by another\n');
    expect(findDocBlock(after, OP, sha256(BODY))).toBe('found');
    expect(findDocBlock(after, OP2, sha256(BODY))).toBe('found');
  });

  it('(positive control) the rule before R4 (only a temporary file whose content is exactly the block) leaves it, and the next write is refused', () => {
    crashAfterLink();
    appendFileSync(file('docs/new.md'), 'appended by another\n');
    const temp = file(`docs/${tempNameOf(OP)}`);
    // The old rule: remove only when the content equals the block. It does not, now.
    if (readFileSync(temp, 'utf8') === docBlockOf(OP, BODY)) rmSync(temp);
    expect(existsSync(temp)).toBe(true);
    expect(write('docs/new.md', {}, OP2, new Map())).toMatchObject({ result: 'not_written', reason: 'hardlink' });
  });

  it('(control) without the other append the reconcile takes it back too and the content is exactly the block', () => {
    crashAfterLink();
    expect(reclaimDocLeftovers(file('docs/new.md'), new Map([[OP, docBlockOf(OP, BODY)]]))).toBe(1);
    expect(readFileSync(file('docs/new.md'), 'utf8')).toBe(docBlockOf(OP, BODY));
  });

  it('a temporary name of an id E does not know, and an unrelated hard link, are not taken back', () => {
    crashAfterLink();
    const temp = file(`docs/${tempNameOf(OP)}`);
    expect(reclaimDocLeftovers(file('docs/new.md'), new Map([[OP2, null]]))).toBe(0);
    expect(existsSync(temp)).toBe(true);
    rmSync(temp);
    linkSync(file('docs/new.md'), file('docs/alias.md'));
    expect(reclaimDocLeftovers(file('docs/new.md'), new Map([[OP, null]]))).toBe(0);
    expect(write('docs/new.md', {}, OP2, new Map([[OP, null]]))).toMatchObject({ result: 'not_written', reason: 'hardlink' });
  });

  it('an ending before the link: another inode holding exactly the block is taken back; one holding anything else is not', () => {
    writeFileSync(file('docs/d.md'), 'x\n');
    writeFileSync(file(`docs/${tempNameOf(OP)}`), docBlockOf(OP, BODY));
    writeFileSync(file(`docs/${tempNameOf(OP2)}`), 'not the block');
    expect(reclaimDocLeftovers(file('docs/d.md'), new Map([[OP, docBlockOf(OP, BODY)], [OP2, docBlockOf(OP2, BODY)]]))).toBe(1);
    expect(existsSync(file(`docs/${tempNameOf(OP)}`))).toBe(false);
    expect(existsSync(file(`docs/${tempNameOf(OP2)}`))).toBe(true);
  });
});

describe('T12: where a document may be', () => {
  it.each([
    ['../outside.md', 'outside_repository'],
    ['/etc/x.md', 'absolute_path'],
    ['.git/notes.md', 'sensitive_path'],
    ['docs/.env.md', 'invalid_destination'],
    ['docs/x.txt', 'invalid_destination'],
    ['missing/dir/x.md', 'invalid_destination'],
  ])('%s → refused (%s)', (rel, code) => {
    const checked = checkDocPath(root, rel);
    expect(checked.ok).toBe(false);
    if (!checked.ok && code !== 'invalid_destination') expect(checked.code).toBe(code);
  });

  it('a symlink in the middle, as the last component, or as the root → refused', () => {
    mkdirSync(path.join(dir, 'elsewhere'));
    symlinkSync(path.join(dir, 'elsewhere'), file('linked'));
    expect(checkDocPath(root, 'linked/x.md')).toEqual({ ok: false, code: 'symlink' });
    writeFileSync(path.join(dir, 'elsewhere', 'real.md'), 'r');
    symlinkSync(path.join(dir, 'elsewhere', 'real.md'), file('docs/last.md'));
    expect(checkDocPath(root, 'docs/last.md')).toEqual({ ok: false, code: 'symlink' });
    symlinkSync(root, path.join(dir, 'root-link'));
    expect(checkDocPath(path.join(dir, 'root-link'), 'docs/x.md')).toEqual({ ok: false, code: 'symlink' });
  });

  it('(positive control) a check by stat instead of lstat follows the link out of the repository', () => {
    mkdirSync(path.join(dir, 'elsewhere'));
    symlinkSync(path.join(dir, 'elsewhere'), file('linked'));
    expect(statSync(file('linked')).isDirectory()).toBe(true);
    expect(lstatSync(file('linked')).isSymbolicLink()).toBe(true);
  });

  it('(control) a plain document under an existing directory is accepted, existing or not', () => {
    expect(checkDocPath(root, 'docs/new.md')).toMatchObject({ ok: true, rel: 'docs/new.md', exists: false });
    writeFileSync(file('docs/old.md'), 'x');
    expect(checkDocPath(root, 'docs/old.md')).toMatchObject({ ok: true, exists: true });
  });
});

describe('T21: the block search', () => {
  const block = docBlockOf(OP, BODY);
  it('found with other content around it; altered when edited or doubled; missing when gone', () => {
    expect(findDocBlock(`head\n${block}tail\n`, OP, sha256(BODY))).toBe('found');
    expect(findDocBlock(`head\n${block.replace('決定', '改変')}`, OP, sha256(BODY))).toBe('altered');
    expect(findDocBlock(`${block}${block}`, OP, sha256(BODY))).toBe('altered');
    expect(findDocBlock(block.split('\n')[0], OP, sha256(BODY))).toBe('altered');
    expect(findDocBlock('head only\n', OP, sha256(BODY))).toBe('missing');
  });
});
