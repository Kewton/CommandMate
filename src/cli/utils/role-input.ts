/**
 * What a role command reads from this machine rather than the server (Issue #4116):
 * a role's body, and how a path looks here. It makes no request, so nothing here can
 * sit on a `--timeout`.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { MAX_ROLE_BODY_BYTES } from '../../types/agent-roles';
import { usageError } from './role-failure';

export function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/** Keeps every byte, a BOM included: the body reaches the model as written. */
function decodeRoleBody(bytes: Buffer, source: string): string {
  if (bytes.byteLength > MAX_ROLE_BODY_BYTES) {
    throw usageError(`The body from ${source} is ${bytes.byteLength} bytes; a role holds at most ${MAX_ROLE_BODY_BYTES}.`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw usageError(`The body from ${source} is not valid UTF-8.`);
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    // Kept as bytes until the end: a character can be split across two chunks.
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

/**
 * The body named by `--file` / `--stdin`, or undefined when neither was given.
 * A terminal on stdin is refused rather than waited on: this is never interactive.
 */
export async function readRoleBodyOption(options: { file?: string; stdin?: boolean }): Promise<string | undefined> {
  if (options.file !== undefined && options.stdin) throw usageError('Give the body with --file or --stdin, not both.');
  if (options.file !== undefined) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(options.file);
    } catch (error) {
      throw usageError(`Could not read ${options.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return decodeRoleBody(bytes, options.file);
  }
  if (!options.stdin) return undefined;
  if ((process.stdin as { isTTY?: boolean }).isTTY) {
    throw usageError('--stdin needs the body piped in; a terminal is not read. Use --file, or pipe it.');
  }
  return decodeRoleBody(await readAll(process.stdin), 'stdin');
}
