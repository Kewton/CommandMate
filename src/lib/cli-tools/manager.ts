/**
 * CLI Tool Manager
 * Singleton class to manage multiple CLI tools (Claude, Codex, Gemini)
 */

import type { CLIToolType, ICLITool, CLIToolInfo } from './types';
import { ClaudeTool } from './claude';
import { CodexTool } from './codex';
import { GeminiTool } from './gemini';

/**
 * CLI Tool Manager (Singleton)
 * Provides centralized access to all CLI tools
 */
export class CLIToolManager {
  private static instance: CLIToolManager;
  private tools: Map<CLIToolType, ICLITool>;

  /**
   * Private constructor for Singleton pattern
   */
  private constructor() {
    this.tools = new Map();

    // Initialize all tools
    this.tools.set('claude', new ClaudeTool());
    this.tools.set('codex', new CodexTool());
    this.tools.set('gemini', new GeminiTool());
  }

  /**
   * Get singleton instance
   *
   * @returns CLIToolManager instance
   */
  static getInstance(): CLIToolManager {
    if (!CLIToolManager.instance) {
      CLIToolManager.instance = new CLIToolManager();
    }
    return CLIToolManager.instance;
  }

  /**
   * Get a specific CLI tool by type
   *
   * @param type - CLI tool type
   * @returns CLI tool instance
   *
   * @example
   * ```typescript
   * const manager = CLIToolManager.getInstance();
   * const claude = manager.getTool('claude');
   * await claude.startSession('my-worktree', '/path/to/worktree');
   * ```
   */
  getTool(type: CLIToolType): ICLITool {
    const tool = this.tools.get(type);
    if (!tool) {
      throw new Error(`CLI tool '${type}' not found`);
    }
    return tool;
  }

  /**
   * Get all CLI tools
   *
   * @returns Array of all CLI tool instances
   *
   * @example
   * ```typescript
   * const manager = CLIToolManager.getInstance();
   * const allTools = manager.getAllTools();
   * console.log(allTools.map(t => t.name)); // ['Claude Code', 'Codex CLI', 'Gemini CLI']
   * ```
   */
  getAllTools(): ICLITool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get information about a specific tool including installation status
   *
   * @param type - CLI tool type
   * @returns Tool information with installation status
   *
   * @example
   * ```typescript
   * const manager = CLIToolManager.getInstance();
   * const info = await manager.getToolInfo('claude');
   * if (info.installed) {
   *   console.log(`${info.name} is installed`);
   * }
   * ```
   */
  async getToolInfo(type: CLIToolType): Promise<CLIToolInfo> {
    const tool = this.getTool(type);
    const installed = await tool.isInstalled();

    return {
      id: tool.id,
      name: tool.name,
      command: tool.command,
      installed,
    };
  }

  /**
   * Get information about all tools including installation status
   *
   * @returns Array of tool information for all tools
   *
   * @example
   * ```typescript
   * const manager = CLIToolManager.getInstance();
   * const allInfo = await manager.getAllToolsInfo();
   * allInfo.forEach(info => {
   *   console.log(`${info.name}: ${info.installed ? 'installed' : 'not installed'}`);
   * });
   * ```
   */
  async getAllToolsInfo(): Promise<CLIToolInfo[]> {
    const tools = this.getAllTools();
    const infoPromises = tools.map(async (tool) => {
      const installed = await tool.isInstalled();
      return {
        id: tool.id,
        name: tool.name,
        command: tool.command,
        installed,
      };
    });

    return Promise.all(infoPromises);
  }

  /**
   * Get only installed tools
   *
   * @returns Array of tool information for installed tools only
   *
   * @example
   * ```typescript
   * const manager = CLIToolManager.getInstance();
   * const installed = await manager.getInstalledTools();
   * console.log(`${installed.length} tools installed`);
   * ```
   */
  async getInstalledTools(): Promise<CLIToolInfo[]> {
    const allInfo = await this.getAllToolsInfo();
    return allInfo.filter(info => info.installed);
  }
}
