/**
 * Preflight System Dependency Checker
 * Issue #96: npm install CLI support
 * Migrated from scripts/preflight-check.sh
 */

import { spawnSync } from 'child_process';
import {
  DependencyCheck,
  DependencyStatus,
  PreflightResult,
} from '../types';
import { getDependencies } from '../config/cli-dependencies';

/**
 * Preflight checker for system dependencies
 */
export class PreflightChecker {
  /**
   * Check a single dependency
   * MF-SEC-1: Uses spawnSync with array args (no shell injection)
   */
  async checkDependency(dep: DependencyCheck): Promise<DependencyStatus> {
    try {
      const result = spawnSync(dep.command, [dep.versionArg], {
        encoding: 'utf-8',
        timeout: 5000,
      });

      if (result.error) {
        const errnoError = result.error as NodeJS.ErrnoException;
        if (errnoError.code === 'ENOENT') {
          return { name: dep.name, status: 'missing' };
        }
        throw result.error;
      }

      if (result.status !== 0) {
        return { name: dep.name, status: 'missing' };
      }

      // Extract version from output (encoding: 'utf-8' ensures strings)
      const output = ((result.stdout || result.stderr) as string || '').trim();
      const version = this.extractVersion(output) || output;

      // Check minimum version if specified
      if (dep.minVersion && version) {
        const cleanVersion = version.replace(/^v/, '');
        if (this.compareVersions(cleanVersion, dep.minVersion) < 0) {
          return {
            name: dep.name,
            status: 'version_mismatch',
            version,
          };
        }
      }

      return {
        name: dep.name,
        status: 'ok',
        version,
      };
    } catch {
      return { name: dep.name, status: 'missing' };
    }
  }

  /**
   * Check all dependencies
   */
  async checkAll(): Promise<PreflightResult> {
    const dependencies = getDependencies();
    const results: DependencyStatus[] = [];
    let allRequiredMet = true;

    for (const dep of dependencies) {
      const status = await this.checkDependency(dep);
      results.push(status);

      if (dep.required && status.status !== 'ok') {
        allRequiredMet = false;
      }
    }

    return {
      success: allRequiredMet,
      results,
    };
  }

  /**
   * Extract version number from command output
   */
  private extractVersion(output: string): string | undefined {
    // Match various version formats:
    // v20.0.0, 2.39.0, "git version 2.39.0", etc.
    const patterns = [
      /v?(\d+\.\d+\.\d+)/,
      /version\s+(\d+\.\d+\.\d+)/i,
      /(\d+\.\d+\.\d+)/,
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return undefined;
  }

  /**
   * Compare two version strings
   * @returns -1 if a < b, 0 if a == b, 1 if a > b
   */
  private compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    const len = Math.max(partsA.length, partsB.length);

    for (let i = 0; i < len; i++) {
      const numA = partsA[i] || 0;
      const numB = partsB[i] || 0;
      if (numA > numB) return 1;
      if (numA < numB) return -1;
    }

    return 0;
  }

  /**
   * Get installation hint for a dependency
   */
  static getInstallHint(name: string): string {
    const hints: Record<string, string> = {
      'Node.js': 'Install with: nvm install 20 or visit https://nodejs.org',
      npm: 'npm is included with Node.js. Install Node.js first.',
      tmux: 'Install with: brew install tmux (macOS) or apt install tmux (Linux)',
      git: 'Install with: brew install git (macOS) or apt install git (Linux)',
      'Claude CLI': 'Install with: npm install -g @anthropic-ai/claude-cli',
      'gh CLI': 'Install GitHub CLI: https://cli.github.com/ or brew install gh',
    };

    return hints[name] || `Please install ${name}`;
  }
}
