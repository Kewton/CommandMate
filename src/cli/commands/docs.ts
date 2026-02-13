/**
 * Docs Command
 * Issue #264: Documentation retrieval (RAG-like usage for AI tools)
 *
 * [MF-CONS-001] Uses createDocsCommand() factory + addCommand() pattern,
 * unified with issue command registration style.
 *
 * [SF-003] SRP: This handler only does argument parsing and output formatting.
 * File I/O and search logic are delegated to DocsReader utility (docs-reader.ts).
 *
 * [SF-CONS-005] Uses console.log directly (status command pattern) since this is
 * an output-only command with no server lifecycle management.
 *
 * @module docs-command
 */

import { Command } from 'commander';
import { ExitCode, DocsOptions, getErrorMessage } from '../types';
import {
  getAvailableSections,
  isValidSection,
  readSection,
  searchDocs,
} from '../utils/docs-reader';

/**
 * Create the docs command.
 * [MF-CONS-001] Returns a Command instance for program.addCommand().
 */
export function createDocsCommand(): Command {
  const docsCommand = new Command('docs')
    .description('Access CommandMate documentation')
    .option('-s, --section <name>', 'Show specific documentation section')
    .option('-q, --search <query>', 'Search documentation')
    .option('-a, --all', 'Show all available section names')
    .action((options: DocsOptions) => {
      if (options.all) {
        const sections = getAvailableSections();
        console.log('Available documentation sections:');
        console.log('');
        sections.forEach(s => console.log(`  - ${s}`));
        console.log('');
        console.log('Usage: commandmate docs --section <name>');
        process.exit(ExitCode.SUCCESS);
      }

      if (options.section) {
        if (!isValidSection(options.section)) {
          console.error(`Unknown section: ${options.section}`);
          console.error('');
          console.error('Available sections:');
          getAvailableSections().forEach(s => console.error(`  - ${s}`));
          process.exit(ExitCode.UNEXPECTED_ERROR);
        }

        try {
          const content = readSection(options.section);
          console.log(content);
        } catch (error) {
          console.error(`Error reading section: ${getErrorMessage(error)}`);
          process.exit(ExitCode.UNEXPECTED_ERROR);
        }
        process.exit(ExitCode.SUCCESS);
      }

      if (options.search) {
        try {
          const results = searchDocs(options.search);
          if (results.length === 0) {
            console.log(`No results found for: "${options.search}"`);
          } else {
            console.log(`Search results for: "${options.search}"`);
            console.log('');
            for (const result of results) {
              console.log(`--- ${result.section} ---`);
              result.matches.forEach(match => console.log(`  ${match.trim()}`));
              console.log('');
            }
          }
        } catch (error) {
          console.error(`Search error: ${getErrorMessage(error)}`);
          process.exit(ExitCode.UNEXPECTED_ERROR);
        }
        process.exit(ExitCode.SUCCESS);
      }

      // No option specified: show help
      const sections = getAvailableSections();
      console.log('CommandMate Documentation');
      console.log('');
      console.log('Available sections:');
      sections.forEach(s => console.log(`  - ${s}`));
      console.log('');
      console.log('Usage:');
      console.log('  commandmate docs --section <name>   Show specific section');
      console.log('  commandmate docs --search <query>   Search documentation');
      console.log('  commandmate docs --all              List all sections');
      process.exit(ExitCode.SUCCESS);
    });

  return docsCommand;
}
