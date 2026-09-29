/**
 * Both CMATE schedules guides document opencode-v2's run options (Issue #2982).
 *
 * Anchored to the parser's own syntax constant, so a grammar change that is not
 * carried into the ja / en guides turns this red.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPENCODE_V2_COLUMN_SYNTAX } from '@/lib/cmate-cli-tool-parser';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const GUIDES = [
  'docs/user-guide/cmate-schedules-guide.md',
  'docs/en/user-guide/cmate-schedules-guide.md',
];

describe('opencode-v2 run options in the CMATE schedules guides (Issue #2982)', () => {
  it.each(GUIDES)('%s shows the v2 column grammar and the model#variant mapping', (file) => {
    const body = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');
    expect(body).toContain('#2982');
    expect(body).toContain(OPENCODE_V2_COLUMN_SYNTAX);
    expect(body).toContain('`-m <provider/model>#<name>`');
    expect(body).toContain('opencode-v2 --model anthropic/claude-sonnet-4-5 --agent plan');
    // The pre-#2982 sentence saying v2 takes no options must be gone.
    expect(body).not.toContain('opencode-v2 ではまだ書けません');
    expect(body).not.toContain('not accepted for opencode-v2 yet');
  });
});
