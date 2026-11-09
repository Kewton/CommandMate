/**
 * Appending a decision's block to a document of a worktree (Issue #4225, design §3.3・§3.4).
 *
 * E never replaces, truncates or rewrites a document: another process's edit made
 * between E's last read and its write is kept (design ①).
 *
 * - An existing file: opened `O_WRONLY|O_APPEND|O_NOFOLLOW`, the descriptor checked
 *   (a regular file, one link, the inode `lstat` saw), the block written once.
 * - A new file: the whole block goes to a temporary name first and appears under the
 *   destination by `link`, which fails with `EEXIST` rather than overwrite anything
 *   (re-review R1). No empty file is ever visible.
 * - E's own temporary names left by an ending between `link` and `unlink` are taken
 *   back by one rule (re-review R4): only a name of an operation of E for this same
 *   destination; the same inode as the destination is taken back whatever it holds
 *   (the content stays under the destination), another inode only when it holds
 *   exactly that operation's block. Nothing else is touched, so an unrelated hard link
 *   is still refused by the one-link check.
 *
 * Synchronous: it runs inside the approval's synchronous stretch. git is never called.
 *
 * @module lib/promote/doc-write
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'fs';
import path from 'path';
import { checkDocPath, docBaseFingerprint } from './destination';
import { sha256 } from './render';

const BLOCK = 'commandmate-promote';

export const tempNameOf = (operationId: string): string => `.${BLOCK}-${operationId}.tmp`;
const TEMP_NAME = /^\.commandmate-promote-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/;

const beginLine = (operationId: string, bodySha: string) => `<!-- ${BLOCK}:begin op=${operationId} sha256=${bodySha} -->`;
const endLine = (operationId: string) => `<!-- ${BLOCK}:end op=${operationId} -->`;

/** The block of an operation, as a new file holds it (an append may put one LF before it). */
export function docBlockOf(operationId: string, body: string): string {
  return `${beginLine(operationId, sha256(body))}\n${body}\n${endLine(operationId)}\n`;
}

const occurrences = (content: string, needle: string): number => content.split(needle).length - 1;

export type BlockSearch = 'found' | 'missing' | 'altered';

/** The operation's block in a content (design §3.4): exactly one, with the body's SHA-256. */
export function findDocBlock(content: string, operationId: string, bodySha: string): BlockSearch {
  const beginMark = `<!-- ${BLOCK}:begin op=${operationId} `;
  const endMark = endLine(operationId);
  const begins = occurrences(content, beginMark);
  const ends = occurrences(content, endMark);
  if (begins === 0 && ends === 0) return 'missing';
  if (begins !== 1 || ends !== 1) return 'altered';
  const start = content.indexOf(beginMark);
  if (start > 0 && content[start - 1] !== '\n') return 'altered';
  const lineEnd = content.indexOf('\n', start);
  if (lineEnd < 0 || content.slice(start, lineEnd) !== beginLine(operationId, bodySha)) return 'altered';
  const endAt = content.indexOf(endMark);
  if (endAt <= lineEnd || content[endAt - 1] !== '\n') return 'altered';
  const inner = content.slice(lineEnd + 1, endAt - 1);
  return sha256(inner) === bodySha ? 'found' : 'altered';
}

/**
 * Take back E's temporary names left beside `abs` (R4). `candidates`: the operations
 * of E for this destination, each with its block (null when unknown).
 */
export function reclaimDocLeftovers(abs: string, candidates: ReadonlyMap<string, string | null>): number {
  if (candidates.size === 0) return 0;
  const dir = path.dirname(abs);
  let destination: ReturnType<typeof lstatSync> | null = null;
  try {
    destination = lstatSync(abs);
  } catch {
    destination = null;
  }
  let taken = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const id = TEMP_NAME.exec(name)?.[1];
    if (!id || !candidates.has(id)) continue;
    const temp = path.join(dir, name);
    let stat;
    try {
      stat = lstatSync(temp);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const sameInode = destination !== null && destination.isFile() && destination.dev === stat.dev && destination.ino === stat.ino;
    const block = candidates.get(id) ?? null;
    let exactBlock = false;
    if (!sameInode && stat.nlink === 1 && block !== null) {
      try {
        exactBlock = readFileSync(temp, 'utf8') === block;
      } catch {
        exactBlock = false;
      }
    }
    if (sameInode || exactBlock) {
      unlinkSync(temp);
      taken += 1;
    }
  }
  return taken;
}

export interface DocWriteHooks {
  /** An existing file: after the last read, before the append. Test seam (another process writes here). */
  beforeAppend?: (abs: string) => void;
  /** A new file: after the temporary file is written, before `link`. */
  beforeLink?: (abs: string) => void;
  /** A new file: after `link`, before the temporary name goes. Throwing here is the process ending. */
  afterLink?: (abs: string) => void;
}

export type DocWriteOutcome =
  | { result: 'not_written'; reason: string; refusal: boolean }
  | { result: 'success'; concurrentEdit: boolean; resultRef: string }
  | { result: 'unknown'; reason: 'block_missing' | 'block_altered' | 'unreadable' };

export interface DocWriteInput {
  root: string;
  rel: string;
  operationId: string;
  body: string;
  baseFingerprint: string;
  /** E's operations for this destination (the reclaim rule), with their blocks. */
  leftovers: ReadonlyMap<string, string | null>;
}

function readBack(abs: string, expected: string, operationId: string, bodySha: string, rel: string): DocWriteOutcome {
  let after: string;
  try {
    after = readFileSync(abs, 'utf8');
  } catch {
    return { result: 'unknown', reason: 'unreadable' };
  }
  const resultRef = JSON.stringify({ path: rel, sha256: bodySha });
  if (after === expected) return { result: 'success', concurrentEdit: false, resultRef };
  const found = findDocBlock(after, operationId, bodySha);
  if (found === 'found') return { result: 'success', concurrentEdit: true, resultRef };
  return { result: 'unknown', reason: found === 'missing' ? 'block_missing' : 'block_altered' };
}

/** Write the block (design §3.3 steps 1〜5). Throws only past the point where something may have been written. */
export function writeDocBlock(input: DocWriteInput, hooks: DocWriteHooks = {}): DocWriteOutcome {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (!noFollow) return { result: 'not_written', reason: 'unsupported', refusal: false };
  const checked = checkDocPath(input.root, input.rel);
  if (!checked.ok) return { result: 'not_written', reason: checked.code, refusal: true };
  const { abs, rel } = checked;
  reclaimDocLeftovers(abs, input.leftovers);
  if (docBaseFingerprint(abs) !== input.baseFingerprint) return { result: 'not_written', reason: 'base_changed', refusal: true };
  const bodySha = sha256(input.body);
  const block = docBlockOf(input.operationId, input.body);

  if (input.baseFingerprint !== 'absent') {
    const content = readFileSync(abs, 'utf8');
    const data = (content.length > 0 && !content.endsWith('\n') ? '\n' : '') + block;
    const seen = lstatSync(abs);
    let fd: number;
    try {
      fd = openSync(abs, fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollow);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { result: 'not_written', reason: code === 'ELOOP' ? 'symlink' : 'base_changed', refusal: true };
    }
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== seen.dev || opened.ino !== seen.ino) {
        return { result: 'not_written', reason: 'hardlink', refusal: true };
      }
      hooks.beforeAppend?.(abs);
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return readBack(abs, content + data, input.operationId, bodySha, rel);
  }

  const temp = path.join(path.dirname(abs), tempNameOf(input.operationId));
  let fd: number;
  try {
    fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o644);
  } catch {
    return { result: 'not_written', reason: 'base_changed', refusal: true };
  }
  try {
    writeSync(fd, block);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  hooks.beforeLink?.(abs);
  try {
    linkSync(temp, abs);
  } catch (error) {
    unlinkSync(temp);
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EEXIST'
      ? { result: 'not_written', reason: 'base_changed', refusal: true }
      : { result: 'not_written', reason: 'unsupported', refusal: false };
  }
  hooks.afterLink?.(abs);
  unlinkSync(temp);
  return readBack(abs, block, input.operationId, bodySha, rel);
}

/** What the reconcile of a document finds (design §3.4), after taking back E's leftovers. */
export function reconcileDocBlock(
  root: string,
  rel: string,
  operationId: string,
  bodySha: string,
  leftovers: ReadonlyMap<string, string | null>
): 'found' | 'missing' | 'altered' | 'unreadable' {
  const checked = checkDocPath(root, rel);
  if (!checked.ok) return 'unreadable';
  reclaimDocLeftovers(checked.abs, leftovers);
  let content: string;
  try {
    content = readFileSync(checked.abs, 'utf8');
  } catch {
    return 'unreadable';
  }
  return findDocBlock(content, operationId, bodySha);
}

/** The most of a found block the screen is shown (design §3.4, PM review P3-2). */
export const DOC_EXCERPT_MAX_CHARS = 64 * 1024;

/**
 * What the document holds around the operation's marks, for a person to compare with
 * what was meant to be written (design §3.4: `block_altered` shows both). From the line
 * of the first mark of the operation to the end of the line of its last mark (to the end
 * of the content when no end mark follows), at most {@link DOC_EXCERPT_MAX_CHARS}. Null
 * when the document cannot be read or holds no mark of the operation. Reads only.
 */
export function readDocBlockExcerpt(root: string, rel: string, operationId: string): string | null {
  const checked = checkDocPath(root, rel);
  if (!checked.ok) return null;
  let content: string;
  try {
    content = readFileSync(checked.abs, 'utf8');
  } catch {
    return null;
  }
  const marks = [`<!-- ${BLOCK}:begin op=${operationId} `, endLine(operationId)];
  const firsts = marks.map((mark) => content.indexOf(mark)).filter((at) => at >= 0);
  if (firsts.length === 0) return null;
  const first = Math.min(...firsts);
  const start = content.lastIndexOf('\n', first - 1) + 1;
  const lastEnd = content.lastIndexOf(endLine(operationId));
  let end = content.length;
  if (lastEnd >= first) {
    const lineEnd = content.indexOf('\n', lastEnd);
    if (lineEnd >= 0) end = lineEnd + 1;
  }
  return content.slice(start, end).slice(0, DOC_EXCERPT_MAX_CHARS);
}
