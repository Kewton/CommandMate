/**
 * Engines Field Tests
 * Issue #1195: Declare the supported Node.js runtime range in package.json
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

interface PackageJson {
  engines?: {
    node?: string;
  };
}

const packageJson: PackageJson = JSON.parse(
  readFileSync(join(__dirname, '../../../../package.json'), 'utf-8')
) as PackageJson;

describe('package.json engines', () => {
  it('should declare an engines field', () => {
    expect(packageJson.engines).toBeDefined();
  });

  it('should require Node.js >=20.0.0', () => {
    expect(packageJson.engines?.node).toBe('>=20.0.0');
  });
});
