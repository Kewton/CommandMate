[日本語版](../../user-guide/team-roles.md)

# Team Roles: PM, Development Lead, Worker

Templates for the role sections you put in a repository's instructions file (`CLAUDE.md`, `AGENTS.md` and so on), so that every session knows which part it plays. They do not depend on a particular agent CLI. [Stage 6 of the setup guide](https://github.com/Kewton/CommandMate/blob/main/website/setup.md) uses them; read it with `commandmate docs --section setup`.

Replace the `<...>` placeholders. Instance ids come from `commandmate instances <worktree-id>`.

## How the three roles fit

The person talks to the PM only. The PM asks the development lead. The development lead hands tasks to workers under contracts, and the checks (`commandmate wait <worktree-id> --instance <worker> --verify`) decide when a task is done.

| Role | Talks to | Does | Never does |
|------|----------|------|------------|
| PM | The person, the development lead | Turns the person's request into a brief, follows progress, reports | Writes code, sends to workers directly |
| Development lead | The PM, the workers | Splits the brief into tasks, hands each over under a contract, waits for the gates | Asks the person directly |
| Worker | The development lead | Does one task inside the contract's scope and commits | Changes files outside the scope, merges |

## Telling each session its role

Put one section per role in the instructions file, and ask each session to run `commandmate whoami` at the start and compare the instance id with the sections. A session that does not find itself in the file says so and stops, instead of guessing.

## PM section (template)

```markdown
## Role: PM (instance `<pm-instance>`)

- You talk to the person. You do not write code and you do not edit files in the repository.
- Hand work to the development lead (`<lead-instance>`) with `commandmate ask <worktree-id> "<brief>" --instance <lead-instance>`. Never send to a worker directly.
- A brief has four parts: the goal, the issue or files, what must not change, and what "done" means (the verify gates).
- Report to the person in the form below. Approvals and decisions are theirs.
- Merging is the person's. (Only if the person chose to delegate it: merge when the head is the commit the checks verified, every gate passed, CI is green and the review has no blocker; otherwise hand it back. Changes that loosen a gate or a judgement always go to the person.)
```

## Development lead section (template)

```markdown
## Role: development lead (instance `<lead-instance>`)

- You take briefs from the PM (`<pm-instance>`). You never ask the person directly: a question or approval you need goes back to the PM.
- Hand each task to a worker with `commandmate send <worktree-id> --contract .commandmate/tasks/<name>.yaml --instance <worker-instance>`, then `commandmate wait <worktree-id> --instance <worker-instance> --verify`.
- Report the exit code of `wait --verify` (0 passed, 20 a gate failed, 21 nothing to judge) and the end of the failing log. Do not weaken a gate to pass it.
```

## Worker section (template)

```markdown
## Role: worker

- Do the one task in your contract, only inside its scope. Commit when it is done.
- If the task needs a file outside the scope, do not change it. Write what you found in the commit message and stop.
- Do not start servers or background processes the contract does not ask for.
```

## The PM's report

The first line says whether the person has to do anything, in one sentence they can act on without reading further:

- "Nothing needs your attention now."
- "2 decisions are waiting for you."

Then say what happened, and give every decision as a short list of options to choose from, with the one you recommend first:

```text
2 decisions are waiting for you.

Done: issue #12 passed all gates (lint, unit); the pull request is open and CI is green.

1. Merge pull request #34?  (a) merge  (b) wait for review
2. Issue #13 needs a new dependency.  (a) allow it  (b) find another way
```

## Time-boxed runs

When the person wants the PM to keep working while they are away, they give it an absolute end time with its time zone, the actions it may take, and what to report when it stops ("Work until 09:30 JST. You may run the checks and open pull requests, and nothing else. If you stop, report what is done and what is left."). Auto Yes follows the same deadline:

```bash
commandmate auto-yes <worktree-id> --enable --duration 3h --instance <pm-instance> --stop-pattern 'DONE:|BLOCKED:'
```

`--duration` is whole hours (1h to 24h); choose one that ends by the deadline. `--stop-pattern` is a regular expression matched against terminal output. It ends Auto Yes early and cannot forbid a command, so it is not a permission boundary.

## Approval stays with the person

The agent that sets this up never approves or merges for the person. The default is that the person merges. A conditional delegation is not a switch in the product: it exists only when the person chooses it and has it written into the PM's instructions as above.

## Related

- [Skills](./skills.md)
- [CLI Operations Guide](./cli-operations-guide.md)
- [commandmate-team-demo](https://github.com/Kewton/commandmate-team-demo): a recorded team run
