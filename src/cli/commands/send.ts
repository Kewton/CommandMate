/**
 * send Command - Send a message to a worktree agent
 * Issue #518: [DR1-08] Factory pattern
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { SendOptions } from '../types';
import type { AutoYesContractPolicy, AutoYesSetResult } from '../types/api-responses';
import { ApiClient, ApiError } from '../utils/api-client';
import { TOKEN_WARNING } from '../utils/command-helpers';
import { AUTO_YES_DURATION_FLAG_RANGE, DEFAULT_DURATION_FLAG } from '../config/duration-constants';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import { INSTANCE_ALIAS_HELP_SUFFIX } from './instances';
import { noteAntigravityNotice } from '../utils/antigravity-notice';
import { resolveCommandTarget } from './command-target';
import { ANSWER_MODE_OPTION_DESCRIPTION } from './auto-yes';
import {
  ALLOW_RELAY_CHAIN_DESCRIPTION,
  REPLY_TO_OPTION_DESCRIPTION,
  cancelRelayQuietly,
  type RegisteredRelay,
} from './relays';
import {
  postMessage,
  undoesFailedSend,
  registerRelayForMessage,
  resolveRelayEndpoints,
  type RelayEndpoints,
} from './message-dispatch';
import { SEND_VERIFIED_MAX_KIB, SEND_VERIFIED_MAX_LINES } from '../../config/send-verified-limits';
import { roleAssignmentFromFlag, watchRoleFlagConflict } from '../utils/agent-roles';
import { resolveSessionIdentity, type SessionIdentity } from './whoami';
import {
  ANTIGRAVITY_GUARD_HELP,
  flushClientWarnings,
  holdClientWarnings,
  isToolPolicyDenied,
} from '../utils/tool-policy-failure';
import { installSendOrigin } from '../utils/send-origin';
import {
  assertNoteAuthor,
  assertNoteAutoYesTarget,
  assertRegisterTargetId,
  assertRoleFlagChoice,
  assertRoleToolForSend,
  autoYesDenialOf,
  autoYesReadTarget,
  autoYesRelayEndpoint,
  autoYesStateTarget,
  appliesAutoYesAfterSend,
  candidateRowTarget,
  contractTaskOutcome,
  defersAutoYes,
  handleSendFailure,
  initialPriorAutoYes,
  isArmedNow,
  isAutoYesRace,
  isConditionalSend,
  noteToWrite,
  onlyIfOffFor,
  pinsSendTarget,
  registerToolOr,
  relayEndpointsReplyTo,
  relayTargetOf,
  reportSendNotes,
  rethrowAutoYes,
  roleRegistrationTarget,
  shouldArmAutoYes,
  shouldRegisterRelayAfter,
  shouldRegisterRelayBefore,
  stopsForUnknownAutoYes,
  withBoundTask,
} from './send-action-support';
import {
  assertNewConversationApplies,
  buildSendBody,
  expectedRoleOf,
  validateSendArgs,
  validateSendModel,
} from './send-validation';
import {
  enableAutoYes,
  enableAutoYesAfterSend,
  readAutoYes,
  stopAutoYesCommand,
  withdrawArmedAutoYes,
} from './send-auto-yes';
import {
  assertCandidateRowFits,
  registerInstance,
  registerInstanceWithRole,
} from './send-roster';
import { createContractTaskWithRole, pinCommandTarget } from './send-contract';
import {
  closeSendNote,
  promptWaitingFallback,
  reportTaskStatus,
  writeSendNote,
} from './send-messages';
export { MODEL_REFUSED_CODE, reportModelRefusal } from './send-model-refusal';

export function createSendCommand(): Command {
  const cmd = new Command('send');
  const bothRoleFlags = watchRoleFlagConflict(cmd);
  cmd
    .description('Send a message to a worktree agent')
    .argument('<worktree-id>', 'Worktree ID')
    .argument('[message]', 'Message to send (omit when using --contract)')
    .option('--instance <id>', `${INSTANCE_OPTION_DESCRIPTION} ${INSTANCE_ALIAS_HELP_SUFFIX}`)
    .option('--agent <agent>', AGENT_OPTION_DESCRIPTION)
    .option('--register', 'Register the --instance session into the agent-instance roster (needs --agent unless the instance id is itself a CLI tool id)')
    .option('--role <role>', 'Role ID or name this instance must hold: saved for it, and a condition of this send (see below)')
    .option('--no-role', 'Like --role, for explicitly no role')
    .option('--expect-role-generation <generation>', 'Only send to this process, as read from `capture --json` roleLaunch.sessionGeneration')
    .option('--expect-role-fingerprint <fingerprint>', 'Only send to a process started with this injection fingerprint (roleLaunch.injectionFingerprint)')
    .option('--expect-no-role', 'Only send to a process started with no role')
    .option('--new-conversation', 'OpenCode V1, session stopped: start a new conversation instead of continuing the remembered one (see below)')
    .option(
      '--model <model>',
      'Specify AI model for a Copilot, Antigravity or Claude agent. For Antigravity and Claude it is a launch'
        + ' flag: it applies only when this send starts the session, and a running session answers 400'
        + ' (the server\'s reason is printed). Claude takes an alias such as opus or sonnet, or a full model id'
        + ' such as claude-opus-4-1'
    )
    .option('--auto-yes', 'Enable auto-yes before sending (session-wide, no policy guard; for unattended runs prefer --contract with an autoYes policy)')
    .option('--auto-yes-answer-mode <mode>', `With --auto-yes: ${ANSWER_MODE_OPTION_DESCRIPTION}`)
    .option('--duration <duration>', `Auto-yes duration (${AUTO_YES_DURATION_FLAG_RANGE}, e.g. 1h, 3h, 8h; default ${DEFAULT_DURATION_FLAG})`)
    .option('--stop-pattern <pattern>', 'Auto-yes stop pattern (regex). Matched against terminal output; cannot block commands (use the task contract\'s autoYes.denyPatterns for that)')
    .option('--contract <path>', 'Execution contract path relative to the worktree root (e.g. .commandmate/tasks/my-task.yaml). Records a task and sends the contract preamble plus its goal.')
    .option('--no-brief', 'This send carries no session brief; the boundary keeps it for the next send (Issue #4274)')
    .option('--with-brief', 'This send carries the session brief even when no boundary was detected (Issue #4274)')
    .option('--ignore-structured-prompt', 'Send even if only the agent\'s hooks report an open dialog (Issue #1737). Use when the pane looks idle but sends are refused; a prompt visible in the terminal is still refused.')
    .option('--reply-to <target>', REPLY_TO_OPTION_DESCRIPTION)
    .option('--allow-relay-chain', ALLOW_RELAY_CHAIN_DESCRIPTION)
    .option('--note <text>', 'With --reply-to: what you wait for, kept in mem as a waiting item closed by the relay (Issue #4226)')
    .option('--token <token>', TOKEN_WARNING)
    .addHelpText('after', `
--reply-to registers a relay: when the target session finishes this turn,
CommandMate puts its answer into the named session's composer, prefixed with
\`[from <alias> / <worktree>]\`. Nothing blocks — there is no wait to run and
no pane to scrape. Watch it with \`commandmate relays\`, withdraw it with
\`commandmate relays cancel <id>\`; it expires after 24h either way.

--note "<text>" (Issue #4226) keeps the purpose of the reply in mem: a waiting item of
your own session (whoami), closed when the relay ends. Only the note and the relay id
are stored. It needs --reply-to and a session identity (exit 2 otherwise). When mem
refuses it (mode not on: 50, a check: 2, too many open items: 56, ...) nothing is sent:
the contract's task is failed, a grant this send armed is withdrawn and the relay is
withdrawn, and send exits with mem's code. With --auto-yes, a state of Auto-Yes that
cannot be read first stops the send before the grant (exit 99), and one with no
--instance to read it for is refused before anything is done (exit 2).

Exit 2 when the relay is refused: you are answering a relayed message already
(pass --allow-relay-chain), the chain would exceed 3 hops, or an open relay
between these two sessions exists. A relay with antigravity at either end that
the tool policy refuses is exit 33 (below), not 2. Nothing is sent in either case.

${ANTIGRAVITY_GUARD_HELP}

Message length (Issue #2464): up to ${SEND_VERIFIED_MAX_KIB} KiB and ${SEND_VERIFIED_MAX_LINES} lines is verified
to arrive whole on claude, codex, command-code and antigravity. A message over
512 bytes is pasted into the agent's composer as one bracketed paste, and Enter
waits until the composer shows all of it. If it never does, nothing is
submitted and send exits 99 with "Message body did not arrive intact" -- it
does not print "Message sent.". For a longer brief, write it to a file in the
worktree and send a short message that tells the agent to read that file.

Session brief (Issue #4274): the first send after a conversation boundary -- a new
launch, a reset (/clear, codex /new), a resume to another conversation, a restart -- of
claude, codex or command-code carries the session brief once, in front of the message,
when mem is on (or derived) for the branch and injectOnStart is enabled. A reconnect is
not a boundary. --no-brief skips it for this send only (the next send gets it);
--with-brief attaches it to this send. Giving both is exit 2 with nothing sent. The
brief is left off, never the message, when the two together would pass the verified
length above.

--role / --no-role (Issue #4116): a role is fixed when the process starts, so this is
a condition, not a switch. The setting is saved for the instance first. A session that
is not running starts with it; a running one gets the message only if it was started
with exactly what that setting injects. A different role, or a process whose start
this server has no record of (after a server restart), is exit 32 with nothing typed,
and the setting stays saved: stop the session (\`instances <wt> kill <id>\`) and send
again, with no --role needed. A role names an instance on the roster: an ad-hoc id
needs --register as well.

--register --role creates the instance and its role together BEFORE sending, so the
first start has it. Repeating that command creates nothing: --role replaces what the
instance holds and is a condition as above. A changed roster is exit 31, nothing sent.
--register without a role keeps its old order (sent, then registered) and never
touches a role already there. The message has gone out by then, so a roster that kept
changing, or any other failure to register, is a warning and exit 0 (Issues #4149, #4159):
do not send it again; the warning has the command that registers it. The roster's own
rules decide (Issue #4458): up to 10 instances, so a removed row makes room again. The
row to add is judged whatever the rows already there look like; a bad existing row is
left to the server's answer to the save. An --instance already on the roster registers
nothing and is sent as without --register. When more than one reason applies, the first
of these decides:
  1. the --instance is not an id the roster accepts: exit 2, nothing written or sent
  2. the row to add would be refused (a default alias over 50 characters, ...): exit 2,
     nothing written or sent; the error gives an instances add command with a short
     --alias. With --role, the limit is judged here too (exit 2)
  3. the tool policy refuses the send (or what it writes first): exit 33, nothing typed
  4. a plain --register on a full roster: sent, then a warning and exit 0

--expect-* pin this send to what the caller read earlier, saving nothing; the server
reads them again right before the first key, so a process replaced in between gets
nothing (exit 32). \`launch-worker\` passes what its starting message fixed. With
--contract too, the contract is recorded as a failed task.

--auto-yes applied after the message (--model on a tool that arms after it, or a grant
already on) cannot take the send back: if it fails, that is a warning and exit 0, so do not
send it again; the warning has the command that enables it (Issue #4159). Armed before the
message, a failure is an error with nothing sent.

With a role or a pin, --auto-yes, --contract or --reply-to names the default target it
read in every request, so a default changed meanwhile does not split them. --auto-yes does not outlive a refusal: a grant this send armed is
withdrawn when nothing was typed, and a grant already on is left as it was until the
message is in. Only the grant it armed: one updated since is left on, with the command
that stops it. --auto-yes --reply-to with --instance is held to the same, with its relay
refused or the send refused (Issue #4144); naming no target, there is nothing to read
first, so a grant it armed stays on, with the command that stops it. --auto-yes with no role, pin or
--reply-to reads nothing first, by decision (Issue #4159): it cannot tell a grant it armed from
one already on, so a refused send leaves it on, with the command that stops it. Reading first
would add a request to every such send, and would move the new terms of a grant already on to
after the message. A server too old to name its grants is not asked to withdraw one either:
it stays on, with the same command. --contract --role saves the role before the contract's own check if that
check would refuse it, so it behaves like send --role; a broken contract saves nothing.
A refusal that comes after the save says the setting stayed saved, whatever refused it.
A save of its own (--contract --role, --register --role) answered by a 5xx or not at all
may have happened: it says that is not known, and how to check. A 4xx to that request saved
nothing. A plain send --role saves inside the send, and its own 400 or 409 can come after the
save: it then says the setting stayed saved.
What can be checked first (--model on a running session, the image path) saves nothing.

--new-conversation (Issue #4133): OpenCode V1 goes on with the conversation it remembers,
even under another role, and stopping the session does not forget it. This starts a new one,
and is for the send that starts the session: another tool, or a session running or starting
when this checks, is exit 2 with nothing sent. A start between that check and the send is
not caught.

Exit codes: 2 usage, or an unknown or ambiguous role, or a tool roles do not apply to
(nothing sent); 31 a roster conflict (nothing sent); 32 the role condition does not
hold or the start was refused because of its role (nothing typed); 33 refused by the
tool policy (antigravity, above; nothing typed, do not send it again); 34 the target
(the instance's tool, the worktree, OpenCode's dispatch target) changed or could not be
confirmed while sending and the message was not delivered (sendOutcome=not_sent): read
the roster again, then send it again. Stopped that way after part of it may have gone in
(sendOutcome=unknown) is 99: check the pane before resending.

Whether a failed send went in (Issue #4535) is read from its own answer only: not sent
on a typed sendOutcome=not_sent, a code the server answers before sending, or a refused
connection. Anything else (a proxy's page, a 4xx with no code, a lost answer) is unknown:
the relay, the --note item and the Auto-Yes grant stay, nothing is resent, and stderr
says to check the pane first. A 2xx that is not a message (empty, not JSON, another
shape) is exit 99 for the same reason. With a bound relay (--reply-to), an unknown is
looked up in the relay's own record: "sent" is exit 0, "failed" undoes them and says it
is safe to send again. A 409 RELAY_BIND_CONFLICT is a copy of this request holding the
relay: the relay is looked up, and only its "failed" undoes them.
`)
    .action(async (worktreeId: string, message: string | undefined, options: SendOptions) => {
      try {
        // Issue #4437: this command's requests say who is sending (`send-origin.ts`), and
        // the client's warnings wait until a tool-policy refusal could have been said (I7d).
        installSendOrigin();
        holdClientWarnings();
        const autoYesDurationMs = validateSendArgs(worktreeId, message, options);
        assertRoleFlagChoice(bothRoleFlags);
        const expectedRole = expectedRoleOf(options);

        const client = new ApiClient({ token: options.token });

        // Issue #1629: --instance names an agent instance, not a CLI tool, and
        // the roster is the only place that pairs the two. Resolve it once, up
        // front, so the task row, the send and auto-yes all name the same tool
        // as the session that actually starts.
        const namedTarget = await resolveCommandTarget(client, worktreeId, options.instance, options.agent);
        // Issue #2376: the RESOLVED id, never the string the user typed.
        // `--instance "Codex 2"` has to reach /send as `codex-2`; no route but
        // /resolve-target knows how to read an alias.

        assertRegisterTargetId(options.register, namedTarget.instanceId);
        const candidateRow = candidateRowTarget(options.register, namedTarget.instanceId);
        if (candidateRow !== null) {
          await assertCandidateRowFits(
            client, worktreeId, candidateRow.instanceId, registerToolOr(options.agent, candidateRow.instanceId)
          );
        }

        // Issue #4438: the usage notice, once per CLI environment, on stderr (after a refusal's lines).
        noteAntigravityNotice(namedTarget.agent);

        validateSendModel(options, namedTarget.agent);

        // Issue #4226: the note's author is this session; without one there is nobody to keep it for.
        let noteAuthor: SessionIdentity | null = null;
        if (options.note !== undefined) {
          noteAuthor = await resolveSessionIdentity(client).catch(() => null);
          assertNoteAuthor(noteAuthor);
        }

        // Issue #4116: fixed here, before any side effect, so a default that cannot be
        // read stops the command with nothing done. A send with no role or pin, or that
        // is one request, is left to the server's reading as it always was.
        const conditional = isConditionalSend(options, expectedRole);
        // Issue #4133: --new-conversation too, so the send goes where its check looked.
        const pinsTarget = pinsSendTarget(options, conditional);
        const commandTarget = pinsTarget ? await pinCommandTarget(client, worktreeId, namedTarget) : namedTarget;
        const { agent, instanceId } = commandTarget;
        // --auto-yes: enable auto-yes first (unless --model is specified, then after send) [DR2-02]
        const deferAutoYes = defersAutoYes(options, agent);
        assertNoteAutoYesTarget(options, deferAutoYes, agent, instanceId);
        if (options.newConversation) await assertNewConversationApplies(client, worktreeId, agent, instanceId);

        assertRoleToolForSend(options, agent);
        const roleAssignment = await roleAssignmentFromFlag(client, options.role);

        // Issue #4133: a --reply-to that cannot be resolved exits 2 on the spot, from
        // several depths. With a contract that has to be before the task row exists, and
        // with --auto-yes before the grant (Issue #4144). Only opening the relay can still
        // be refused after them: that closes the task and withdraws the grant.
        const relayTarget = relayTargetOf(worktreeId, pinsTarget, commandTarget, options);
        // Issue #4437 (I7c) / #4449: what this send writes before its message (the roster
        // and role of --register --role, the task of --contract, the grant of --auto-yes)
        // is refused by the tool policy AT that write, in the same request, with nothing
        // written: each carries who sends and the relay's other end (`writePolicyFields`).
        // No ask before them (`GET …/tool-policy`): an ask that failed let the writes go on,
        // and a default changed after it was written under another tool's verdict.
        const roleRegistration = roleRegistrationTarget(roleAssignment, options, instanceId);
        const registersWithRole = roleRegistration !== null;
        let relayEndpoints: RelayEndpoints | undefined;
        const endpointsReplyTo = relayEndpointsReplyTo(options, registersWithRole);
        if (endpointsReplyTo !== null) {
          relayEndpoints = await resolveRelayEndpoints(client, { ...relayTarget, replyTo: endpointsReplyTo });
        }

        if (roleRegistration !== null) {
          await registerInstanceWithRole(
            client, worktreeId, roleRegistration.instanceId,
            registerToolOr(options.agent, roleRegistration.instanceId), roleRegistration.role,
            relayEndpoints?.from, options.autoYes
          );
        }

        // Issue #1545: resolve the contract before anything with a side effect,
        // so an invalid contract cannot leave auto-yes enabled for a message
        // that was never sent.
        let taskId: string | undefined;
        // Issue #4449: set when the message and the grant go by the task's target.
        let boundTaskId: string | undefined;
        // Issue #3723: what the created contract lets Auto-Yes answer.
        let contractPolicy: AutoYesContractPolicy | null = null;
        let content = message;
        if (options.contract) {
          const task = await createContractTaskWithRole(client, worktreeId, options, agent, instanceId, roleAssignment, relayEndpoints?.from);
          const outcome = contractTaskOutcome(task, agent, instanceId);
          taskId = outcome.taskId;
          content = outcome.content;
          contractPolicy = outcome.contractPolicy;
          boundTaskId = outcome.boundTaskId;
          console.error(`Task created: ${taskId}`);
          console.log(taskId);
        }

        // A task whose message never arrived is a failed task, not a pending
        // one: nothing is working on it and nothing ever will. Every step
        // between the task row and the delivered message reports through this.
        const failTask = async (): Promise<void> => {
          if (taskId) {
            await reportTaskStatus(client, taskId, 'failed');
          }
        };

        const registerRelay = async (onFailure: () => Promise<void>): Promise<RegisteredRelay> => {
          const registered = await registerRelayForMessage(client, {
            ...relayTarget,
            replyTo: options.replyTo as string,
            allowRelayChain: options.allowRelayChain,
            endpoints: relayEndpoints,
            onFailure,
          });
          // stderr, not stdout: `--contract` already owns this command's stdout
          // (it prints the task id there), and two commands writing two ids to
          // one stream is how a `$(…)` capture ends up with both. `ask --async`
          // is the form that hands the relay id back on stdout.
          console.error(`Relay registered: ${registered.id}`);
          return registered;
        };

        // Issue #4116: a send with a role can be refused after Auto-Yes went on, and a
        // grant left behind answers a process this send never reached. So it looks
        // first. Already on: that grant goes on answering, untouched, and this send's
        // terms replace it only once the message is in. Off: armed now, and withdrawn
        // on a refusal. Its relay goes first too, because a refused relay exits on the
        // spot. A send saying nothing about a role reads nothing and is as it was, unless
        // it has a relay to open after arming, which can be refused too (Issue #4144). It
        // pins no target, so with none named there is nothing to read: the state stays
        // unknown, and so does the grant's fate on a refusal.
        let relay: RegisteredRelay | undefined;
        if (shouldRegisterRelayBefore(options, conditional)) relay = await registerRelay(failTask);
        const armsNow = isArmedNow(options, deferAutoYes);
        const autoYesTarget = autoYesReadTarget(armsNow, conditional, options, agent, instanceId);
        const stateTarget = autoYesStateTarget(autoYesTarget);
        const priorState = stateTarget ? await readAutoYes(client, worktreeId, stateTarget) : null;
        let priorAutoYes = initialPriorAutoYes(autoYesTarget, priorState);
        const onlyIfOff = onlyIfOffFor(conditional, autoYesTarget, priorAutoYes);
        let armedGrant: AutoYesSetResult | undefined;
        if (stopsForUnknownAutoYes(options, armsNow, priorAutoYes)) {
          await failTask();
          if (relay) await cancelRelayQuietly(client, relay.id);
          console.error(
            'Error: the current Auto-Yes state could not be read, so this --note send was stopped before arming it. '
              + 'Nothing was sent. Send it again later, or without --note.'
          );
          process.exit(ExitCode.UNEXPECTED_ERROR);
        }
        if (shouldArmAutoYes(armsNow, priorAutoYes)) {
          // Issue #3290: the server can refuse this — 409 when the session by
          // that name belongs to another CommandMate server — and the command
          // then stops here, after --contract created the task row and before
          // anything is sent. That is the outcome a failed send has, so it gets
          // the same record; left alone the row stayed `pending` for a message
          // that never went out, which is the state #1608 removed for a bad
          // --duration.
          try {
            armedGrant = await enableAutoYes(
              client, worktreeId, options, autoYesDurationMs, agent, instanceId, contractPolicy, onlyIfOff,
              // Issue #4449: the relay not opened yet is judged with the grant, before it is written.
              autoYesRelayEndpoint(relay, relayEndpoints),
              boundTaskId
            );
          } catch (error) {
            if (isAutoYesRace(error, onlyIfOff)) {
              await failTask();
              if (relay) await cancelRelayQuietly(client, relay.id);
              rethrowAutoYes(error, autoYesDenialOf(error, agent, instanceId));
            }
            priorAutoYes = true;
          }
        }
        const applyAutoYesAfterSend = appliesAutoYesAfterSend(options, deferAutoYes, priorAutoYes);

        /** Issue #4116, #4144: what a send that read the state armed, once it failed. */
        const withdrawAutoYes = async (notSent: boolean): Promise<void> => {
          const stop = stopAutoYesCommand(worktreeId, armedGrant?.instanceId ?? instanceId, armedGrant?.cliToolId ?? agent);
          // Issue #4159: read nothing first, so it may be a grant that was on before (see --help).
          if (autoYesTarget === null) {
            if (armsNow) console.error(`Warning: Auto-Yes stays on (this send did not read it first, so it may have been on already). To turn it off: ${stop}`);
            return;
          }
          if (priorAutoYes === true) return;
          if (priorAutoYes === null || !notSent) {
            const why = priorAutoYes === null ? 'it was not known to be off' : 'the message may have gone in';
            console.error(`Warning: Auto-Yes stays on (${why}). To turn it off: ${stop}`);
            return;
          }
          await withdrawArmedAutoYes(client, worktreeId, autoYesTarget, armedGrant);
        };

        // Issue #2377: the relay is registered BEFORE the message goes out, so a
        // session that answers immediately cannot finish its turn in the window
        // between the send and the ledger row — the completion trigger reads the
        // ledger, and a row that does not exist yet is a reply nobody collects.
        // A refusal exits 2 here, having sent nothing. Any failure here is before the
        // message, so the grant armed above has nothing to answer (Issue #4144).
        if (shouldRegisterRelayAfter(options, conditional)) {
          relay = await registerRelay(async () => {
            await failTask();
            await withdrawAutoYes(true);
          });
        }

        // Issue #4226: the note goes in right before the message, after every other side
        // effect, so a refusal undoes all of them and sends nothing.
        let noteItemId: string | undefined;
        const noteRelay = relay;
        const note = noteToWrite(options, noteAuthor, noteRelay);
        if (note !== null) {
          noteItemId = await writeSendNote(client, note.author, note.relay.id, note.note, async () => {
            await failTask();
            await withdrawAutoYes(true);
            await cancelRelayQuietly(client, note.relay.id);
          });
        }

        const sendBody = withBoundTask(buildSendBody(content, agent, instanceId, options, {
          assignment: roleAssignment,
          expected: expectedRole,
        }), boundTaskId);

        // Issue #3957: a bound relay's id rides on the send, which reserves it
        // and records where the body went in.
        const sent = await postMessage(client, worktreeId, sendBody, {
          relay,
          onFailure: async (error, reading) => {
            await failTask();
            // Issue #4535: undone only when nothing went in and the relay is this send's.
            const undo = undoesFailedSend(reading);
            await withdrawAutoYes(undo);
            // Issue #4226: not sent for certain, so nothing is waited on. Unknown: the relay closes it.
            if (noteItemId && noteAuthor && undo) await closeSendNote(client, noteAuthor, noteItemId);
            // Issue #4437: refused before the role was saved or anything typed, and a bound
            // relay was withdrawn by the server. Out now, so the refusal's reason is the
            // first error line and no "safe to send it again" follows it.
            if (isToolPolicyDenied(error)) throw error;
            // Issue #4116: no answer, so the send may have got as far as the save.
            // A 5xx with a body that says nothing of the setting is no better an answer.
            const saidNothing = error instanceof ApiError
              && (!error.payload || ((error.statusCode ?? 500) >= 500 && error.payload.roleSettings === undefined));
            if (roleAssignment !== undefined && saidNothing) {
              console.error(`Note: whether the role setting was saved is not known. Check it with: commandmate instances ${worktreeId}`);
            }
          },
          promptWaitingFallback: promptWaitingFallback(worktreeId, commandTarget),
          target: commandTarget,
        });
        flushClientWarnings();
        console.error('Message sent.');
        reportSendNotes(sent, worktreeId, agent, instanceId);

        if (taskId) {
          await reportTaskStatus(client, taskId, 'running');
        }

        // Issue #1000: register the ad-hoc instance into the roster after the
        // session has started, so a follow-up `commandmate instances` lists it.
        // Issue #4116: with a role it was registered before the send.
        if (options.register && instanceId && roleAssignment === undefined) {
          await registerInstance(client, worktreeId, instanceId, registerToolOr(options.agent, instanceId));
        }

        // Issue #576: Enable auto-yes AFTER send when --model is specified
        // This avoids auto-yes interfering with the /model command interaction.
        // A failure here does not fail the task: the message was delivered and
        // the task is running, which is what the row already says. Nor the command (Issue #4159).
        if (applyAutoYesAfterSend) {
          await enableAutoYesAfterSend(client, worktreeId, options, autoYesDurationMs, agent, instanceId, contractPolicy, boundTaskId);
        }
      } catch (error) {
        handleSendFailure(error, options, worktreeId);
      }
    });
  return cmd;
}
