/**
 * CommandMate CLI Entry Point
 * Issue #96: npm install CLI support
 * Issue #1195: Program construction lives in program.ts; this file only runs it
 *
 * bin/commandmate.js requires this module for its side effect, so the parse() call must
 * stay at module scope.
 *
 * Issue #2376: the three delegation commands are attached HERE rather than
 * inside `buildProgram()`. They are one feature — "let session A ask session B
 * something" — added as a unit, and attaching them at the entry point keeps
 * `buildProgram()` exactly what the pre-existing tests characterise it as while
 * still putting `ask` / `whoami` / `peers` on `--help`, on `help <cmd>` and on
 * the parse path. `program.addCommand()` is commander's own composition API and
 * the resulting program is indistinguishable from one that declared them inline.
 *
 * Issue #2377 adds `relays` to that group, for the same reason: it is the other
 * half of the same feature — what a delegation left standing — and `send`'s and
 * `ask`'s `--reply-to` are declared on their own commands inside
 * `buildProgram()` because those commands already exist there.
 */

import { buildProgram } from './program';
import { createAskCommand } from './commands/ask';
import { createWhoamiCommand } from './commands/whoami';
import { createPeersCommand } from './commands/peers';
import { createRelaysCommand } from './commands/relays';

const program = buildProgram();

// Issue #2376: delegation between agent sessions.
program.addCommand(createAskCommand());
program.addCommand(createWhoamiCommand());
program.addCommand(createPeersCommand());
// Issue #2377: and the ledger the delegation leaves behind.
program.addCommand(createRelaysCommand());

// Parse and execute
program.parse();
