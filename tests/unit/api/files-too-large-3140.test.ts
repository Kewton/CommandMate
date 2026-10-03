/**
 * Oversize image/video → 413 FILE_TOO_LARGE on both the base64 and ?raw=1 paths (Issue #3140).
 * Real sparse files in a temp directory; only the DB is replaced.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { GET } from '@/app/api/worktrees/[id]/files/[...path]/route';
import { getWorktreeById } from '@/lib/db';
import { IMAGE_MAX_SIZE_BYTES } from '@/config/image-extensions';
import { VIDEO_MAX_SIZE_BYTES } from '@/config/video-extensions';

let base: string;
let root: string;

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sparse(file: string, head: Buffer, size: number): void {
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, head, 0, head.length, 0);
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
}

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-large-3140-')));
  root = path.join(base, 'wt');
  fs.mkdirSync(path.join(root, 'media'), { recursive: true });
  sparse(path.join(root, 'media', 'big.png'), PNG_HEAD, IMAGE_MAX_SIZE_BYTES + 1);
  const mp4 = Buffer.alloc(16);
  mp4.write('ftyp', 4, 'ascii');
  sparse(path.join(root, 'media', 'big.mp4'), mp4, VIDEO_MAX_SIZE_BYTES + 1);
  fs.writeFileSync(path.join(root, 'media', 'fake.png'), Buffer.alloc(40, 3));
  fs.writeFileSync(path.join(root, 'media', 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'wt', path: root });
});

function get(name: string, query: string) {
  const segments = ['media', name];
  const url = `http://localhost:3000/api/worktrees/wt/files/${segments.join('/')}${query}`;
  return GET(new NextRequest(new URL(url)), { params: Promise.resolve({ id: 'wt', path: segments }) });
}

describe.each([
  ['base64', ''],
  ['raw', '?raw=1'],
])('%s path', (_label, query) => {
  it('oversize image → 413 FILE_TOO_LARGE', async () => {
    const res = await get('big.png', query);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('FILE_TOO_LARGE');
  });

  it('oversize video → 413 FILE_TOO_LARGE', async () => {
    const res = await get('big.mp4', query);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('FILE_TOO_LARGE');
  });

  it('magic bytes mismatch stays INVALID_MAGIC_BYTES', async () => {
    const res = await get('fake.png', query);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_MAGIC_BYTES');
  });
});

describe('SVG safety check (negative control)', () => {
  it('base64 path keeps INVALID_FILE_CONTENT', async () => {
    const res = await get('evil.svg', '');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_FILE_CONTENT');
  });
});
