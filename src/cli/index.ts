/**
 * CommandMate CLI Entry Point
 * Issue #96: npm install CLI support
 * Issue #1195: Program construction lives in program.ts; this file only runs it
 *
 * bin/commandmate.js requires this module for its side effect, so the parse() call must
 * stay at module scope.
 */

import { buildProgram } from './program';

// Parse and execute
buildProgram().parse();
