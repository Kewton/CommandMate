/** Aggregates all migration definitions into a single ordered array. */

import type { Migration } from './runner';
import { v01_v05_migrations } from './v01-v05-initial-schema';
import { v06_v10_migrations } from './v06-v10-schema-updates';
import { v11_v15_migrations } from './v11-v15-feature-additions';
import { v16_v20_migrations } from './v16-v20-refactoring';
import { v21_v23_migrations } from './v21-v23';
import { v24_migrations } from './v24-daily-summaries';
import { v25_migrations } from './v25-report-templates';
import { v26_migrations } from './v26-repository-display-name';
import { v27_migrations } from './v27-app-settings';

/**
 * Complete ordered list of all migrations.
 * Used internally by the barrel file (db-migrations.ts); NOT exported from the barrel (DR2-004).
 */
export const migrations: Migration[] = [
  ...v01_v05_migrations,
  ...v06_v10_migrations,
  ...v11_v15_migrations,
  ...v16_v20_migrations,
  ...v21_v23_migrations,
  ...v24_migrations,
  ...v25_migrations,
  ...v26_migrations,
  ...v27_migrations,
];
