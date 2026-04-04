/**
 * Unit tests for Report Templates API
 * Issue #618: Report template system
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createTemplate,
  getTemplateCount,
} from '@/lib/db/template-db';

// In-memory DB for testing
let testDb: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => testDb),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Import route handlers after mocks
import { GET, POST } from '@/app/api/templates/route';
import { PUT, DELETE } from '@/app/api/templates/[id]/route';

function createRequest(options: {
  method?: string;
  body?: unknown;
  url?: string;
} = {}) {
  const { method = 'GET', body, url = 'http://localhost:3000/api/templates' } = options;
  return new Request(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as import('next/server').NextRequest;
}

function createParamsPromise(id: string) {
  return Promise.resolve({ id });
}

describe('Templates API', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
  });

  describe('GET /api/templates', () => {
    it('should return empty list when no templates exist', async () => {
      const res = await GET();
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.templates).toEqual([]);
    });

    it('should return all templates', async () => {
      createTemplate(testDb, { name: 'Template 1', content: 'Content 1' });
      createTemplate(testDb, { name: 'Template 2', content: 'Content 2' });

      const res = await GET();
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.templates).toHaveLength(2);
      expect(data.templates[0].name).toBe('Template 1');
      expect(data.templates[1].name).toBe('Template 2');
    });
  });

  describe('POST /api/templates', () => {
    it('should create a template', async () => {
      const req = createRequest({
        method: 'POST',
        body: { name: 'New Template', content: 'New content' },
      });

      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(201);
      expect(data.template.name).toBe('New Template');
      expect(data.template.content).toBe('New content');
      expect(data.template.id).toBeDefined();
    });

    it('should reject empty name', async () => {
      const req = createRequest({
        method: 'POST',
        body: { name: '', content: 'Content' },
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it('should reject empty content', async () => {
      const req = createRequest({
        method: 'POST',
        body: { name: 'Name', content: '' },
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it('should reject name exceeding max length', async () => {
      const req = createRequest({
        method: 'POST',
        body: { name: 'a'.repeat(101), content: 'Content' },
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it('should reject content exceeding max length', async () => {
      const req = createRequest({
        method: 'POST',
        body: { name: 'Name', content: 'a'.repeat(1001) },
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it('should reject when template limit is reached (409)', async () => {
      // Create 5 templates
      for (let i = 0; i < 5; i++) {
        createTemplate(testDb, { name: `Template ${i}`, content: `Content ${i}` });
      }
      expect(getTemplateCount(testDb)).toBe(5);

      const req = createRequest({
        method: 'POST',
        body: { name: 'Over limit', content: 'Content' },
      });

      const res = await POST(req);
      expect(res.status).toBe(409);
    });

    it('should reject missing name field', async () => {
      const req = createRequest({
        method: 'POST',
        body: { content: 'Content only' },
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it('should reject missing content field', async () => {
      const req = createRequest({
        method: 'POST',
        body: { name: 'Name only' },
      });

      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it('should trim name and content', async () => {
      const req = createRequest({
        method: 'POST',
        body: { name: '  Trimmed  ', content: '  Content  ' },
      });

      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(201);
      expect(data.template.name).toBe('Trimmed');
      expect(data.template.content).toBe('Content');
    });
  });

  describe('PUT /api/templates/[id]', () => {
    it('should update a template', async () => {
      const template = createTemplate(testDb, { name: 'Original', content: 'Original content' });

      const req = createRequest({
        method: 'PUT',
        body: { name: 'Updated', content: 'Updated content' },
      });

      const res = await PUT(req, { params: createParamsPromise(template.id) });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.template.name).toBe('Updated');
      expect(data.template.content).toBe('Updated content');
    });

    it('should return 400 for invalid UUID format', async () => {
      const req = createRequest({
        method: 'PUT',
        body: { name: 'Updated' },
      });

      const res = await PUT(req, { params: createParamsPromise('not-a-uuid') });
      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent template', async () => {
      const req = createRequest({
        method: 'PUT',
        body: { name: 'Updated' },
      });

      const res = await PUT(req, { params: createParamsPromise('12345678-1234-4234-8234-123456789012') });
      expect(res.status).toBe(404);
    });

    it('should reject empty name', async () => {
      const template = createTemplate(testDb, { name: 'Original', content: 'Content' });

      const req = createRequest({
        method: 'PUT',
        body: { name: '' },
      });

      const res = await PUT(req, { params: createParamsPromise(template.id) });
      expect(res.status).toBe(400);
    });

    it('should reject empty content', async () => {
      const template = createTemplate(testDb, { name: 'Original', content: 'Content' });

      const req = createRequest({
        method: 'PUT',
        body: { content: '' },
      });

      const res = await PUT(req, { params: createParamsPromise(template.id) });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/templates/[id]', () => {
    it('should delete a template', async () => {
      const template = createTemplate(testDb, { name: 'Delete me', content: 'Content' });

      const req = createRequest({ method: 'DELETE' });
      const res = await DELETE(req, { params: createParamsPromise(template.id) });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(getTemplateCount(testDb)).toBe(0);
    });

    it('should return 400 for invalid UUID format', async () => {
      const req = createRequest({ method: 'DELETE' });
      const res = await DELETE(req, { params: createParamsPromise('invalid') });
      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent template', async () => {
      const req = createRequest({ method: 'DELETE' });
      const res = await DELETE(req, { params: createParamsPromise('12345678-1234-4234-8234-123456789012') });
      expect(res.status).toBe(404);
    });
  });
});
