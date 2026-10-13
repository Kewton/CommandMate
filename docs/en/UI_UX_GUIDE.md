[日本語版](../UI_UX_GUIDE.md)

# CommandMate UI/UX Guide

This document describes CommandMate's current UI/UX implementation.

## Table of Contents

1. [Overview](#overview)
2. [Responsive Design](#responsive-design)
3. [Desktop UI](#desktop-ui)
4. [Mobile UI](#mobile-ui)
5. [Common Features](#common-features)
6. [Component Structure](#component-structure)

---

## Overview

CommandMate provides a responsive UI optimized for both desktop and mobile.

| Screen | Layout | Features |
|--------|--------|----------|
| **Desktop** | One-row header + second-row action bar + body (TerminalContainer; the ActivityPane opens from the right, over it) | Tools at the right of the header, Verification chip on the second row, instant Tooltip, History embedded in the Terminal area, a pane that sits beside the body when pinned |
| **Mobile** | Tab-based | Bottom navigation |

---

## Responsive Design

### Auto Detection

The `useIsMobile` hook automatically switches layouts based on screen size.

- **Desktop**: 768px and above
- **Mobile**: Below 768px

```
┌─────────────────────────────────────────┐
│  768px+ → Desktop Layout               │
│  <768px → Mobile Layout                │
└─────────────────────────────────────────┘
```

---

## Desktop UI

### Layout Structure (Issue #727 / #730)

> Issues #3589–#3594 gave the screen its current shape. The full-height vertical Activity Bar (48px) is gone from PC (the phone keeps its bottom tab bar).

The header is one row, with the worktree's tools at its right. The second row is the splits' action bar. The panel (ActivityPane) is closed by default; opened, it comes in from the right, laid over the body (pin it and it sits beside the body instead, narrowing it).

```
┌────────────────────────────────────────────────────────────────────┐
│ ● worktree-name  repo  [current session][N more ▾][+] [Info] [tools…] │ ← Header (one row)
├────────────────────────────────────────────────────────────────────┤
│ [▢][▥][▥▥][▦]  [Verification chip]  (one split: its header) [⤢] [History][Open Files] │ ← Second row (action bar)
├────────────────────────────────────────────────────────────────────┤
│ BranchMismatchAlert (conditional)                                    │
├──────────────┬───────────────────────────────┬──────────────────────┤
│ History      │ Terminal / Chat               │ FilePanel  ┌────────┐│
│ (in a split, │                               │            │Activity││
│  collapsible)│                               │            │Pane    ││
│              ├───────────────────────────────┤            │(laid   ││
│              │ [Message Input]        [Send] │            │ over)  ││
└──────────────┴───────────────────────────────┴────────────┴────────┘
```

### Feature Details

#### 1. Header
- **Status dot and worktree name**: the repository name beside it (opens the Repositories screen); `*` when there are uncommitted changes
- **Session field**: [current session][N more ▾][+]. The worktree's progress (Status) is not set here but from the sidebar row's "…" → Status
- **Info button**: Opens the Worktree info modal
- **Tools** (right end): the icons of the activities below except `verification`. On a narrow header the trailing ones fold into a "…" list

#### 2. Tools (HeaderToolBar) and the Verification chip
- What the vertical Activity Bar held is split between the icons at the right of the header (`HeaderToolBar`) and the Verification chip on the second row (`VerificationStatusChip`) (Issue #3591)
- 10 Activities. **The single source is `ACTIVITIES` in `src/config/activity-bar-config.ts`**; the list below is a copy. Its order is the order of the header's tools and of the ←/→ keys (append new activities at the end — an insert silently renumbers the keyboard order).
  1. `files` — File Tree (Issue #2259: renamed to tell it apart from the action bar's "Open Files"; the id stays `files`)
  2. `git` — Git
  3. `notes` — Notes
  4. `schedules` — Schedules
  5. `agent` — Agent
  6. `timer` — Timer
  7. `todo` — ToDo (Issue #1015)
  8. `skills` — Skills (Issue #1441)
  9. `verification` — Verification (Issue #1816). Not among the header's tools; pressing the second-row chip opens and closes it
  10. `env` — Env (Issue #1968)
- Instant Tooltip on each icon (100ms, below)
- Keyboard: ←/→/Home/End to move, Enter/Space to open/close. On "…", Enter/Space/↓ open the list; inside it ↑/↓ move and Esc returns to "…"
- Pressing the open tool again closes the pane

#### 3. ActivityPane (renders the selected Activity)
- Displays the content of the currently selected Activity. Closed by default (a worktree opened for the first time starts closed, Issue #3589)
- Opens from the right over the body, whose width does not change. Esc, ×, re-clicking the same tool, an outside click or opening a file closes it
- Pinned, it sits beside the body (the earlier layout) and its boundary can be dragged. The pin is shared across worktrees

#### 4. TerminalContainer (Right Pane, Issue #730)
- Embeds History (left sub-panel) + Terminal + FilePanel (right)
- History is collapsible (`<` / `>` buttons)
- History width is drag-resizable (10-60%, DEFAULT 40% relative to the TerminalContainer)
- History / Terminal are each wrapped in an ErrorBoundary
- The internal id `worktree-history-pane` is applied to the HistoryPane outer wrapper div

#### 5. Resize Feature
- Drag the boundary between a pinned ActivityPane and the TerminalContainer to adjust width
- Inside the TerminalContainer, drag the boundary between History and Terminal
- Visual feedback during drag

#### 5. Info Modal
- Displays Worktree details:
  - Path
  - Branch name
  - CLI tool
  - Creation date
- **Memo editing**: Save memos per branch

#### 6. Prompt Panel
- Displays CLI tool confirmation prompts as an overlay
- Supports Yes/No selection or multiple choice
- Animated show/hide transitions

---

## Mobile UI

### Layout Structure

```
┌─────────────────────────────┐
│ [←] worktree-name    [state]│  ← Header
├─────────────────────────────┤
│                             │
│                             │
│     Content Area            │
│     (Based on selected tab) │
│                             │
│                             │
├─────────────────────────────┤
│ Terminal│History│Logs│Info   │  ← Tab Bar
└─────────────────────────────┘
```

### Tab Structure

| Tab | Icon | Content |
|-----|------|---------|
| **Terminal** | 💻 | Real-time terminal output + input field |
| **History** | 🕐 | Message history |
| **Logs** | 📄 | Markdown log file list |
| **Info** | ℹ️ | Worktree info + memo editing |

### Feature Details

#### 1. Header
- **Back button**: Return to top page
- **Worktree name**: Current branch name (truncated)
- **Status indicator**:
  - 🟢 Running
  - 🟡 Waiting (prompt pending)
  - ⚪ Idle
  - 🔴 Error

#### 2. Tab Bar
- Fixed at the bottom of the screen
- Safe Area support (iPhone notch/home bar)
- Notification badges:
  - 🟢 New output available
  - 🟡 Prompt pending

#### 3. Prompt Sheet
- Displayed as a bottom sheet when CLI prompt is detected
- Swipe down to dismiss
- Tap overlay to dismiss
- Supports Yes/No or multiple choice

#### 4. Virtual Keyboard Support
- Layout auto-adjusts when keyboard is displayed
- Input field remains visible at all times

---

## Common Features

### 1. Real-Time Polling

```
Active:   Poll every 2 seconds
Idle:     Poll every 5 seconds
```

- Periodically fetches CLI tool output
- Prompt detection (Yes/No, multiple choice)
- Thinking state detection

### 2. Prompt Detection & Response

When a CLI tool asks for confirmation:

```
┌─────────────────────────────────┐
│  Confirmation from Claude       │
│                                 │
│  Do you want to proceed?        │
│                                 │
│  [Yes]  [No]                    │
└─────────────────────────────────┘
```

- Automatically displayed in the UI
- Selected answer is sent to the CLI

### 3. Memo Feature

Save memos for each Worktree:
- Desktop: Inside the Info modal
- Mobile: Inside the Info tab

### 4. Error Boundary

Each component is wrapped with ErrorBoundary:
- Partial errors don't affect the whole app
- Fallback UI is displayed on error

---

## Component Structure

### Directory Structure

```
src/components/
├── mobile/
│   ├── MobileHeader.tsx      # Mobile header
│   ├── MobileTabBar.tsx      # Bottom tab bar
│   └── MobilePromptSheet.tsx # Bottom sheet for prompts
├── common/
│   └── Tooltip.tsx              # 100ms-delay custom Tooltip (Issue #730)
├── worktree/
│   ├── WorktreeDetailRefactored.tsx  # Main component (PC delegates to WorktreeDetailDesktop)
│   ├── WorktreeDesktopLayout.tsx     # Body + ActivityPane (laid over / beside when pinned, Issue #3589 / #3591)
│   ├── HeaderToolBar.tsx             # Tools at the right of the header (Issue #3591; the old ActivityBar.tsx is not mounted)
│   ├── VerificationStatusChip.tsx    # Second-row Verification chip (Issue #1816 / #2064 / #3590)
│   ├── ActivityPane.tsx              # Renders the selected Activity (Issue #727)
│   ├── TerminalContainer.tsx         # History + Terminal container (Issue #730)
│   ├── TerminalDisplay.tsx           # Terminal display
│   ├── HistoryPane.tsx               # History pane (delegated inside TerminalContainer, collapsible)
│   ├── PromptPanel.tsx               # Desktop prompt
│   ├── PaneResizer.tsx               # Pane resizer
│   └── MessageInput.tsx              # Message input
├── error/
│   └── ErrorBoundary.tsx     # Error boundary
└── ui/
    └── Modal.tsx             # Modal component
```

### Custom Hooks

```
src/hooks/
├── useIsMobile.ts          # Mobile detection
├── useWorktreeUIState.ts   # UI state management (useReducer)
├── usePromptAnimation.ts   # Prompt animation
├── useSwipeGesture.ts      # Swipe gesture
├── useTerminalScroll.ts    # Terminal auto-scroll
└── useVirtualKeyboard.ts   # Virtual keyboard handling
```

---

## Screen Navigation Flow

```
┌─────────────────┐
│  Top Page        │
│  (Worktree List) │
└────────┬────────┘
         │ Tap
         ▼
┌─────────────────┐
│  Worktree Detail │◄──────────────┐
│  (Chat Screen)   │               │
└────────┬────────┘               │
         │                        │
    ┌────┴────┐                   │
    ▼         ▼                   │
┌───────┐ ┌───────┐               │
│ Logs  │ │ Info  │               │
│ View  │ │ Modal │               │
└───────┘ └───────┘               │
                                  │
         [Back]───────────────────┘
```

---

## Technical Highlights

### Performance Optimization
- Component memoization with `memo`
- Recomputation prevention with `useMemo` / `useCallback`
- Conditional rendering to avoid unnecessary DOM generation

### Accessibility
- Proper ARIA attribute usage
- Keyboard navigation support
- Screen reader-compatible labels

### Error Handling
- ErrorBoundary for each pane/component
- Fallback UI provision
- Error log output

---

## Related Documents

- [README.md](../../README.md) - Project overview
- [Web App Guide](./user-guide/webapp-guide.md) - Operating guide for first-time users
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Deployment guide
- [architecture.md](./architecture.md) - Architecture details
