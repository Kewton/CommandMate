/**
 * Hand-rolled tar/gzip writer for the malicious package corpus (Issue #1230)
 *
 * `tar(1)` refuses to produce most of what this corpus needs — a device node
 * owned by nobody, a duplicate entry, a broken checksum, a name with a `..`
 * component — and checking binary blobs into the repository would hide what
 * each case actually contains. Everything is therefore built in code, so a
 * reviewer can read the attack instead of unpacking it.
 */

import { gzipSync } from 'zlib';

export const TAR_BLOCK_SIZE = 512;

/** tar typeflags, including the ones a Skill package may never contain. */
export const TarType = {
  REGULAR: '0',
  HARDLINK: '1',
  SYMLINK: '2',
  CHAR_DEVICE: '3',
  BLOCK_DEVICE: '4',
  DIRECTORY: '5',
  FIFO: '6',
  CONTIGUOUS: '7',
  PAX_EXTENDED: 'x',
  PAX_GLOBAL: 'g',
  GNU_LONGNAME: 'L',
} as const;

export type TarTypeValue = (typeof TarType)[keyof typeof TarType];

export interface TarEntryInput {
  name: string;
  type?: TarTypeValue | '\0';
  /** Permission bits written to the header. Defaults to 0o644 / 0o755. */
  mode?: number;
  content?: Uint8Array | string;
  linkname?: string;
  /** Written to the 155-byte prefix field, joined to `name` with a slash. */
  prefix?: string;
  /** Override the `ustar` magic, for format-rejection cases. */
  magic?: string;
  /** Override the declared size without changing the payload. */
  declaredSize?: number;
  /** Corrupt the header checksum. */
  breakChecksum?: boolean;
  /** Write the size field in GNU base-256 encoding. */
  base256Size?: boolean;
}

function toBytes(content: Uint8Array | string | undefined): Uint8Array {
  if (content === undefined) return new Uint8Array(0);
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
}

function writeText(block: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength > length) throw new Error(`tar field overflow at offset ${offset}`);
  bytes.copy(block, offset);
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  writeText(block, offset, length, value.toString(8).padStart(length - 1, '0'));
}

function buildHeader(entry: TarEntryInput, size: number): Buffer {
  const block = Buffer.alloc(TAR_BLOCK_SIZE);
  const type = entry.type ?? TarType.REGULAR;
  const isDirectory = type === TarType.DIRECTORY;

  writeText(block, 0, 100, entry.name);
  writeOctal(block, 100, 8, entry.mode ?? (isDirectory ? 0o755 : 0o644));
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  if (entry.base256Size) {
    block[124] = 0x80;
    block.writeUInt32BE(size, 132);
  } else {
    writeOctal(block, 124, 12, entry.declaredSize ?? size);
  }
  writeOctal(block, 136, 12, 0);
  writeText(block, 156, 1, type);
  if (entry.linkname) writeText(block, 157, 100, entry.linkname);
  writeText(block, 257, 6, entry.magic ?? 'ustar');
  writeText(block, 263, 2, '00');
  if (entry.prefix) writeText(block, 345, 155, entry.prefix);

  block.fill(0x20, 148, 156);
  let checksum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) checksum += block[i];
  writeOctal(block, 148, 7, entry.breakChecksum ? checksum + 1 : checksum);
  block[155] = 0x20;
  return block;
}

export interface BuildTarOptions {
  /** Leave off the two zero blocks that mark the end of the archive. */
  omitTrailer?: boolean;
  /** Append bytes after the trailer. */
  trailingGarbage?: Uint8Array;
}

/** Assemble raw tar bytes. */
export function buildTar(entries: readonly TarEntryInput[], options: BuildTarOptions = {}): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = toBytes(entry.content);
    blocks.push(buildHeader(entry, content.byteLength));
    if (content.byteLength > 0) {
      const padded = Buffer.alloc(Math.ceil(content.byteLength / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE);
      Buffer.from(content).copy(padded);
      blocks.push(padded);
    }
  }
  if (!options.omitTrailer) blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  if (options.trailingGarbage) blocks.push(Buffer.from(options.trailingGarbage));
  return Buffer.concat(blocks);
}

/** Assemble a gzipped tar, the only artifact format schema_version 1 accepts. */
export function buildTarGz(
  entries: readonly TarEntryInput[],
  options: BuildTarOptions = {}
): Buffer {
  return gzipSync(buildTar(entries, options), { level: 9 });
}
