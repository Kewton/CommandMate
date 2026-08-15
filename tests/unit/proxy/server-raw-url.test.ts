/**
 * server.ts raw request target capture (Issue #1804)
 *
 * WHY THIS TEST IS SHAPED THIS WAY
 *
 * The fix has two halves. The route handler half is covered by
 * tests/unit/proxy/route.test.ts, which can simply build a `Request`. The
 * server half lives in `server.ts`'s `requestHandler`, and `server.ts` cannot
 * be imported from a test: importing it boots Next, opens a port, runs DB
 * migrations and registers signal handlers.
 *
 * It also must not be refactored into an importable helper. Adding a module
 * graph to `server.ts`'s eval-time graph perturbs Next's AsyncLocalStorage
 * bootstrap under `tsx server.ts`, and the first request that compiles
 * middleware dies (#1428) - a failure mode that is invisible to unit,
 * integration, build and lint, and only shows up in E2E or in production.
 *
 * So this test reads the shipped `server.ts` bytes, cuts out exactly the
 * Issue #1804 block, and EXECUTES it against fake `req` objects. That keeps the
 * assertions behavioral rather than a source-text pattern match: deleting the
 * header stash, or deleting the unconditional `delete` that makes it
 * unforgeable, both turn assertions here red (verified by mutation injection).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/** Statement that immediately precedes the Issue #1804 block in server.ts */
const BLOCK_START_ANCHOR = "const url = req.url ?? '/';";
/** Comment that immediately follows the Issue #1804 block in server.ts */
const BLOCK_END_ANCHOR = '// Issue #1621/#1645: a URL naming a worktree';

const SERVER_TS_PATH = path.resolve(process.cwd(), 'server.ts');

/**
 * Extract the Issue #1804 block from server.ts.
 *
 * If either anchor moves, this throws rather than silently extracting nothing -
 * an empty block would make every assertion below vacuously fail, but with a
 * confusing message.
 */
function extractRawUrlBlock(): string {
  const source = readFileSync(SERVER_TS_PATH, 'utf8');

  const startIndex = source.indexOf(BLOCK_START_ANCHOR);
  if (startIndex === -1) {
    throw new Error(
      `server.ts no longer contains the anchor ${BLOCK_START_ANCHOR}; ` +
        'update tests/unit/proxy/server-raw-url.test.ts to match.'
    );
  }

  const endIndex = source.indexOf(BLOCK_END_ANCHOR, startIndex);
  if (endIndex === -1) {
    throw new Error(
      `server.ts no longer contains the anchor ${BLOCK_END_ANCHOR}; ` +
        'update tests/unit/proxy/server-raw-url.test.ts to match.'
    );
  }

  return source.slice(startIndex + BLOCK_START_ANCHOR.length, endIndex);
}

/** Shape of the fake `req` the extracted block runs against */
type FakeReq = { headers: Record<string, string | string[] | undefined> };

/** The extracted block, compiled into a callable */
type RawUrlBlock = (req: FakeReq, url: string) => void;

/**
 * Compile the extracted block into a callable `(req, url) => void`.
 *
 * The block is plain JavaScript (no type annotations, no imports) precisely
 * because #1428 forbids server.ts from importing anything here.
 */
function compileRawUrlBlock(): RawUrlBlock {
  return new Function('req', 'url', extractRawUrlBlock()) as RawUrlBlock;
}

/**
 * Build a fake Node IncomingMessage-ish object. Node lower-cases every incoming
 * header name, so a client sending `X-CM-Raw-URL` lands on `x-cm-raw-url` here;
 * the fixtures below use the lower-cased form for that reason.
 */
function createReq(
  headers: Record<string, string | string[] | undefined> = {}
): FakeReq {
  return { headers };
}

describe('server.ts raw request target capture (Issue #1804)', () => {
  const run = compileRawUrlBlock();

  describe('capture', () => {
    it('should stash the raw request target for /proxy/ requests', () => {
      const req = createReq();
      run(req, '/proxy/testapp/search?q=a%20b&n=1');

      expect(req.headers['x-cm-raw-url']).toBe(
        '/proxy/testapp/search?q=a%20b&n=1'
      );
    });

    it.each([
      '/proxy/testapp/search?q=a%20b&n=1',
      '/proxy/testapp/search?bare',
      '/proxy/testapp/search/?',
      '/proxy/testapp/search?q=a%2Bb',
      '/proxy/testapp/search?q=a%26b',
      '/proxy/testapp/search?sig=aGVsbG8%3D',
      '/proxy/testapp/search?q=%E6%97%A5%E6%9C%AC',
      '/proxy/testapp/search?q=a+b',
      '/proxy/testapp/a%2Fb/%E6%97%A5%E6%9C%AC/',
      '/proxy/testapp/try/',
      '/proxy/testapp/try',
      '/proxy/testapp',
    ])('should stash %s byte-for-byte with no rewriting', (rawUrl) => {
      const req = createReq();
      run(req, rawUrl);

      expect(req.headers['x-cm-raw-url']).toBe(rawUrl);
    });
  });

  describe('forgery protection', () => {
    it('should overwrite a client-supplied x-cm-raw-url on a /proxy/ request', () => {
      const req = createReq({ 'x-cm-raw-url': '/proxy/testapp/EVIL/' });
      run(req, '/proxy/testapp/real/?q=1');

      expect(req.headers['x-cm-raw-url']).toBe('/proxy/testapp/real/?q=1');
    });

    it('should delete a client-supplied x-cm-raw-url on a non-proxy request', () => {
      const req = createReq({ 'x-cm-raw-url': '/proxy/testapp/EVIL/' });
      run(req, '/dashboard');

      expect(req.headers['x-cm-raw-url']).toBeUndefined();
    });

    it.each([
      '/',
      '/api/worktrees',
      '/login',
      // Prefix look-alikes: the guard tests for '/proxy/', not '/proxy'.
      '/proxyfoo/bar',
      '/proxy',
      '/notproxy/testapp/',
      '/worktrees/abc',
    ])(
      'should leave no x-cm-raw-url behind for %s even when the client sends one',
      (url) => {
        const req = createReq({ 'x-cm-raw-url': '/proxy/testapp/EVIL/' });
        run(req, url);

        expect(req.headers['x-cm-raw-url']).toBeUndefined();
      }
    );

    it('should delete an array-valued forged header (duplicate header lines)', () => {
      const req = createReq({
        'x-cm-raw-url': ['/proxy/a/EVIL/', '/proxy/b/EVIL/'],
      });
      run(req, '/dashboard');

      expect(req.headers['x-cm-raw-url']).toBeUndefined();
    });

    it('should not leave the forged value reachable on a /proxy/ request', () => {
      const req = createReq({
        'x-cm-raw-url': ['/proxy/a/EVIL/', '/proxy/b/EVIL/'],
      });
      run(req, '/proxy/testapp/real');

      expect(req.headers['x-cm-raw-url']).toBe('/proxy/testapp/real');
      expect(Array.isArray(req.headers['x-cm-raw-url'])).toBe(false);
    });
  });

  describe('non-interference', () => {
    it('should not touch other headers', () => {
      const req = createReq({
        'x-real-ip': '127.0.0.1',
        cookie: 'cm_auth_token=abc',
      });
      run(req, '/proxy/testapp/');

      expect(req.headers['x-real-ip']).toBe('127.0.0.1');
      expect(req.headers['cookie']).toBe('cm_auth_token=abc');
    });
  });

  describe('source-level constraints', () => {
    /**
     * #1428: a top-level static import of an internal module in server.ts kills
     * the first request that compiles middleware, and only E2E notices. The
     * #1804 block must therefore stay inline and import-free.
     */
    it('should keep the Issue #1804 block free of imports', () => {
      // The block's own comment explains WHY it must not import, so strip
      // comments before looking for the thing they talk about.
      const code = extractRawUrlBlock()
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');

      expect(code).toContain("delete req.headers['x-cm-raw-url']");
      expect(code).not.toMatch(/\bimport\b/);
      expect(code).not.toMatch(/\brequire\s*\(/);
    });

    it('should not add a static import of the proxy config module to server.ts', () => {
      const source = readFileSync(SERVER_TS_PATH, 'utf8');

      expect(source).not.toMatch(/^import .*proxy\/config/m);
    });
  });
});
