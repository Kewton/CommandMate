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
| **Desktop** | 3-column (ActivityBar / ActivityPane / Right (History inside TerminalContainer)) | VS Code-style full-height Activity Bar, instant Tooltip, History embedded in the Terminal area, resizable panes |
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

Adopts a VS Code-style full-height Activity Bar. History is embedded in the Terminal area and runs down to the bottom of the screen.

```
┌───┬─────────────────────────────────────────────────┐
│   │  [←Back]  worktree-name                  [Info] │ ← Header
│ A │ ├─────────────────────────────────────────────┤  │
│ c │ │ BranchMismatchAlert (conditional)             │
│ t │ ├──────────┬─────────────────┬──────────────────┤
│ B │ │          │                 │                  │
│ a │ │ Activity │ History         │ Terminal         │
│ r │ │ Pane     │ (inside TerminalContainer, left sub-panel) │ + FilePanel │
│ ┃ │ │  - Files │ │  - Git        │                 │                  │
│ ┃ │ │  - Notes │ │  - Schedules  │                 │                  │
│ ┃ │ │  - Agent │ │  - Timer      │                 │                  │
│ ┃ │ ├──────────┴─────────────────┴──────────────────┤
│ ┃ │ │  NavigationButtons (conditional, OpenCode TUI) │
│ ┃ │ ├─────────────────────────────────────────────┤  │
│ ┃ │ │  [Message Input]                       [Send] │
└───┴─────────────────────────────────────────────────┘
   ↑          ↑               ↑              ↑
ActivityBar full-height  ActivityPane  History (collapsible)  FilePanel
(48px, runs from below Header to bottom)
```

### Feature Details

#### 1. Header
- **Back button**: Return to the top page (Worktree list)
- **Worktree name**: Displays the current branch/worktree name
- **Info button**: Opens the Worktree info modal

#### 2. ActivityBar (48px, full-height)
- VS Code-style vertical Activity Bar
- 6 Activities: Files / Git / Notes / Schedules / Agent / Timer
- Runs from below the Header to the bottom of the screen (Issue #730)
- Instant Tooltip on each icon (100ms, dark theme, right placement) (Issue #730)
- Keyboard navigation: ArrowUp/Down/Home/End/Enter/Space

#### 3. ActivityPane (renders the selected Activity)
- Displays the content of the currently selected Activity
- Drag-resizable width via ResizableColumn

#### 4. TerminalContainer (Right Pane, Issue #730)
- Embeds History (left sub-panel) + Terminal + FilePanel (right)
- History is collapsible (`<` / `>` buttons)
- History width is drag-resizable (10-60%, DEFAULT 40% relative to the TerminalContainer)
- History / Terminal are each wrapped in an ErrorBoundary
- The internal id `worktree-history-pane` is applied to the HistoryPane outer wrapper div

#### 5. Resize Feature
- Drag the boundary between ActivityPane and TerminalContainer to adjust width
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
│   ├── WorktreeDetailRefactored.tsx  # Main component (ActivityBar full-height: Issue #730)
│   ├── WorktreeDesktopLayout.tsx     # Desktop 2-column (ActivityPane + Right) — simplified in Issue #730
│   ├── ActivityBar.tsx               # VS Code-style Activity Bar (Issue #727), Tooltip wrap (Issue #730)
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
