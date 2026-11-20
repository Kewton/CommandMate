/**
 * Preflight System Dependency Checker
 * Issue #96: npm install CLI support
 * Migrated from scripts/preflight-check.sh
 */

import { spawnSync } from 'child_process';
import { accessSync, constants as fsConstants, statSync } from 'fs';
import { delimiter, join } from 'path';
import {
  DependencyCheck,
  DependencyStatus,
  PreflightResult,
} from '../types';
import { getDependencies } from '../config/cli-dependencies';
import { compareVersions } from './semver';
import { loadEnvFileValues } from './server-url';
import { mayProbeToolVersion } from '../../lib/tool-policy/version-probe-gate';

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Issue #4480: where the usage declaration (`CM_ANTIGRAVITY_USAGE`) is read for the
 * preflight. The shell first, else the server's `.env` (the declaration is
 * documented as the server's setting, and `init --force` / `quickstart` run where
 * that `.env` already exists). An unreadable `.env` is no declaration.
 */
export function preflightDeclarationEnv(env: EnvLike = process.env): EnvLike {
  let fileValues: Record<string, string> = {};
  try {
    fileValues = loadEnvFileValues();
  } catch {
    fileValues = {};
  }
  return { ...fileValues, ...env };
}

/**
 * Whether `command` is an executable file in one of `PATH`'s directories. Reads
 * the file system only: no child process is started (Issue #4480).
 */
export function isCommandOnPath(command: string, pathValue: string | undefined = process.env.PATH): boolean {
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return true;
    } catch {
      // not here
    }
  }
  return false;
}

/**
 * Preflight checker for system dependencies
 */
export class PreflightChecker {
  /**
   * Check a single dependency
   * MF-SEC-1: Uses spawnSync with array args (no shell injection)
   */
  async checkDependency(dep: DependencyCheck, declarationEnv?: EnvLike): Promise<DependencyStatus> {
    // Issue #4480: a gated tool's version command (agy) is not run unless the gate
    // (#4452: the usage declaration) allows it; it is only looked up on PATH.
    if (dep.gatedTool && !mayProbeToolVersion(dep.gatedTool, declarationEnv ?? preflightDeclarationEnv())) {
      return isCommandOnPath(dep.command)
        ? { name: dep.name, status: 'not_checked' }
        : { name: dep.name, status: 'missing' };
    }
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
        if (compareVersions(cleanVersion, dep.minVersion) < 0) {
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
    const declarationEnv = preflightDeclarationEnv();

    for (const dep of dependencies) {
      const status = await this.checkDependency(dep, declarationEnv);
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
   * Get installation hint for a dependency
   */
  static getInstallHint(name: string): string {
    const hints: Record<string, string> = {
      'Node.js': 'Install with: nvm install 22 or visit https://nodejs.org',
      npm: 'npm is included with Node.js. Install Node.js first.',
      tmux: 'Install with: brew install tmux (macOS) or apt install tmux (Linux)',
      git: 'Install with: brew install git (macOS) or apt install git (Linux)',
      'Claude CLI': 'Install with: npm install -g @anthropic-ai/claude-cli',
      'gh CLI': 'Install GitHub CLI: https://cli.github.com/ or brew install gh',
      // Issue #2069: the three agent CLIs this list carries as optional. A
      // reader who sees "Not found" next to one of them is being told to
      // install it, so the line that follows should say how.
      'Codex CLI': 'Install with: npm install -g @openai/codex',
      'GitHub Copilot CLI': 'Install with: npm install -g @github/copilot',
      'OpenCode CLI': 'Install with: npm install -g opencode-ai',
    };

    return hints[name] || `Please install ${name}`;
  }
}
