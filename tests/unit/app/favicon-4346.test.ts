/**
 * Issue #4346 (7): browsers ask for /favicon.ico by default; it used to be a 404.
 * Next.js serves src/app/favicon.ico as /favicon.ico, and the middleware matcher
 * already lets that path through without auth.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { config } from '../../../src/middleware';

const ROOT = path.resolve(__dirname, '../../..');

describe('favicon.ico (Issue #4346)', () => {
  const ico = (): Buffer => fs.readFileSync(path.join(ROOT, 'src/app/favicon.ico'));

  it('exists as a valid single-image ICO', () => {
    const buf = ico();
    expect(buf.readUInt16LE(0)).toBe(0); // reserved
    expect(buf.readUInt16LE(2)).toBe(1); // type: icon
    expect(buf.readUInt16LE(4)).toBe(1); // one image
  });

  it('embeds the existing src/app/icon.png unchanged (no new design)', () => {
    const buf = ico();
    const size = buf.readUInt32LE(14);
    const offset = buf.readUInt32LE(18);
    const embedded = buf.subarray(offset, offset + size);
    const icon = fs.readFileSync(path.join(ROOT, 'src/app/icon.png'));
    expect(embedded.equals(icon)).toBe(true);
  });

  it('is excluded from the auth middleware matcher (negative control: pages are not)', () => {
    const pattern = new RegExp(`^${config.matcher[0]}$`);
    expect(pattern.test('/favicon.ico')).toBe(false);
    expect(pattern.test('/sessions')).toBe(true);
  });
});
