/**
 * GET /api/worktrees/:id/files/:path?raw=1 (Issue #3121)
 *
 * The bytes as-is, streamed, with Range support — for `<video>` / `<img>` to
 * point at instead of a base64 data URI in JSON. Real files in a temp
 * directory and the real path validator: only the DB is replaced.
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
import { VIDEO_MAX_SIZE_BYTES } from '@/config/video-extensions';

let base: string;
let root: string;

/** 1000 bytes that satisfy the MP4 magic bytes ('ftyp' at offset 4). */
function mp4Bytes(length = 1000): Buffer {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buf[i] = i % 251;
  buf.write('ftyp', 4, 'ascii');
  return buf;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-raw-3121-')));
  root = path.join(base, 'wt');
  fs.mkdirSync(path.join(root, 'media'), { recursive: true });
  fs.writeFileSync(path.join(root, 'media', 'clip.mp4'), mp4Bytes());
  fs.writeFileSync(path.join(root, 'media', 'fake.mp4'), Buffer.alloc(100, 7));
  fs.writeFileSync(path.join(root, 'media', 'shot.png'), PNG);
  fs.writeFileSync(path.join(root, 'media', 'fake.png'), Buffer.alloc(40, 3));
  fs.writeFileSync(path.join(root, 'media', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  fs.writeFileSync(path.join(root, 'notes.md'), '# hi');
  fs.writeFileSync(path.join(base, 'outside.mp4'), mp4Bytes());
  // Sparse: no 100MB of disk, but stat reports the size.
  const big = fs.openSync(path.join(root, 'media', 'big.mp4'), 'w');
  fs.writeSync(big, mp4Bytes(16), 0, 16, 0);
  fs.ftruncateSync(big, VIDEO_MAX_SIZE_BYTES + 1);
  fs.closeSync(big);
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'wt', path: root });
});

function get(segments: string[], headers: Record<string, string> = {}, query = '?raw=1') {
  const url = `http://localhost:3000/api/worktrees/wt/files/${segments.join('/')}${query}`;
  return GET(new NextRequest(new URL(url), { headers }), {
    params: Promise.resolve({ id: 'wt', path: segments }),
  });
}

async function bodyBytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

describe('?raw=1 video', () => {
  it('streams the whole file with 200 and the safety headers', async () => {
    const response = await get(['media', 'clip.mp4']);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('cache-control')).toBe('private');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe('1000');
    expect((await bodyBytes(response)).equals(mp4Bytes())).toBe(true);
  });

  it('answers Range: bytes=0-99 with 206 and exactly those 100 bytes', async () => {
    const response = await get(['media', 'clip.mp4'], { Range: 'bytes=0-99' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-99/1000');
    expect(response.headers.get('content-length')).toBe('100');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    const body = await bodyBytes(response);
    expect(body.length).toBe(100);
    expect(body.equals(mp4Bytes().subarray(0, 100))).toBe(true);
  });

  it('answers an open-ended and a suffix range', async () => {
    const open = await get(['media', 'clip.mp4'], { Range: 'bytes=900-' });
    expect(open.status).toBe(206);
    expect(open.headers.get('content-range')).toBe('bytes 900-999/1000');
    expect((await bodyBytes(open)).equals(mp4Bytes().subarray(900))).toBe(true);

    const suffix = await get(['media', 'clip.mp4'], { Range: 'bytes=-10' });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect((await bodyBytes(suffix)).length).toBe(10);
  });

  it('answers a range past the end with 416', async () => {
    const response = await get(['media', 'clip.mp4'], { Range: 'bytes=5000-6000' });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */1000');
  });

  it('refuses a file whose magic bytes are not MP4, as the JSON branch does', async () => {
    const response = await get(['media', 'fake.mp4']);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_MAGIC_BYTES');
  });

  it('refuses a file over the size ceiling, as the JSON branch does', async () => {
    const raw = await get(['media', 'big.mp4']);
    expect(raw.status).toBe(413);
    expect((await raw.json()).error.code).toBe('FILE_TOO_LARGE');
  });
});

describe('?raw=1 images', () => {
  it('streams a PNG with its own Content-Type', async () => {
    const response = await get(['media', 'shot.png']);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await bodyBytes(response)).equals(PNG)).toBe(true);
  });

  it('refuses a PNG with the wrong magic bytes', async () => {
    const response = await get(['media', 'fake.png']);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_MAGIC_BYTES');
  });

  it('refuses SVG with 400', async () => {
    const response = await get(['media', 'icon.svg']);
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

describe('?raw=1 refusals shared with the other branches', () => {
  it('refuses an extension that is neither video nor image with 400', async () => {
    const response = await get(['notes.md']);
    expect(response.status).toBe(400);
  });

  it('refuses a path outside the worktree the same way as without raw=1', async () => {
    const raw = await get(['..', 'outside.mp4']);
    const plain = await get(['..', 'outside.mp4'], {}, '');
    expect(raw.status).toBe(400);
    expect(plain.status).toBe(raw.status);
    expect((await raw.json()).error.code).toBe((await plain.json()).error.code);
  });

  it('answers a missing file with 404', async () => {
    const response = await get(['media', 'missing.mp4']);
    expect(response.status).toBe(404);
  });
});

describe('without raw=1', () => {
  it('still returns the base64 JSON for a video', async () => {
    const response = await get(['media', 'clip.mp4'], {}, '');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.isVideo).toBe(true);
    expect(data.content).toBe(`data:video/mp4;base64,${mp4Bytes().toString('base64')}`);
  });
});
