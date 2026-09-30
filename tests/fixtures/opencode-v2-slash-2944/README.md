# OpenCode V2 slash-command fixtures (Issue #2944)

Captured on 2026-09-28 from the real `opencode2` **2.0.18**: a private
`opencode2 serve --hostname 127.0.0.1` with its own password and an isolated
`HOME`, in a throw-away git repository with one probe Skill planted per
candidate root and two probe markdown commands (`.opencode/commands/probe-cmd.md`,
`.opencode/command/probe-cmd2.md`). The temp directory is rewritten to
`/tmp/cm2944`; nothing else is edited except that each Skill's `content` is cut
to 160 characters (the builtin ones are ~12 KB).

| File | What |
|---|---|
| `command-2.0.18.json` | `GET /api/command` once the server had scanned the project: `init`, `review` and both probe commands |
| `command-cold-2.0.18.json` | The same request made right after `server listening`: `data: []`. The scan is lazy, so an empty list means "not loaded yet", not "no commands" |
| `skill-2.0.18.json` | `GET /api/skill`: the two builtins (`opencode`, `report`, `path: /builtin/…`) and every probe the server discovered |

Skill roots discovered (the probes present in `skill-2.0.18.json`):
project `.opencode/skills`, `.opencode/skill`, `.claude/skills`, `.agents/skills`;
home `.claude/skills`, `.agents/skills`, `.config/opencode/skills`,
`.config/opencode/skill`. A probe planted in `$HOME/.opencode/skills` was **not**
discovered.
