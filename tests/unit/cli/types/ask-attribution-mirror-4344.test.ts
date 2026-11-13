/**
 * Issue #4344 (PR3): the CLI's copies of the ask ledger's wire types
 * (`src/cli/types/api-responses.ts`) say what the server's do
 * (`src/types/ask-correlation.ts`). The CLI keeps its own copies rather than
 * importing across the build boundary, so a reason or a field added on one side
 * only would be read as nothing on the other; the sets are held equal at
 * compile time, and the protocol constant at run time.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import type * as Cli from '@/cli/types/api-responses';
import type * as Server from '@/types/ask-correlation';
import { ASK_PROTOCOL_VERSION as SERVER_PROTOCOL } from '@/types/ask-correlation';
import { ASK_PROTOCOL_VERSION as CLI_PROTOCOL } from '@/cli/utils/ask-reply';

type AssertNever<T extends never> = T;
type Same<A, B> = Exclude<A, B> | Exclude<B, A>;

type _State = AssertNever<Same<Cli.AskAttributionState, Server.AskAttributionState>>;
type _Reason = AssertNever<Same<Cli.AskAttributionReason, Server.AskAttributionReason>>;
type _SendState = AssertNever<Same<Cli.AskSendState, Server.AskSendState>>;
type _Answer = AssertNever<Same<keyof Cli.AskAttributionResponse, keyof Server.AskAttributionResponse>>;
type _SendAnswer = AssertNever<Same<keyof Cli.AskSendAnswer, keyof Server.AskSendAnswer>>;
type _Capabilities = AssertNever<Same<keyof Cli.AskCapabilitiesResponse, keyof Server.AskCapabilitiesResponse>>;

describe('the CLI mirror of the ask ledger types (Issue #4344)', () => {
  it('speaks the server\'s envelope protocol', () => {
    expect(CLI_PROTOCOL).toBe(SERVER_PROTOCOL);
  });

  it('a server answer type-checks as the CLI\'s (compile-time sets above)', () => {
    const answer: Server.AskAttributionResponse = {
      askId: 'a', state: 'matched', reason: null, reply: 'hi', sendState: 'sent', nativeInputSeen: true, notified: false,
    };
    const asCli: Cli.AskAttributionResponse = answer;
    expect(asCli.reply).toBe('hi');
  });
});
