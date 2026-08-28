/**
 * The persisted "which opencode session was this instance in" memory
 * (Issue #2038).
 *
 * Two of the assertions here are acceptance conditions rather than unit
 * coverage:
 *
 *  - **`recoverOpencodeSessionId` refuses an entry recorded for a different
 *    worktree.** Sessions belong to opencode's own database rather than to a
 *    server, so one `HOME` holds every worktree's sessions at once — measured on
 *    1.18.22, `GET /session` from a server started in directory A returned
 *    directory B's sessions too. Without this guard a worktree id reused at a
 *    new path would resume another repository's conversation, and opencode
 *    would accept it.
 *  - **`withOpencodeResumedSession` refuses anything that is not a session id.**
 *    The value is interpolated into a shell command line typed into the
 *    operator's own pane, and the file it comes from is writable by anything
 *    running as the user.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';
import {
  MAX_OPENCODE_SESSION_TITLE_LENGTH,
  forgetOpencodeSession,
  getOpencodeSessionFilePath,
  getRememberedOpencodeSession,
  isOpencodeSessionId,
  readPersistedOpencodeSessions,
  recoverOpencodeSessionId,
  rememberOpencodeSession,
  resetOpencodeSessionMemories,
  withOpencodeResumedSession,
} from '@/lib/session/opencode-session-store';

const WORKTREE_PATH = '/tmp/wt-2038';
const OTHER_PATH = '/tmp/wt-2038-elsewhere';
const SESSION_ID = 'ses_fc9802f88ffeZzlE5mU5cYYEFs';

const target: AgentInstanceRef = { worktreeId: 'wt-2038', cliToolId: 'opencode' };
const second: AgentInstanceRef = {
  worktreeId: 'wt-2038',
  cliToolId: 'opencode',
  instanceId: 'opencode-2',
};

let sandbox: string;
let savedFile: string | undefined;

beforeEach(() => {
  sandbox = makeTempDir('opencode-session-store-2038-');
  savedFile = process.env.CM_OPENCODE_SESSION_FILE;
  process.env.CM_OPENCODE_SESSION_FILE = join(sandbox, 'opencode-sessions.json');
  resetOpencodeSessionMemories();
});

afterEach(() => {
  if (savedFile === undefined) delete process.env.CM_OPENCODE_SESSION_FILE;
  else process.env.CM_OPENCODE_SESSION_FILE = savedFile;
  resetOpencodeSessionMemories();
  removeTempDir(sandbox);
});

describe('isOpencodeSessionId', () => {
  it('accepts a real id measured off opencode 1.18.22', () => {
    expect(isOpencodeSessionId(SESSION_ID)).toBe(true);
  });

  it.each([
    ['no ses prefix', 'msg_fc9802f88ffeZzlE5mU5cYYEFs'],
    ['a shell metacharacter', 'ses_abc; rm -rf /'],
    ['a space', 'ses_abc def'],
    ['a quote', "ses_abc'"],
    ['prefix only', 'ses'],
    ['not a string', 42],
  ])('refuses %s', (_label, value) => {
    expect(isOpencodeSessionId(value)).toBe(false);
  });
});

describe('rememberOpencodeSession / getRememberedOpencodeSession', () => {
  it('round-trips through the file, and a fresh process reads it back', () => {
    expect(
      rememberOpencodeSession(target, {
        sessionId: SESSION_ID,
        title: 'Fix the launcher',
        worktreePath: WORKTREE_PATH,
      })
    ).toBe(true);

    // Losing the in-memory map is exactly the CommandMate-restart case this
    // file exists for.
    resetOpencodeSessionMemories();

    const memory = getRememberedOpencodeSession(target);
    expect(memory?.sessionId).toBe(SESSION_ID);
    expect(memory?.title).toBe('Fix the launcher');
    expect(memory?.worktreePath).toBe(WORKTREE_PATH);
  });

  it('keys instances apart, so a second opencode pane has its own memory', () => {
    rememberOpencodeSession(target, { sessionId: SESSION_ID, worktreePath: WORKTREE_PATH });
    rememberOpencodeSession(second, {
      sessionId: 'ses_second0000000000000000',
      worktreePath: WORKTREE_PATH,
    });
    resetOpencodeSessionMemories();

    expect(getRememberedOpencodeSession(target)?.sessionId).toBe(SESSION_ID);
    expect(getRememberedOpencodeSession(second)?.sessionId).toBe('ses_second0000000000000000');
  });

  it('refuses an id it would not put in front of a shell, and writes nothing', () => {
    expect(
      rememberOpencodeSession(target, {
        sessionId: 'ses_abc; curl evil',
        worktreePath: WORKTREE_PATH,
      })
    ).toBe(false);
    expect(readPersistedOpencodeSessions()).toEqual({});
  });

  it('bounds the title', () => {
    rememberOpencodeSession(target, {
      sessionId: SESSION_ID,
      title: 'x'.repeat(MAX_OPENCODE_SESSION_TITLE_LENGTH + 50),
      worktreePath: WORKTREE_PATH,
    });
    expect(getRememberedOpencodeSession(target)?.title).toHaveLength(
      MAX_OPENCODE_SESSION_TITLE_LENGTH
    );
  });

  it('writes the file with owner-only permissions and valid JSON', () => {
    rememberOpencodeSession(target, { sessionId: SESSION_ID, worktreePath: WORKTREE_PATH });
    const raw = readFileSync(getOpencodeSessionFilePath(), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe('readPersistedOpencodeSessions', () => {
  it('answers {} for a missing file', () => {
    expect(readPersistedOpencodeSessions()).toEqual({});
  });

  it('answers {} for a file somebody broke', () => {
    writeFileSync(getOpencodeSessionFilePath(), 'not json at all');
    expect(readPersistedOpencodeSessions()).toEqual({});
  });

  it('drops entries whose session id or path would not be usable', () => {
    writeFileSync(
      getOpencodeSessionFilePath(),
      JSON.stringify({
        good: { sessionId: SESSION_ID, worktreePath: WORKTREE_PATH, title: null, updatedAt: 1 },
        badId: { sessionId: 'nope', worktreePath: WORKTREE_PATH },
        noPath: { sessionId: SESSION_ID, worktreePath: '' },
        notObject: 7,
      })
    );
    expect(Object.keys(readPersistedOpencodeSessions())).toEqual(['good']);
  });
});

describe('recoverOpencodeSessionId', () => {
  it('returns the id when the worktree path matches', () => {
    rememberOpencodeSession(target, { sessionId: SESSION_ID, worktreePath: WORKTREE_PATH });
    expect(recoverOpencodeSessionId(target, WORKTREE_PATH)).toBe(SESSION_ID);
  });

  it('ACCEPTANCE: refuses a session recorded for a different worktree', () => {
    rememberOpencodeSession(target, { sessionId: SESSION_ID, worktreePath: OTHER_PATH });
    expect(recoverOpencodeSessionId(target, WORKTREE_PATH)).toBeNull();
  });

  it('returns null when nothing was ever recorded', () => {
    expect(recoverOpencodeSessionId(target, WORKTREE_PATH)).toBeNull();
  });
});

describe('forgetOpencodeSession', () => {
  it('removes the entry from memory and from the file', () => {
    rememberOpencodeSession(target, { sessionId: SESSION_ID, worktreePath: WORKTREE_PATH });
    forgetOpencodeSession(target);
    expect(getRememberedOpencodeSession(target)).toBeNull();
    expect(readPersistedOpencodeSessions()).toEqual({});
  });
});

describe('withOpencodeResumedSession', () => {
  it('appends the resume flag opencode 1.18.22 documents', () => {
    expect(withOpencodeResumedSession('opencode --port 4211', SESSION_ID)).toBe(
      `opencode --port 4211 -s ${SESSION_ID}`
    );
  });

  it('leaves the command untouched for anything that is not a session id', () => {
    const command = 'opencode --port 4211';
    expect(withOpencodeResumedSession(command, 'ses_x; rm -rf ~')).toBe(command);
    expect(withOpencodeResumedSession(command, '')).toBe(command);
  });
});

describe('CM_OPENCODE_SESSION_FILE', () => {
  it('falls back to ~/.commandmate when no override is set', () => {
    delete process.env.CM_OPENCODE_SESSION_FILE;
    const path = getOpencodeSessionFilePath();
    expect(path).toContain(join('.commandmate', 'opencode-sessions.json'));
  });

  it('honours an ordinary override', () => {
    const custom = join(sandbox, 'nested', 'sessions.json');
    process.env.CM_OPENCODE_SESSION_FILE = custom;
    expect(getOpencodeSessionFilePath()).toBe(custom);
  });

  // The `/proc` / `/sys` / `/dev` refusal is `resolveSafeDirectory`'s (Issue
  // #1774) and is asserted in its own suite. It is deliberately NOT re-asserted
  // here: `tests/unit/guards/no-procfs-env-fixtures.test.ts` forbids pointing an
  // env var at a virtual filesystem from a test, because a recursive mkdir under
  // /proc spins forever inside C++ on Linux and vitest's timeout cannot fire.
});
