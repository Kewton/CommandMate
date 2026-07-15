/**
 * Issue #1200 — GitHub Pages landing page.
 *
 * The LP is plain HTML/CSS/JS with no build step, so these tests are the only
 * automated gate on it. They encode the Issue's machine-verifiable acceptance
 * criteria: the page must resolve every asset it references relative to
 * `website/`, must ship nothing that needs compiling, and must respect the
 * media budget that keeps the hero's LCP defensible.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const WEBSITE_DIR = path.join(REPO_ROOT, 'website');
const INDEX_HTML = path.join(WEBSITE_DIR, 'index.html');

const VIDEO_BUDGET_BYTES = 1_500_000;
const POSTER_BUDGET_BYTES = 100_000;

/** Every file under website/, recursively, as paths relative to website/. */
function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

function readIndexHtml(): string {
  return fs.readFileSync(INDEX_HTML, 'utf-8');
}

/**
 * Pull every asset/link reference out of the markup. Deliberately regex-based:
 * adding an HTML parser would mean a new npm dependency, which the Issue forbids.
 */
function extractRefs(html: string): string[] {
  const refs: string[] = [];
  const pattern = /(?:src|href)\s*=\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

const isExternal = (ref: string) =>
  /^(https?:)?\/\//.test(ref) || ref.startsWith('mailto:') || ref.startsWith('#');

describe('Issue #1200: landing page structure', () => {
  it('has an index.html at the website root', () => {
    expect(fs.existsSync(INDEX_HTML)).toBe(true);
  });

  it('ships no TypeScript, which has no build step here to compile it', () => {
    // Not a type-check concern since #1265 anchored the root tsconfig include
    // (tests/unit/config/tsconfig-scope.test.ts guards that). The reason now is
    // Pages-specific: it serves website/ verbatim, so a .ts would never run.
    const typescriptFiles = walk(WEBSITE_DIR).filter((f) => /\.tsx?$/.test(f));
    expect(typescriptFiles).toEqual([]);
  });
});

describe('Issue #1200: asset references resolve under sub-path hosting', () => {
  it('resolves every local src/href to a real file on disk', () => {
    const html = readIndexHtml();
    const broken = extractRefs(html)
      .filter((ref) => !isExternal(ref))
      .filter((ref) => !fs.existsSync(path.join(WEBSITE_DIR, ref.split(/[?#]/)[0])));

    expect(broken).toEqual([]);
  });

  it('uses no root-absolute local paths', () => {
    // The site is served from https://kewton.github.io/CommandMate/, so a
    // reference like /assets/x.webp resolves to the org root and 404s.
    const html = readIndexHtml();
    const rootAbsolute = extractRefs(html).filter(
      (ref) => ref.startsWith('/') && !ref.startsWith('//'),
    );

    expect(rootAbsolute).toEqual([]);
  });

  it('does not reference the oversized originals in docs/images/', () => {
    const html = readIndexHtml();
    expect(html).not.toMatch(/docs\/images/);
  });

  it('references nothing outside website/, which Pages does not deploy', () => {
    const html = readIndexHtml();
    const escaping = extractRefs(html)
      .filter((ref) => !isExternal(ref))
      .filter((ref) => {
        const resolved = path.resolve(WEBSITE_DIR, ref.split(/[?#]/)[0]);
        return !resolved.startsWith(WEBSITE_DIR + path.sep);
      });

    expect(escaping).toEqual([]);
  });

  it('points og:image at an absolute URL, the one place a relative path fails', () => {
    const html = readIndexHtml();
    const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);

    expect(ogImage).not.toBeNull();
    expect(ogImage![1]).toMatch(/^https:\/\/kewton\.github\.io\/CommandMate\//);
  });
});

describe('Issue #1200: media budget', () => {
  it('keeps each video under 1.5MB', () => {
    const oversized = walk(WEBSITE_DIR)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => ({ file: f, bytes: fs.statSync(path.join(WEBSITE_DIR, f)).size }))
      .filter((v) => v.bytes >= VIDEO_BUDGET_BYTES);

    expect(oversized).toEqual([]);
  });

  it('keeps each poster under 100KB, since the poster is the LCP element', () => {
    const oversized = walk(WEBSITE_DIR)
      .filter((f) => f.includes('poster'))
      .map((f) => ({ file: f, bytes: fs.statSync(path.join(WEBSITE_DIR, f)).size }))
      .filter((p) => p.bytes >= POSTER_BUDGET_BYTES);

    expect(oversized).toEqual([]);
  });

  it('never copies the 22MB/47MB originals into website/', () => {
    const huge = walk(WEBSITE_DIR)
      .map((f) => ({ file: f, bytes: fs.statSync(path.join(WEBSITE_DIR, f)).size }))
      .filter((f) => f.bytes > 5_000_000);

    expect(huge).toEqual([]);
  });
});

describe('Issue #1200: video element behaviour', () => {
  it('gives every video a poster so there is an LCP frame before playback', () => {
    const html = readIndexHtml();
    const videos = html.match(/<video[^>]*>/g) ?? [];

    expect(videos.length).toBeGreaterThan(0);
    for (const video of videos) {
      expect(video).toMatch(/poster="/);
    }
  });

  it('does not preload="auto", which would pull megabytes before interaction', () => {
    const html = readIndexHtml();
    const videos = html.match(/<video[^>]*>/g) ?? [];

    for (const video of videos) {
      expect(video).toMatch(/preload="(metadata|none)"/);
      expect(video).not.toMatch(/preload="auto"/);
    }
  });

  it('omits the autoplay attribute so reduced-motion can be honoured before playback', () => {
    // Playback is started from main.js only when prefers-reduced-motion allows.
    // A literal autoplay attribute would play frames before that check runs.
    const html = readIndexHtml();
    const videos = html.match(/<video[^>]*>/g) ?? [];

    for (const video of videos) {
      // Must not match the native attribute, but `data-autoplay` (the hook
      // main.js selects on) is a different attribute and is expected here.
      expect(video).not.toMatch(/(?<![-\w])autoplay\b/);
      expect(video).toMatch(/data-autoplay\b/);
    }
  });

  it('honours prefers-reduced-motion in the playback script', () => {
    const mainJs = fs.readFileSync(path.join(WEBSITE_DIR, 'main.js'), 'utf-8');
    expect(mainJs).toMatch(/prefers-reduced-motion/);
  });

  it('gates playback on visibility, since play() forces a full download', () => {
    // Without this, preload="none" on the below-the-fold phone demo is a lie:
    // an unconditional play() on load pulls the whole file anyway.
    const mainJs = fs.readFileSync(path.join(WEBSITE_DIR, 'main.js'), 'utf-8');
    expect(mainJs).toMatch(/IntersectionObserver/);
  });

  it('declares an icon so the browser stops probing /favicon.ico at the root', () => {
    const html = readIndexHtml();
    expect(html).toMatch(/<link\s+rel="icon"\s+href="[^/][^"]*"/);
  });

  it('falls back to a still image where video is unsupported', () => {
    const html = readIndexHtml();
    const videoBlocks = html.match(/<video[\s\S]*?<\/video>/g) ?? [];

    expect(videoBlocks.length).toBeGreaterThan(0);
    for (const block of videoBlocks) {
      expect(block).toMatch(/<img\b/);
    }
  });
});

describe('Issue #1200: metadata and honest copy', () => {
  it('declares the OGP tags needed for a decent social preview', () => {
    const html = readIndexHtml();
    for (const property of ['og:title', 'og:description', 'og:image']) {
      expect(html).toMatch(new RegExp(`<meta\\s+property="${property}"`));
    }
  });

  it('declares the page language as English', () => {
    const html = readIndexHtml();
    expect(html).toMatch(/<html[^>]*\blang="en"/);
  });

  it('supports both colour schemes', () => {
    const css = fs.readFileSync(path.join(WEBSITE_DIR, 'styles.css'), 'utf-8');
    expect(css).toMatch(/prefers-color-scheme:\s*dark/);
  });

  it('states Beta status rather than overselling maturity', () => {
    // README.md:8 says "Status: Beta"; the LP must not imply more than that.
    const html = readIndexHtml();
    expect(html).toMatch(/Beta/);
  });
});
