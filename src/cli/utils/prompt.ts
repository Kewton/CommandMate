/**
 * Interactive Prompt Utilities
 * Issue #119: Interactive init support
 *
 * Provides readline-based prompts for CLI commands.
 * Reference implementation: scripts/setup-env.sh
 */

import * as readline from 'readline';
import { homedir } from 'os';
import { resolve } from 'path';
import { PromptOptions, ConfirmOptions } from '../types';

/**
 * Readline interface singleton
 * Reused across prompts to avoid creating multiple interfaces
 */
let rlInstance: readline.Interface | null = null;

/**
 * Get or create readline interface
 */
function getReadlineInterface(): readline.Interface {
  if (!rlInstance) {
    rlInstance = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rlInstance;
}

/**
 * Close readline interface
 * Should be called when all prompts are done
 */
export function closeReadline(): void {
  if (rlInstance) {
    rlInstance.close();
    rlInstance = null;
  }
}

/**
 * Expand tilde (~) to home directory
 *
 * @param path - Path that may contain tilde
 * @returns Path with tilde expanded to home directory
 *
 * @example
 * expandTilde('~/repos') // '/Users/xxx/repos'
 * expandTilde('/absolute/path') // '/absolute/path'
 */
export function expandTilde(path: string): string {
  if (path.startsWith('~/')) {
    return path.replace(/^~/, homedir());
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

/**
 * Resolve path to absolute path
 * Handles tilde expansion and relative paths
 *
 * @param path - Path to resolve
 * @returns Absolute path
 */
export function resolvePath(path: string): string {
  const expanded = expandTilde(path);
  return resolve(expanded);
}

/**
 * Validate port number
 *
 * @param input - Port number as string
 * @returns Error message or true if valid
 */
export function validatePort(input: string): string | true {
  const port = parseInt(input, 10);
  if (isNaN(port)) {
    return 'Port must be a number';
  }
  if (port < 1 || port > 65535) {
    return 'Port must be between 1 and 65535';
  }
  return true;
}

/**
 * Interactive prompt with default value and validation
 *
 * @param question - Question to display
 * @param options - Prompt options (default, validate)
 * @returns User input or default value
 *
 * @example
 * const port = await prompt('Server port', { default: '3000', validate: validatePort });
 */
export async function prompt(
  question: string,
  options: PromptOptions = {}
): Promise<string> {
  const rl = getReadlineInterface();
  const { default: defaultValue, validate } = options;

  const displayQuestion = defaultValue
    ? `? ${question} [${defaultValue}]: `
    : `? ${question}: `;

  return new Promise((resolvePromise) => {
    const askQuestion = (): void => {
      rl.question(displayQuestion, (answer) => {
        const trimmedAnswer = answer.trim();
        const result = trimmedAnswer || defaultValue || '';

        // Validate if validator provided
        if (validate && result) {
          const validationResult = validate(result);
          if (validationResult !== true) {
            console.log(`  Error: ${validationResult}`);
            askQuestion(); // Re-ask
            return;
          }
        }

        resolvePromise(result);
      });
    };

    askQuestion();
  });
}

/**
 * Interactive Yes/No confirmation
 *
 * @param question - Question to display
 * @param options - Confirm options (default)
 * @returns true for Yes, false for No
 *
 * @example
 * const enableExternal = await confirm('Enable external access?', { default: false });
 */
export async function confirm(
  question: string,
  options: ConfirmOptions = {}
): Promise<boolean> {
  const rl = getReadlineInterface();
  const defaultValue = options.default ?? false;

  const hint = defaultValue ? '(Y/n)' : '(y/N)';
  const displayQuestion = `? ${question} ${hint}: `;

  return new Promise((resolvePromise) => {
    const askQuestion = (): void => {
      rl.question(displayQuestion, (answer) => {
        const trimmedAnswer = answer.trim().toLowerCase();

        if (trimmedAnswer === '') {
          resolvePromise(defaultValue);
          return;
        }

        if (trimmedAnswer === 'y' || trimmedAnswer === 'yes') {
          resolvePromise(true);
          return;
        }

        if (trimmedAnswer === 'n' || trimmedAnswer === 'no') {
          resolvePromise(false);
          return;
        }

        // Invalid input - re-ask
        console.log('  Please answer with y/n or yes/no');
        askQuestion();
      });
    };

    askQuestion();
  });
}

/**
 * Check if running in interactive mode (TTY)
 *
 * @returns true if stdin is a TTY (interactive terminal)
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}
