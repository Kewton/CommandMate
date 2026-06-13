[日本語版](../../features/sidebar-status-indicator.md)

# Sidebar Status Indicator

> Real-time status detection feature implemented in Issue #31 "Sidebar UX Improvement"

## Overview

A feature that displays Claude CLI status in real-time for each branch in the sidebar.
It directly parses terminal output to accurately detect Claude's state (waiting for input, processing, waiting for response).

## Status List

| Status | Display | Color | Description |
|--------|---------|-------|-------------|
| `idle` | ● | Gray | Session not started |
| `ready` | ● | Green | Input prompt displayed (ready for new message) |
| `running` | ⟳ | Blue spinner | Claude processing (thinking indicator displayed) |
| `waiting` | ● | Yellow | Waiting for user input (yes/no, choices, etc.) |
| `generating` | ⟳ | Blue spinner | Generating response |

## Aggregated status icon to the left of the branch (Issue #867)

Each branch in the sidebar shows the status of all selected agents **aggregated into a single icon** to the left of the branch name (previously it rendered up to five separate dots).

### Aggregation logic

`aggregateCliStatus(cliStatus)` (`src/types/sidebar.ts`) picks the single most significant status across all agents. The priority order (distinct from the sort-only `STATUS_PRIORITY`) is:

```
waiting > running / generating > ready > idle
```

- If any agent is `waiting`, the icon is `waiting` (yellow dot).
- Otherwise, if any agent is `running` or `generating`, the icon is a spinner (`running` wins).
- Otherwise, if any agent is `ready`, the icon is `ready` (green dot).
- Otherwise, `idle` (gray dot).

### Per-agent breakdown

Aggregation does not lose per-agent detail. The icon's `title` / `aria-label` is set from
`formatCliStatusBreakdown(cliStatus)` (e.g. `Claude: running, Codex: idle`), so the breakdown is
revealed on hover/focus.

> Sorting (`STATUS_PRIORITY`, `waiting` first) operates on the per-branch `status`, so this
> aggregated icon does not change existing sort behavior.

## Detection Logic

### Thinking Indicator Detection

When Claude is processing, the following patterns appear in the terminal:

```
✻ Philosophising… (ctrl+c to interrupt · thinking)
· Contemplating… (ctrl+c to interrupt)
✽ Wibbling… (ctrl+c to interrupt · thought for 1s)
```

Detection pattern (regex):
```typescript
const CLAUDE_SPINNER_CHARS = [
  '✻', '✽', '⏺', '·', '∴', '✢', '✳', '✶',
  '⦿', '◉', '●', '○', '◌', '◎', '⊙', '⊚',
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',
];

const CLAUDE_THINKING_PATTERN = new RegExp(
  `[${CLAUDE_SPINNER_CHARS.join('')}]\\s+.+…|to interrupt\\)`,
  'm'
);
```

### Input Prompt Detection

When Claude is ready to accept a new message:

```
❯
```

Or when a recommended command is preset:

```
❯ /work-plan
```

Detection pattern:
```typescript
// Issue #132: Matches both empty prompt lines and prompt lines with recommended commands
const CLAUDE_PROMPT_PATTERN = /^[>❯](\s*$|\s+\S)/m;
```

This pattern matches the following cases:
- Empty prompt: `❯ ` or `> `
- Prompt with recommended command: `❯ /work-plan` or `> npm install`

### Interactive Prompt Detection

When displaying yes/no confirmations or choices:

```
? Do you want to proceed? (y/N)
? Select an option:
  1. Option A
  2. Option B
```

## Detection Priority

1. **Interactive prompt** → `waiting` (yellow)
2. **Thinking indicator** → `running` (spinner)
3. **Input prompt only** → `ready` (green)
4. **Otherwise** → `running` (spinner) - assumed to be processing

## Polling Intervals

| Target | Interval |
|--------|----------|
| Sidebar status update | 2 seconds |
| Worktree detail (active) | 2 seconds |
| Worktree detail (idle) | 5 seconds |

## Implementation Files

### Configuration
- `src/config/status-colors.ts` - Centralized status color management

### Detection Logic
- `src/lib/cli-patterns.ts` - CLI tool-specific pattern definitions
- `src/lib/prompt-detector.ts` - Prompt detection logic

### API
- `src/app/api/worktrees/route.ts` - Worktree list status retrieval
- `src/app/api/worktrees/[id]/route.ts` - Individual worktree status retrieval
- `src/app/api/worktrees/[id]/current-output/route.ts` - Real-time output retrieval

### Frontend
- `src/components/sidebar/BranchStatusIndicator.tsx` - Status indicator component
- `src/types/sidebar.ts` - Status determination logic
- `src/contexts/WorktreeSelectionContext.tsx` - Polling management

## CLI Tool Support

| CLI Tool | Thinking Pattern | Prompt Pattern |
|----------|-----------------|----------------|
| Claude | `✻ Thinking…` | `❯` |

## Notes

- Empty lines are filtered before pattern matching
- The last 15 lines of terminal output (excluding empty lines) are inspected
- ANSI escape codes are stripped before detection
