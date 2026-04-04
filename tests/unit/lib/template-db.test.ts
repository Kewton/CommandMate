/**
 * Report Template DB unit tests
 * Issue #618: Report template system
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  getAllTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getTemplateCount,
} from '@/lib/db/template-db';

describe('template-db', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('createTemplate', () => {
    it('should create a template with generated UUID', () => {
      const template = createTemplate(db, { name: 'Test', content: 'Test content' });

      expect(template.id).toBeDefined();
      expect(template.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(template.name).toBe('Test');
      expect(template.content).toBe('Test content');
      expect(template.sortOrder).toBe(0);
      expect(template.createdAt).toBeInstanceOf(Date);
      expect(template.updatedAt).toBeInstanceOf(Date);
    });

    it('should persist template in database', () => {
      const created = createTemplate(db, { name: 'Persist', content: 'Content' });
      const fetched = getTemplateById(db, created.id);

      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe('Persist');
      expect(fetched!.content).toBe('Content');
    });
  });

  describe('getAllTemplates', () => {
    it('should return empty array when no templates exist', () => {
      const templates = getAllTemplates(db);
      expect(templates).toEqual([]);
    });

    it('should return all templates sorted by created_at ASC', async () => {
      createTemplate(db, { name: 'First', content: 'Content 1' });
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      createTemplate(db, { name: 'Second', content: 'Content 2' });

      const templates = getAllTemplates(db);
      expect(templates).toHaveLength(2);
      expect(templates[0].name).toBe('First');
      expect(templates[1].name).toBe('Second');
    });
  });

  describe('getTemplateById', () => {
    it('should return null for non-existent ID', () => {
      const result = getTemplateById(db, 'non-existent-id');
      expect(result).toBeNull();
    });

    it('should return template for valid ID', () => {
      const created = createTemplate(db, { name: 'Find me', content: 'Here' });
      const found = getTemplateById(db, created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe('Find me');
    });
  });

  describe('updateTemplate', () => {
    it('should update name only', () => {
      const created = createTemplate(db, { name: 'Original', content: 'Original content' });
      updateTemplate(db, created.id, { name: 'Updated' });

      const updated = getTemplateById(db, created.id);
      expect(updated!.name).toBe('Updated');
      expect(updated!.content).toBe('Original content');
    });

    it('should update content only', () => {
      const created = createTemplate(db, { name: 'Original', content: 'Original content' });
      updateTemplate(db, created.id, { content: 'New content' });

      const updated = getTemplateById(db, created.id);
      expect(updated!.name).toBe('Original');
      expect(updated!.content).toBe('New content');
    });

    it('should update both name and content', () => {
      const created = createTemplate(db, { name: 'Old', content: 'Old content' });
      updateTemplate(db, created.id, { name: 'New', content: 'New content' });

      const updated = getTemplateById(db, created.id);
      expect(updated!.name).toBe('New');
      expect(updated!.content).toBe('New content');
    });

    it('should update updated_at timestamp', async () => {
      const created = createTemplate(db, { name: 'Time', content: 'Content' });
      const originalUpdatedAt = created.updatedAt.getTime();

      await new Promise(resolve => setTimeout(resolve, 10));
      updateTemplate(db, created.id, { name: 'Updated time' });

      const updated = getTemplateById(db, created.id);
      expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(originalUpdatedAt);
    });
  });

  describe('deleteTemplate', () => {
    it('should delete a template', () => {
      const created = createTemplate(db, { name: 'Delete me', content: 'Content' });
      deleteTemplate(db, created.id);

      const result = getTemplateById(db, created.id);
      expect(result).toBeNull();
    });

    it('should not throw for non-existent ID', () => {
      expect(() => deleteTemplate(db, 'non-existent')).not.toThrow();
    });
  });

  describe('getTemplateCount', () => {
    it('should return 0 when no templates exist', () => {
      expect(getTemplateCount(db)).toBe(0);
    });

    it('should return correct count', () => {
      createTemplate(db, { name: 'One', content: 'Content 1' });
      createTemplate(db, { name: 'Two', content: 'Content 2' });
      createTemplate(db, { name: 'Three', content: 'Content 3' });

      expect(getTemplateCount(db)).toBe(3);
    });

    it('should decrease after deletion', () => {
      const t = createTemplate(db, { name: 'Temp', content: 'Content' });
      createTemplate(db, { name: 'Keep', content: 'Content' });
      expect(getTemplateCount(db)).toBe(2);

      deleteTemplate(db, t.id);
      expect(getTemplateCount(db)).toBe(1);
    });
  });
});
