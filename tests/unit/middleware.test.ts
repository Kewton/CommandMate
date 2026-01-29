/**
 * Authentication Middleware Tests
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Import middleware function
import { middleware } from '@/middleware';

describe('Authentication Middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('localhost binding (127.0.0.1)', () => {
    beforeEach(() => {
      process.env.CM_BIND = '127.0.0.1';
      process.env.CM_AUTH_TOKEN = 'test-token';
    });

    it('should allow requests without authentication', () => {
      const request = new NextRequest('http://localhost:3000/api/worktrees');

      const response = middleware(request);

      expect(response).toBeUndefined(); // Next.js middleware returns undefined to continue
    });

    it('should allow requests with valid token', () => {
      const request = new NextRequest('http://localhost:3000/api/worktrees', {
        headers: {
          'Authorization': 'Bearer test-token',
        },
      });

      const response = middleware(request);

      expect(response).toBeUndefined();
    });

    it('should allow requests with invalid token (auth optional for localhost)', () => {
      const request = new NextRequest('http://localhost:3000/api/worktrees', {
        headers: {
          'Authorization': 'Bearer wrong-token',
        },
      });

      const response = middleware(request);

      expect(response).toBeUndefined();
    });
  });

  describe('public binding (0.0.0.0)', () => {
    beforeEach(() => {
      process.env.CM_BIND = '0.0.0.0';
      process.env.CM_AUTH_TOKEN = 'test-token';
    });

    it('should reject requests without Authorization header', () => {
      const request = new NextRequest('http://localhost:3000/api/worktrees');

      const response = middleware(request) as NextResponse;

      expect(response).toBeDefined();
      expect(response.status).toBe(401);
    });

    it('should reject requests with invalid Authorization format', () => {
      const request = new NextRequest('http://localhost:3000/api/worktrees', {
        headers: {
          'Authorization': 'InvalidFormat test-token',
        },
      });

      const response = middleware(request) as NextResponse;

      expect(response).toBeDefined();
      expect(response.status).toBe(401);
    });

    it('should reject requests with wrong token', () => {
      const request = new NextRequest('http://localhost:3000/api/worktrees', {
        headers: {
          'Authorization': 'Bearer wrong-token',
        },
      });

      const response = middleware(request) as NextResponse;

      expect(response).toBeDefined();
      expect(response.status).toBe(401);
    });

    it('should allow requests with valid token', () => {
      const request = new NextRequest('http://localhost:3000/api/worktrees', {
        headers: {
          'Authorization': 'Bearer test-token',
        },
      });

      const response = middleware(request);

      expect(response).toBeUndefined(); // Continue to next handler
    });

    it('should handle case-insensitive Bearer scheme', () => {
      const request = new NextRequest('http://localhost:3000/api/worktrees', {
        headers: {
          'Authorization': 'bearer test-token',
        },
      });

      const response = middleware(request);

      expect(response).toBeUndefined();
    });
  });

  describe('non-API routes', () => {
    beforeEach(() => {
      process.env.CM_BIND = '0.0.0.0';
      process.env.CM_AUTH_TOKEN = 'test-token';
    });

    it('should not check auth for non-API routes', () => {
      const request = new NextRequest('http://localhost:3000/');

      const response = middleware(request);

      expect(response).toBeUndefined();
    });

    it('should not check auth for static files', () => {
      const request = new NextRequest('http://localhost:3000/_next/static/file.js');

      const response = middleware(request);

      expect(response).toBeUndefined();
    });
  });

  describe('missing configuration', () => {
    it('should default to localhost if CM_BIND not set', () => {
      delete process.env.CM_BIND;
      process.env.CM_AUTH_TOKEN = 'test-token';

      const request = new NextRequest('http://localhost:3000/api/worktrees');

      const response = middleware(request);

      // Should allow (localhost default)
      expect(response).toBeUndefined();
    });

    it('should reject if CM_BIND=0.0.0.0 but no token configured', () => {
      process.env.CM_BIND = '0.0.0.0';
      delete process.env.CM_AUTH_TOKEN;

      const request = new NextRequest('http://localhost:3000/api/worktrees', {
        headers: {
          'Authorization': 'Bearer any-token',
        },
      });

      const response = middleware(request) as NextResponse;

      expect(response).toBeDefined();
      expect(response.status).toBe(500); // Server misconfiguration
    });
  });
});
