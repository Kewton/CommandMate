/**
 * Engines Field Tests
 * Issue #1195: Declare the supported Node.js runtime range in package.json
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEPENDENCIES } from '../../../../src/cli/config/cli-dependencies';

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

  it('should require Node.js >=22.0.0', () => {
    expect(packageJson.engines?.node).toBe('>=22.0.0');
  });

  // Issue #1264: engines and the CLI preflight floor are declared in two places.
  // They drifted apart once already; this pins them together.
  it('should match the Node.js minVersion enforced by the CLI preflight', () => {
    const preflightMin = DEPENDENCIES.find(d => d.name === 'Node.js')?.minVersion;
    expect(preflightMin).toBeDefined();
    expect(packageJson.engines?.node).toBe(`>=${preflightMin}`);
  });

  // npm mirrors engines into the lockfile's root package entry, so whoever runs
  // `npm install` next silently rewrites the lockfile and dirties an unrelated
  // branch. #1264 raised engines while #1271 had already baked the old value
  // into the lock, and the two merged in that order — nothing failed, it just
  // drifted. `npm ci` does not check this, so only a test will.
  it('should match the engines recorded in package-lock.json', () => {
    const lock: { packages?: Record<string, PackageJson> } = JSON.parse(
      readFileSync(join(__dirname, '../../../../package-lock.json'), 'utf-8')
    ) as { packages?: Record<string, PackageJson> };

    expect(lock.packages?.['']?.engines?.node).toBe(packageJson.engines?.node);
  });
});
