[日本語版](../../user-guide/webapp-guide.md)

# Web App Guide

This guide explains the basic operations of the CommandMate web app.
It's a step-by-step guide for first-time users.

> **For developers**: See the [UI/UX Guide](../../UI_UX_GUIDE.md) for UI implementation details.

---

## Table of Contents

1. [Launching and Accessing the App](#launching-and-accessing-the-app)
2. [Registering Repositories](#registering-repositories)
3. [Removing Repositories](#removing-repositories)
4. [Selecting a Worktree](#selecting-a-worktree)
5. [Sending Messages](#sending-messages)
6. [Auto Yes Mode](#auto-yes-mode)
7. [Viewing Chat History](#viewing-chat-history)
8. [Status Indicators](#status-indicators)
9. [Markdown Log Viewer](#markdown-log-viewer)
10. [Notes Feature](#notes-feature)
11. [Mobile Access](#mobile-access)

---

## Launching and Accessing the App

### 1. Starting the Server

#### npm Global Install (recommended)

```bash
# Start in background
commandmate start --daemon

# Check status
commandmate status

# Stop
commandmate stop
```

#### Development Environment (git clone)

```bash
cd CommandMate

# Development server
npm run dev

# Production build
npm run build
npm start
```

> **Note**: If this is your first time, run `commandmate init` for initial setup. See the [CLI Setup Guide](./cli-setup-guide.md) for details.

### 2. Accessing via Browser

Open your browser and navigate to:

```
http://localhost:3000
```

> **Port change**: Change the port with `commandmate start --port 3001` or set `CM_PORT=3001` in the `.env` file.

---

## Registering Repositories

To manage worktrees with CommandMate, you first need to register a repository.
There are two registration methods.

### Method 1: Scan from Local Path

Scan and register an existing repository on your PC.

1. Click the **"Add Repository"** button at the top right of the homepage
2. Select the **"Local Path"** tab
3. Enter the repository path (e.g., `/Users/yourname/projects/my-repo`)
4. Click **"Scan"**
5. Review the detected worktree list and click **"Register"**

### Method 2: Clone from URL

Clone and register from a remote repository like GitHub.

1. Click the **"Add Repository"** button at the top right of the homepage
2. Select the **"URL Clone"** tab
3. Enter the repository URL
   - HTTPS: `https://github.com/username/repo.git`
   - SSH: `git@github.com:username/repo.git`
4. Click **"Clone"**
5. After cloning completes, the worktree is automatically registered

> **Note**: When using SSH URLs, SSH keys must be set up.

---

## Removing Repositories

You can remove repositories that are no longer needed.

1. In the repository list on the homepage, click the **"..."** menu for the repository you want to remove
2. Select **"Delete"**
3. Type `delete` in the confirmation dialog
4. Click the **"Delete"** button

> **Warning**: Removing a repository deletes all related worktree information, notes, and history. The repository's actual files are not deleted.

---

## Selecting a Worktree

Select a worktree (branch) from registered repositories to operate on.

### Desktop

1. A list of worktrees is displayed in the left sidebar
2. Click the worktree you want to operate on
3. The detail view appears on the right

### Mobile

1. A list of worktrees is displayed on the homepage
2. Tap the worktree you want to operate on
3. Navigate to the worktree detail view

![Desktop view](../../images/screenshot-worktree-desktop.png)
*Desktop: Two-column layout*

![Mobile view](../../images/screenshot-worktree-mobile.png)
*Mobile: Tab-based layout*

---

## Sending Messages

Send messages to Claude Code to give instructions.

### How to Send

1. Select a worktree
2. Type your message in the input field at the bottom
3. Click the **"Send"** button (or press Enter)

### Responding to Claude's Confirmations

When Claude asks for yes/no or multiple-choice confirmations:

1. A confirmation dialog appears automatically
2. Click **"Yes"** or **"No"**
3. For multiple choices, click the options to respond

![Mobile Terminal](../../images/screenshot-worktree-mobile-terminal.png)
*Mobile: Sending messages in the Terminal tab*

---

## Auto Yes Mode

A mode that automatically approves Claude's confirmations.
Useful when you want to run continuous processes without interruption.

### How to Use

1. Open the worktree detail view
2. Turn on the **"Auto Yes"** toggle at the top of the screen
3. A confirmation dialog appears
4. **Select the active duration** (1 hour / 3 hours / 8 hours)
   - Default is **1 hour**
   - Select the minimum time needed for your work
5. The description text changes dynamically based on your selection (e.g., "Will automatically turn OFF after 3 hours.")
6. Click **"Agree and Enable"**

### Active Duration

| Option | Milliseconds | Intended Use Case |
|--------|-------------|-------------------|
| **1 hour** (default) | 3,600,000 | Normal development work, short tasks |
| **3 hours** | 10,800,000 | Medium-scale implementation work |
| **8 hours** | 28,800,000 | Long batch-processing tasks (regular progress checks recommended) |

A countdown timer always shows the remaining time.
- **Under 1 hour**: `MM:SS` format (e.g., `45:30`)
- **1 hour or more**: `H:MM:SS` format (e.g., `2:15:30`)

### API Specification (for developers)

The Auto-Yes activation API accepts the following parameters:

```typescript
POST /api/worktrees/:id/auto-yes

{
  "enabled": true,
  "duration": 3600000 | 10800000 | 28800000  // Optional (default: 3600000)
}
```

- **When duration is omitted**: Defaults to 1 hour (3,600,000 ms) for backward compatibility
- **Invalid duration value**: Returns 400 error
- **Security**: 5-layer defense with worktreeId format validation -> JSON parse validation -> type validation -> whitelist validation

### Important Notes

- While Auto Yes is active, all confirmations are automatically answered with "Yes"
- Important changes (file deletions, etc.) are also auto-approved, so use with caution
- You can disable it by turning off the toggle
- Auto Yes automatically turns OFF after the selected duration
- **Security best practices**:
  - Select the **minimum time** needed for your work (1 hour recommended when in doubt)
  - Limit `CM_ROOT_DIR` to the target worktree directory
  - Manually turn OFF when stepping away for extended periods, regardless of remaining time
  - See [Trust & Safety](../../TRUST_AND_SAFETY.md#auto-yes-有効時間に関するリスクと推奨事項) for details

---

## Viewing Chat History

View past message history.

### Desktop

History is displayed in the **History Pane** on the left.
- User messages and Claude's responses are shown chronologically
- Scroll to view past history

### Mobile

Tap the **"History"** tab in the tab bar at the bottom.
- View a list of past interactions
- Tap for details

---

## Status Indicators

Indicators displayed on each worktree in the sidebar show the current state.

| Display | Status | Meaning |
|---------|--------|---------|
| Grey dot | idle | No active session |
| Green dot | ready | Waiting for input (ready to send a new message) |
| Blue spinner | running | Claude is processing |
| Yellow dot | waiting | Waiting for user input (yes/no confirmations, etc.) |
| Blue spinner | generating | Generating response |

> **Details**: See [Status Indicator Details](../../features/sidebar-status-indicator.md) for how status detection works.

---

## Markdown Log Viewer

View Claude's detailed output in Markdown format.

### Mobile

1. Tap the **"Logs"** tab in the tab bar at the bottom
2. Tap a log file from the list
3. View the content rendered in Markdown format

### Desktop

1. Click the **"Info"** button to open the modal
2. Select a log file from the list to view

---

## Notes Feature

Save notes for each worktree.
Useful for recording work details and TODOs.

### Editing Notes

#### Desktop

1. Click the **"Info"** button at the top right
2. Edit in the **"Notes"** section in the modal
3. Content is auto-saved

#### Mobile

1. Tap the **"Info"** tab in the tab bar at the bottom
2. Edit in the **"Notes"** section
3. Content is auto-saved

---

## Mobile Access

How to access CommandMate from your smartphone.

### Same LAN Access

1. Connect your PC and smartphone to the same Wi-Fi
2. Edit the `.env` file:
   ```
   CM_BIND=0.0.0.0
   ```
3. Restart the server
4. Open `http://<your PC's IP address>:3000` in your smartphone's browser

> **Note**: We recommend authentication via a reverse proxy for external network access. See the [Security Guide](../../security-guide.md) for details.

### Finding Your PC's IP Address

```bash
# macOS
ifconfig | grep "inet " | grep -v 127.0.0.1

# Linux
ip addr | grep "inet " | grep -v 127.0.0.1
```

### Remote Access

Use tunneling services like Cloudflare Tunnel to access from outside your home.
See the [Deployment Guide](../../DEPLOYMENT.md) for details.

### Mobile UI

On mobile, a tab bar is displayed at the bottom:

| Tab | Content |
|-----|---------|
| **Terminal** | Real-time output + message input |
| **History** | Chat history |
| **Logs** | Markdown log list |
| **Info** | Worktree information + notes |

![Mobile view](../../images/screenshot-mobile.png)
*Mobile: Homepage*

---

## Related Documentation

- [CLI Setup Guide](./cli-setup-guide.md) - Installation and initial setup
- [UI/UX Guide](../../UI_UX_GUIDE.md) - UI implementation technical details
- [Status Indicator Details](../../features/sidebar-status-indicator.md) - How status detection works
- [Deployment Guide](../../DEPLOYMENT.md) - Production environment setup
- [Concept](../../concept.md) - CommandMate's vision
